// Custom video player (PRD §11.3): native <video>, home-made control bar,
// mobile-style touch zones, keyboard shortcuts, next-episode chaining and
// per-browser resume positions (localStorage). Fullscreen goes on the
// container, never on <video>, or the custom bar disappears (§13). Always
// try the native Fullscreen API first (Android Chrome can then hide the
// browser chrome). CSS overlay is the fallback when native rejects, is
// missing, or is a no-op. CSS landscape rotate is overlay + portrait +
// phone only — never rotate native fullscreen, and never rotate a
// tall/narrow desktop window. Cast uses the W3C Remote Playback API on
// video.remote (prompt / watchAvailability / statechange); no Cast SDK.
// Offer cast only for a normal src URL (progressive / native HLS). Never
// on the hls.js MSE/blob path.
// Do not add is-fullscreen until native lands or overlay fallback applies:
// the class sets aspect-ratio:auto; height:100% without position:fixed and
// would collapse the player for ~400ms on no-op phones.
// Episode hops destroy+remount the player (hash router). Snapshot wantFull
// so the next mount can re-enter native FS or keep overlay classes; cleanup
// must not exitFull() on that path or the hop drops the user out of FS.

const POS_PREFIX = 'sanem-pos:';
const WATCHED_PREFIX = 'sanem-watched:';
const DONE_PREFIX = 'sanem-done:';
// Past this fraction of the duration the media counts as finished: the resume
// position is dropped and a persistent "done" marker takes its place.
export const DONE_RATIO = 0.95;
const VOLUME_KEY = 'sanem-volume';
const MUTED_KEY = 'sanem-muted';
const BAR_HIDE_MS = 2000;
// "Épisode suivant" label: offered for the last 2 minutes so the viewer can
// skip the outro at will (PRD §10.7 also auto-chains on ended).
export const NEXT_UP_LEAD_S = 120;
// The episode number is a bearing, not a HUD: it fades out on its own.
export const EPISODE_BADGE_MS = 5000;
// Distinguish center single-tap pause from double-tap fullscreen.
export const CENTER_DBLCLICK_MS = 300;

// Hash teardown recreates the player. Carry FS intent across that remount
// so next/prev (and ended auto-chain) stay in fullscreen. Overlay is
// restored immediately; native is re-requested on the new container.
let keepFullAcrossMount = null;

function snapshotKeepFull(wantFull, container) {
  if (!wantFull && !container.classList.contains('is-fullscreen')) return null;
  return { overlay: container.classList.contains('is-fake-fullscreen') };
}

function consumeKeepFull() {
  const snap = keepFullAcrossMount;
  keepFullAcrossMount = null;
  return snap;
}

// Episode label from a release-style filename ("…S04E14…" -> "Épisode 14").
// Falls back to the bare filename when no marker is found, so neither the rail
// nor the player badge ever shows an empty title.
export function episodeLabel(file) {
  const m = /(?:^|[^a-z0-9])(?:s\d{1,2})?e(\d{1,3})(?:[^0-9]|$)/i.exec(file.name);
  return m ? `Épisode ${Number(m[1])}` : file.name;
}

export function shouldShowNextEpisode(next, duration, currentTime) {
  if (!next) return false;
  if (!Number.isFinite(duration) || duration <= NEXT_UP_LEAD_S) return false;
  const t = Number.isFinite(currentTime) ? currentTime : 0;
  return duration - t <= NEXT_UP_LEAD_S;
}

// Same collator as GET /api/files and the Lukluk catalog: locale-aware and
// numeric, so S01E09 sorts before S01E10. This IS the episode playback order
// (PRD §10.7). A file with no dir (uploads/ root) has neither sibling.
const episodeCollator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

export function seriesSiblings(file, files) {
  if (!file?.dir || !Array.isArray(files)) return { prev: null, next: null };
  const siblings = files
    .filter((f) => f.dir === file.dir)
    .sort((a, b) => episodeCollator.compare(a.path, b.path));
  const idx = siblings.findIndex((f) => f.path === file.path);
  if (idx < 0) return { prev: null, next: null };
  return {
    prev: idx > 0 ? siblings[idx - 1] : null,
    next: idx < siblings.length - 1 ? siblings[idx + 1] : null,
  };
}

// Extracted so the 5 s hide can be asserted with fake timers without Chrome.
export function scheduleBadgeHide(badge, delay = EPISODE_BADGE_MS) {
  return setTimeout(() => {
    badge.classList.add('is-gone');
  }, delay);
}

function decodeCastSegment(seg) {
  let cur = seg;
  for (let i = 0; i < 4; i += 1) {
    let next;
    try {
      next = decodeURIComponent(cur.replace(/\+/g, ' '));
    } catch {
      return null;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

// Cast fling src must stay a same-origin relative /api/media|hls path with
// exp+sig. Reject absolute, protocol-relative, `.`/`..` (including %2e),
// empty segments, and missing query tokens.
export function isAllowedCastSrc(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return false;
  const hashAt = url.indexOf('#');
  const cut = hashAt === -1 ? url : url.slice(0, hashAt);
  const qAt = cut.indexOf('?');
  const path = qAt === -1 ? cut : cut.slice(0, qAt);
  const query = qAt === -1 ? '' : cut.slice(qAt + 1);
  if (!/^\/api\/(media|hls)\//.test(path)) return false;
  const parts = path.split('/');
  if (parts.length < 4 || parts[0] !== '') return false;
  for (let i = 1; i < parts.length; i += 1) {
    const raw = parts[i];
    if (!raw) return false;
    const decoded = decodeCastSegment(raw);
    if (decoded == null || decoded === '' || decoded === '.' || decoded === '..') return false;
    if (decoded.includes('/') || decoded.includes('\\')) return false;
  }
  const params = new URLSearchParams(query);
  return Boolean(params.get('exp') && params.get('sig'));
}

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
};

export function loadPosition(path) {
  const v = Number(localStorage.getItem(POS_PREFIX + path));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
// Epoch ms of the last playback activity on this media, or 0. Only kept while
// the media is still in progress (cleared together with the resume position
// once it is finished), so it doubles as a "watched but not finished" marker.
export function loadWatchedAt(path) {
  const v = Number(localStorage.getItem(WATCHED_PREFIX + path));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
// Epoch ms at which this media was watched through to the end, or 0. Survives
// the resume position being cleared, so the library can tell "finished" apart
// from "never started" - both have no resume position (PRD §10.8).
export function loadDoneAt(path) {
  const v = Number(localStorage.getItem(DONE_PREFIX + path));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
// Three-state playback status of one media, derived from what is persisted.
export function watchState(path) {
  if (loadPosition(path) > 0) return 'in-progress';
  return loadDoneAt(path) > 0 ? 'done' : 'unseen';
}
export function markDone(path) {
  localStorage.setItem(DONE_PREFIX + path, String(Date.now()));
}
function savePosition(path, seconds, duration) {
  if (duration && seconds / duration > DONE_RATIO) {
    clearPosition(path);
    markDone(path);
  } else if (seconds > 3) {
    localStorage.setItem(POS_PREFIX + path, String(Math.floor(seconds)));
    localStorage.setItem(WATCHED_PREFIX + path, String(Date.now()));
  }
}
export function clearPosition(path) {
  localStorage.removeItem(POS_PREFIX + path);
  localStorage.removeItem(WATCHED_PREFIX + path);
}

// Icons come from the #i-* sprite in index.html: one stroked 24x24 family shared
// by the shell and the player, recoloured through currentColor.
function icon(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

function setIcon(host, id) {
  const use = host.querySelector('use');
  if (use) use.setAttribute('href', `#${id}`);
}

function nameControl(btn, label) {
  // CSS .has-tip paints from aria-label. Native title= would double the tip.
  btn.setAttribute('aria-label', label);
}

function el(tag, cls, attrs = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Chromecast/AirPlay-class glyph: a screen rectangle plus wireless arcs.
function castIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'currentColor');
  const add = (d) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  };
  add(
    'M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z'
  );
  add(
    'M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z'
  );
  return svg;
}

function hasRemotePrompt(remote) {
  return Boolean(remote && typeof remote.prompt === 'function');
}

/**
 * Mounts a player into `root`. Returns { destroy }.
 * @param {object} opts
 * @param {object} opts.file    - the media item ({ path, name, playback, duration, ... }).
 * @param {function} opts.onNext - navigate to a file, or null to leave the series.
 * @param {object|null} opts.next - the next episode file (same folder), or null.
 * @param {object|null} opts.prev - the previous episode file (same folder), or null.
 */
export function mountPlayer(root, { file, next, prev, onNext }) {
  const resumeFull = consumeKeepFull();
  root.textContent = '';

  const container = el('div', 'player-container');
  const video = el('video', 'player-video', { playsinline: '', preload: 'metadata' });
  const touch = el('div', 'player-touch');
  const thirdL = el('div', 'touch-third touch-left');
  const thirdC = el('div', 'touch-third touch-center');
  const thirdR = el('div', 'touch-third touch-right');
  touch.append(thirdL, thirdC, thirdR);
  const seekHint = el('div', 'seek-hint', { hidden: '' });
  const centerPlay = el('button', 'center-play', {
    type: 'button',
    'aria-label': 'Lire',
  });
  centerPlay.appendChild(icon('i-play'));

  const bar = el('div', 'control-bar');

  const progress = el('div', 'progress', { role: 'slider', 'aria-label': 'Progression', tabindex: '0' });
  const progBuffer = el('div', 'progress-buffer');
  const progPlayed = el('div', 'progress-played');
  const progHandle = el('div', 'progress-handle');
  progress.append(progBuffer, progPlayed, progHandle);

  const time = el('span', 'time-display');
  time.textContent = '0:00 / 0:00';

  const btnMute = el('button', 'ctl', { type: 'button', 'aria-label': 'Couper le son' });
  btnMute.appendChild(icon('i-volume'));
  const volume = el('input', 'volume', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Volume' });

  const btnPrev = el('button', 'ctl ctl-prev has-tip', { type: 'button' });
  btnPrev.appendChild(icon('i-prev'));
  nameControl(btnPrev, 'Épisode précédent');
  btnPrev.hidden = !prev;

  const btnNext = el('button', 'ctl ctl-next has-tip', { type: 'button' });
  btnNext.appendChild(icon('i-next'));
  nameControl(btnNext, 'Épisode suivant');
  btnNext.hidden = !next;

  const btnFull = el('button', 'ctl ctl-fs has-tip', { type: 'button' });
  btnFull.appendChild(icon('i-fullscreen'));
  nameControl(btnFull, 'Plein écran');

  const btnCast = el('button', 'ctl cast-btn', {
    type: 'button',
    'aria-label': 'Diffuser sur un écran',
    title: 'Diffuser sur un écran',
    hidden: '',
    'aria-pressed': 'false',
  });
  btnCast.appendChild(castIcon());

  // Play/pause is the named Netflix-style center button, not a toolbar control.
  bar.append(progress, time, btnMute, volume, btnPrev, btnNext, btnFull);

  const nextOverlay = el('div', 'next-overlay', { hidden: '' });
  const prevBtnOverlay = el('button', 'prev-up-btn has-tip', { type: 'button' });
  prevBtnOverlay.appendChild(icon('i-prev'));
  nameControl(prevBtnOverlay, 'Épisode précédent');
  prevBtnOverlay.hidden = !prev;
  const nextBtnOverlay = el('button', 'next-up-btn has-tip', { type: 'button' });
  const nextUpLabel = el('span', 'next-up-label');
  nextOverlay.append(prevBtnOverlay, nextBtnOverlay);

  // Which episode am I on? Shown bare over the picture for the first seconds,
  // then gone - auto-chaining otherwise drops the viewer with no bearing.
  const badge = el('div', 'episode-badge');
  badge.textContent = episodeLabel(file);

  container.append(video, touch, centerPlay, seekHint, badge, nextOverlay, bar, btnCast);
  root.appendChild(container);

  // --- source wiring ---
  let hls = null;
  const mediaUrl = `/api/media/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  const hlsUrl = `/api/hls/${file.path.split('/').map(encodeURIComponent).join('/')}/index.m3u8`;

  if (file.playback === 'direct') {
    video.src = mediaUrl;
  } else if (file.playback === 'hls') {
    const canNative = video.canPlayType('application/vnd.apple.mpegurl');
    if (canNative) {
      video.src = hlsUrl;
    } else if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: true });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
    } else {
      video.src = mediaUrl; // last resort
    }
  }
  // Remote Playback needs a fetchable src URL. hls.js attachMedia drives MSE
  // (blob:/MediaSource) which Chromecast/AirPlay cannot play; never offer it.
  const mseHls = Boolean(hls);

  // --- restore volume / position ---
  const savedVol = Number(localStorage.getItem(VOLUME_KEY));
  video.volume = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 1;
  video.muted = localStorage.getItem(MUTED_KEY) === '1';
  volume.value = String(video.muted ? 0 : video.volume);

  const resumeAt = loadPosition(file.path);
  let resumeApplied = false;
  let pendingSeek = null;
  let pendingPlay = false;
  const cookieSrc = video.getAttribute('src') || '';
  const offerNextUp = () => {
    // Series-end overlay stays until the user leaves. Do not hide it when a
    // later seek/timeupdate falls outside the next-up window.
    if (nextOverlay.classList.contains('is-end')) return;
    nextOverlay.hidden = !shouldShowNextEpisode(
      next,
      video.duration || file.duration || 0,
      video.currentTime || 0
    );
  };
  video.addEventListener('loadedmetadata', () => {
    const fromPending = pendingSeek;
    pendingSeek = null;
    if (fromPending != null && fromPending > 0 && fromPending < (video.duration || Infinity)) {
      video.currentTime = fromPending;
    } else if (!resumeApplied && resumeAt > 0 && resumeAt < (video.duration || Infinity) - 5) {
      // pendingSeek 0 (or null) before the first resume must not skip loadPosition.
      video.currentTime = resumeAt;
    }
    resumeApplied = true;
    if (pendingPlay) {
      pendingPlay = false;
      video.play().catch(() => {});
    }
    render();
    offerNextUp();
  });

  // --- rendering ---
  let holdSeeking = false;
  function render() {
    const d = video.duration || file.duration || 0;
    const c = video.currentTime || 0;
    progPlayed.style.width = d ? `${(c / d) * 100}%` : '0%';
    progHandle.style.left = d ? `${(c / d) * 100}%` : '0%';
    if (video.buffered.length) {
      const bEnd = video.buffered.end(video.buffered.length - 1);
      progBuffer.style.width = d ? `${(bEnd / d) * 100}%` : '0%';
    }
    time.textContent = `${fmtTime(c)} / ${fmtTime(d)}`;
    setIcon(btnMute, video.muted || video.volume === 0 ? 'i-mute' : 'i-volume');
    const atEnd = !nextOverlay.hidden && nextOverlay.classList.contains('is-end');
    centerPlay.hidden = !video.paused || atEnd || holdSeeking;
    centerPlay.setAttribute('aria-label', video.paused ? 'Lire' : 'Pause');
  }

  let hideTimer = null;
  let pointerInChrome = false;
  const chromeActivePointers = new Set();
  const hoverHoldChrome = (node) =>
    window.matchMedia('(hover: hover)').matches &&
    window.matchMedia('(pointer: fine)').matches &&
    node.matches(':hover');
  // Mouse/pen hover or an active pointer on overlay chrome holds
  // controls-visible so the 2s timer cannot hide it under the cursor/finger.
  const chromeHoldsVisible = () =>
    pointerInChrome ||
    hoverHoldChrome(bar) ||
    hoverHoldChrome(btnCast) ||
    chromeActivePointers.size > 0 ||
    (document.activeElement != null &&
      (bar.contains(document.activeElement) || btnCast.contains(document.activeElement)));
  const hideBar = () => {
    if (chromeHoldsVisible()) {
      // Keep re-arming so a hold that later releases (blur, pointerup)
      // still hides even if focusout/pointerleave did not restart showBar.
      clearTimeout(hideTimer);
      hideTimer = video.paused ? null : setTimeout(hideBar, BAR_HIDE_MS);
      return;
    }
    container.classList.remove('controls-visible');
    clearTimeout(hideTimer);
    hideTimer = null;
    bar.inert = true;
    btnCast.inert = true;
    // inert drops focus and tab order. Do not blur here: chromeHoldsVisible
    // already keeps the bar up while it contains document.activeElement.
  };
  const showBar = () => {
    bar.inert = false;
    btnCast.inert = false;
    container.classList.add('controls-visible');
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!video.paused) {
      hideTimer = setTimeout(hideBar, BAR_HIDE_MS);
    }
  };

  video.addEventListener('timeupdate', () => {
    render();
    savePosition(file.path, video.currentTime, video.duration);
    offerNextUp();
  });
  video.addEventListener('seeked', offerNextUp);
  video.addEventListener('progress', render);
  video.addEventListener('play', () => {
    render();
    showBar();
  });
  video.addEventListener('pause', () => {
    render();
    showBar();
  });
  video.addEventListener('volumechange', render);
  video.addEventListener('ended', () => {
    clearPosition(file.path);
    markDone(file.path);
    if (next) {
      // Existing product rule (PRD §10.7): chain to the next episode on ended.
      nextOverlay.hidden = false;
      goNext();
    } else {
      nextOverlay.hidden = false;
      nextOverlay.classList.add('is-end');
      prevBtnOverlay.hidden = true;
      render();
    }
  });

  // --- controls ---
  const atSeriesEnd = () => !nextOverlay.hidden && nextOverlay.classList.contains('is-end');
  const togglePlay = () => {
    if (atSeriesEnd()) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };
  centerPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });
  centerPlay.addEventListener('pointerdown', (e) => e.stopPropagation());
  centerPlay.addEventListener('pointerup', (e) => e.stopPropagation());
  centerPlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    togglePlay();
  });
  const seekBy = (delta) => {
    const d = video.duration || file.duration || 0;
    let t = Math.max(0, video.currentTime + delta);
    if (d) t = Math.min(t, d);
    video.currentTime = t;
  };
  let gone = false;
  let keepFullOnCleanup = false;
  const goTo = (target) => {
    if (gone) return;
    gone = true;
    // Another episode keeps FS; leaving the series (target null) still exits.
    keepFullOnCleanup = Boolean(target);
    cleanup();
    onNext(target);
  };
  const goNext = () => goTo(next || null);
  const goPrev = () => {
    if (!prev) return;
    goTo(prev);
  };

  btnPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    goPrev();
  });
  btnNext.addEventListener('click', (e) => {
    e.stopPropagation();
    goNext();
  });

  if (next) {
    nextBtnOverlay.replaceChildren(icon('i-next'));
    nextBtnOverlay.classList.add('has-tip');
    nameControl(nextBtnOverlay, 'Épisode suivant');
  } else {
    nextBtnOverlay.replaceChildren(nextUpLabel);
    nextBtnOverlay.classList.remove('has-tip');
    nextUpLabel.textContent = 'Revenir à la série';
    nextBtnOverlay.setAttribute('aria-label', 'Revenir à la série');
  }
  nextBtnOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    goNext();
  });
  prevBtnOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    goPrev();
  });

  // Badge lifetime: 5 s of picture. The countdown restarts on the first
  // `playing` so a blocked autoplay does not burn it against a frozen frame,
  // but the mount timer still guarantees it goes away on its own.
  let badgeTimer = null;
  const hideBadgeIn = (ms) => {
    clearTimeout(badgeTimer);
    badgeTimer = scheduleBadgeHide(badge, ms);
  };
  hideBadgeIn(EPISODE_BADGE_MS);
  video.addEventListener(
    'playing',
    () => {
      if (!badge.classList.contains('is-gone')) hideBadgeIn(EPISODE_BADGE_MS);
    },
    { once: true }
  );
  // Keep the chip clickable while the toolbar auto-hides (it is not inside the bar).
  nextOverlay.addEventListener('pointerdown', (e) => e.stopPropagation());
  nextOverlay.addEventListener('pointerup', (e) => e.stopPropagation());

  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    localStorage.setItem(MUTED_KEY, video.muted ? '1' : '0');
  });
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    localStorage.setItem(VOLUME_KEY, volume.value);
    localStorage.setItem(MUTED_KEY, video.muted ? '1' : '0');
  });
  // --- remote playback (W3C RemotePlayback on HTMLVideoElement.remote) ---
  // Chromecast / AirPlay-class devices via the UA picker. No Cast SDK, no
  // Presentation API. Firefox and other UAs without `remote` hide the button.
  // Captain B: only when the <video> has a normal src URL (direct or native
  // HLS). hls.js MSE/blob never gets a cast control.
  let remoteWatchId = null;
  let remoteWatchPending = null;
  let lastAvailable = false;
  let castAlive = true;
  let remoteCancelRequested = false;
  let castSrcActive = false;
  let castUrlCache = null;
  const remote = !mseHls && hasRemotePrompt(video.remote) ? video.remote : null;
  const isCastLive = () =>
    Boolean(remote && (remote.state === 'connected' || remote.state === 'connecting'));
  const stopRemotePlayback = () => {
    if (remoteCancelRequested || !remote) return;
    if (remote.state !== 'connected' && remote.state !== 'connecting') return;
    remoteCancelRequested = true;
    try {
      Promise.resolve(remote.cancel()).catch(() => {});
    } catch {
      // Some UAs have no cancel(); teardown must still clear src.
    }
  };
  const restoreCookieSrc = () => {
    if (!castSrcActive) return;
    castSrcActive = false;
    if (!cookieSrc) return;
    if ((video.getAttribute('src') || '') === cookieSrc) return;
    // applySignedSrc already captured seek/play. Assigning video.src resets
    // currentTime to 0 before metadata; overwriting here would jump to the
    // start on a fast picker cancel. Resample only after loadedmetadata
    // consumed that capture (pendingSeek is then null).
    if (pendingSeek == null) {
      pendingSeek = video.currentTime || 0;
      pendingPlay = !video.paused;
    }
    video.src = cookieSrc;
  };
  const promptRemote = () => {
    if (!hasRemotePrompt(video.remote)) return Promise.resolve();
    return Promise.resolve(video.remote.prompt()).then(
      () => {
        // Some UAs fulfill prompt() on picker dismiss and never fire
        // statechange. If we are still not connecting/connected, put the
        // cookie-gated src back immediately.
        if (castAlive && !isCastLive()) restoreCookieSrc();
      },
      () => {
        // Picker cancel/reject: restore only when not connecting/connected.
        // Click-while-live also uses prompt(); a reject must not yank src
        // off an active session.
        if (castAlive && !isCastLive()) restoreCookieSrc();
      }
    );
  };
  const beginCastWithUrl = (url) => {
    if (!url || !castAlive || mseHls) return Promise.resolve();
    if (!isAllowedCastSrc(url)) return Promise.resolve();
    applySignedSrc(url);
    return promptRemote();
  };
  const applySignedSrc = (url) => {
    if (!isAllowedCastSrc(url)) return;
    if ((video.getAttribute('src') || '') === url) {
      castSrcActive = true;
      return;
    }
    pendingSeek = video.currentTime || 0;
    pendingPlay = !video.paused;
    video.src = url;
    castSrcActive = true;
  };
  const refreshCastUrl = () => {
    if (!castAlive || mseHls || !cookieSrc) {
      castUrlCache = null;
      btnCast.removeAttribute('data-cast-ready');
      return Promise.resolve(null);
    }
    const kind = cookieSrc.includes('/api/hls/') ? 'hls' : 'media';
    const pathEnc = file.path.split('/').map(encodeURIComponent).join('/');
    return fetch(`/api/cast-url/${pathEnc}?kind=${kind}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('cast-url failed'))))
      .then((body) => {
        if (!castAlive) return null;
        if (!body?.url || !body.exp) throw new Error('cast-url missing');
        if (!isAllowedCastSrc(body.url)) throw new Error('cast-url rejected');
        castUrlCache = { url: body.url, exp: Number(body.exp) };
        btnCast.setAttribute('data-cast-ready', '1');
        return castUrlCache.url;
      })
      .catch(() => {
        if (!castAlive) return null;
        castUrlCache = null;
        btnCast.removeAttribute('data-cast-ready');
        return null;
      });
  };
  // One helper for statechange and availability: stay visible while live,
  // otherwise honor the last watchAvailability result (hide when no devices).
  const syncCastUi = () => {
    if (!castAlive) return;
    if (mseHls || !remote) {
      btnCast.hidden = true;
      btnCast.classList.remove('is-casting');
      btnCast.setAttribute('aria-pressed', 'false');
      return;
    }
    const live = isCastLive();
    btnCast.classList.toggle('is-casting', live);
    btnCast.setAttribute('aria-pressed', live ? 'true' : 'false');
    btnCast.hidden = !(lastAvailable || live);
  };
  const applyCastAvailability = (available) => {
    if (!castAlive || mseHls) return;
    lastAvailable = Boolean(available);
    syncCastUi();
    if (available) refreshCastUrl();
  };
  const onRemoteState = () => {
    syncCastUi();
    if (!isCastLive()) restoreCookieSrc();
  };
  if (remote) {
    remote.addEventListener('statechange', onRemoteState);
    syncCastUi();
    if (typeof remote.watchAvailability === 'function') {
      remoteWatchPending = Promise.resolve()
        .then(() => remote.watchAvailability(applyCastAvailability))
        .then((id) => {
          remoteWatchId = id;
          return id;
        })
        .catch(() => {
          if (!castAlive || mseHls) return;
          // UA cannot monitor devices in the background (W3C): still offer
          // prompt() so the picker can discover them on a user gesture.
          applyCastAvailability(true);
        });
    } else {
      applyCastAvailability(true);
    }
  } else {
    btnCast.hidden = true;
  }
  btnCast.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!castAlive || mseHls) return;
    if (!hasRemotePrompt(video.remote)) return;
    if (isCastLive()) {
      promptRemote();
      return;
    }
    // Always mint on the user gesture so a hours-old prefetch cannot start
    // a session with ~1 minute of signature life left (HLS segs would 401).
    refreshCastUrl().then((url) => {
      if (!url || !castAlive) return;
      return beginCastWithUrl(url);
    });
  });

  // --- progress bar scrubbing ---
  const scrubTo = (clientX) => {
    const rect = progress.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const d = video.duration || file.duration || 0;
    if (d) video.currentTime = ratio * d;
  };
  let scrubbing = false;
  progress.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    progress.setPointerCapture(e.pointerId);
    scrubTo(e.clientX);
  });
  progress.addEventListener('pointermove', (e) => {
    if (!scrubbing) return;
    showBar();
    scrubTo(e.clientX);
  });
  progress.addEventListener('pointerup', (e) => {
    scrubbing = false;
    progress.releasePointerCapture(e.pointerId);
  });
  progress.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    seekBy(e.key === 'ArrowLeft' ? -10 : 10);
    showBar();
  });

  // --- fullscreen (on the container, never <video>) ---
  // Native first, including on phones. Overlay if the API rejects, is
  // missing, or resolves without actually fullscreening the container
  // (common no-op on iOS). Forced landscape is fake-fs + portrait + phone
  // (coarse pointer) only — never rotate native fullscreen, and never
  // rotate a tall/narrow desktop window.
  const nativeFsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const requestNativeFs = (node) => {
    const fn = node.requestFullscreen || node.webkitRequestFullscreen;
    if (!fn) return Promise.reject(new Error('fullscreen unsupported'));
    try {
      return Promise.resolve(fn.call(node));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const exitNativeFs = () => {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn || !nativeFsEl()) return Promise.resolve();
    try {
      return Promise.resolve(fn.call(document));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const isPortrait = () => window.matchMedia('(orientation: portrait)').matches;
  const isPhone = () => window.matchMedia('(pointer: coarse)').matches;
  const tryLockLandscape = () => {
    if (!isPhone()) return Promise.resolve();
    const lock = screen.orientation?.lock?.('landscape');
    return lock ? Promise.resolve(lock).catch(() => {}) : Promise.resolve();
  };

  const setFsControl = (exiting) => {
    nameControl(btnFull, exiting ? 'Quitter le plein écran' : 'Plein écran');
    setIcon(btnFull, exiting ? 'i-exit-fullscreen' : 'i-fullscreen');
  };

  // wantFull tracks the user's intent. Native requestFullscreen cannot be
  // aborted, so a late webkit assignment after exit must call exitNativeFs
  // instead of resurrecting player-fs. Overlay is a fallback on any native
  // failure; CSS rotate stays phone-only.
  let wantFull = false;
  let waitingNativeFs = false;
  let sawNativeFs = false;
  // True once fullscreenElement is observed as the container during this
  // wait (call return, change event, watch, or rAF) — not only the tick
  // requestFullscreen() comes back. Distinguishes a short-lived native
  // enter-then-leave from empty prefixed events before webkit assigns.
  let nativeElOnRequest = false;
  let nativeGraceTimer = 0;
  let nativeWatchTimer = 0;
  let nativeSampleRaf = 0;
  // True while exitFullscreen is in flight under overlay. Real exit is async,
  // so the watch must not re-call it, and overlay rotate must stay put.
  let exitingNativeUnderOverlay = false;
  // Bumped on every enter/exit so in-flight request/grace/leave from a
  // previous session cannot adopt leftover native or abort a new wait.
  let fsGen = 0;
  let leftoverNative = false;
  let leftoverWaitTimer = 0;
  const NATIVE_FS_GRACE_MS = 400;
  const OVERLAY_SILENT_WATCH_MS = 1600;
  const LEFTOVER_NATIVE_WAIT_MS = 400;

  const stopNativeGrace = () => {
    waitingNativeFs = false;
    if (nativeGraceTimer) {
      clearTimeout(nativeGraceTimer);
      nativeGraceTimer = 0;
    }
    stopLeftoverWait();
    stopNativeSample();
  };
  const stopLeftoverWait = () => {
    if (leftoverWaitTimer) {
      clearTimeout(leftoverWaitTimer);
      leftoverWaitTimer = 0;
    }
  };
  const stopNativeWatch = () => {
    if (nativeWatchTimer) {
      clearInterval(nativeWatchTimer);
      nativeWatchTimer = 0;
    }
    stopNativeSample();
  };
  const stopNativeSample = () => {
    if (nativeSampleRaf) {
      window.cancelAnimationFrame(nativeSampleRaf);
      nativeSampleRaf = 0;
    }
  };
  const noteNativeAssigned = () => {
    if (leftoverNative) return;
    if (nativeFsEl() === container) nativeElOnRequest = true;
  };
  const pumpNativeSample = () => {
    nativeSampleRaf = 0;
    if (!waitingNativeFs) return;
    if (leftoverNative) {
      if (nativeFsEl() !== container) resumeNativeAfterLeftover();
      else nativeSampleRaf = window.requestAnimationFrame(pumpNativeSample);
      return;
    }
    noteNativeAssigned();
    if (adoptNativeSuccess()) return;
    nativeSampleRaf = window.requestAnimationFrame(pumpNativeSample);
  };

  const syncForcedLandscape = () => {
    const native = nativeFsEl() === container;
    const overlay = container.classList.contains('is-fake-fullscreen');
    // Overlay already applied: keep it even if native assigns later.
    if (native && wantFull && !overlay) container.classList.remove('is-fake-fullscreen');
    const fake = wantFull && overlay;
    // Overlay-only rotate stays on while a dismissed native is still
    // exiting (exitFullscreen is async). Dropping is-forced-landscape for
    // native && overlay flashes rotate/chrome, then restores it.
    const rotate = fake && isPortrait() && isPhone();
    if (!rotate) container.classList.remove('is-forced-landscape');
    container.classList.toggle('is-forced-landscape', rotate);
    document.documentElement.classList.toggle(
      'player-fs',
      wantFull && (container.classList.contains('is-fullscreen') || native)
    );
  };

  const dismissNativeUnderOverlay = () => {
    if (!wantFull || !container.classList.contains('is-fake-fullscreen')) return false;
    if (nativeFsEl() !== container) return false;
    if (exitingNativeUnderOverlay) return true;
    exitingNativeUnderOverlay = true;
    // Call exit once. The wait-watch is already stopped when overlay
    // applies; the overlay dismiss watch must not re-enter exitFullscreen
    // while the async exit is in flight.
    exitNativeFs()
      .catch(() => {})
      .finally(() => {
        exitingNativeUnderOverlay = false;
      });
    return true;
  };

  const startOverlayDismissWatch = () => {
    stopNativeWatch();
    const watchUntil = Date.now() + OVERLAY_SILENT_WATCH_MS;
    const tick = () => {
      if (!wantFull || !container.classList.contains('is-fake-fullscreen')) {
        stopNativeWatch();
        return;
      }
      noteNativeAssigned();
      dismissNativeUnderOverlay();
      if (Date.now() >= watchUntil) stopNativeWatch();
    };
    // Dismiss immediately: a 50ms interval-only first tick leaves live
    // leftover native under overlay rotate for one frame.
    tick();
    nativeWatchTimer = setInterval(tick, 50);
  };

  // Native wins during the wait. Once overlay fallback has been applied,
  // stay overlay — cancel a late native assignment instead of snapping.
  const adoptNativeSuccess = () => {
    if (dismissNativeUnderOverlay()) return false;
    if (leftoverNative) return false;
    if (nativeFsEl() !== container) return false;
    nativeElOnRequest = true;
    sawNativeFs = true;
    stopNativeGrace();
    stopNativeWatch();
    if (!wantFull) {
      exitNativeFs().catch(() => {});
      syncForcedLandscape();
      return true;
    }
    container.classList.add('is-fullscreen');
    container.classList.remove('is-fake-fullscreen', 'is-forced-landscape');
    setFsControl(true);
    document.documentElement.classList.add('player-fs');
    tryLockLandscape();
    syncForcedLandscape();
    return true;
  };

  const applyOverlayFallback = () => {
    if (adoptNativeSuccess()) return;
    if (!wantFull) return;
    // Native was entered then left (system UI / back): never cover with overlay.
    if (sawNativeFs) {
      exitFull();
      return;
    }
    stopNativeGrace();
    container.classList.add('is-fullscreen', 'is-fake-fullscreen');
    document.documentElement.classList.add('player-fs');
    setFsControl(true);
    tryLockLandscape();
    // Overlay watch dismisses silent late native for a bounded window after
    // grace (fullscreenchange still dismisses after that). Wait-phase
    // sampling is rAF until the 400ms grace.
    startOverlayDismissWatch();
    syncForcedLandscape();
  };

  const isFull = () =>
    container.classList.contains('is-fullscreen') ||
    (wantFull && !leftoverNative && nativeFsEl() === container);

  // webkitRequestFullscreen returns void; the element and webkitfullscreenchange
  // often land a tick later. rAF samples until the 400ms grace, then overlay.
  // Overlay then has a bounded dismiss sampler for silent late native (no adopt).
  const resumeNativeAfterLeftover = () => {
    if (!leftoverNative) return;
    leftoverNative = false;
    nativeElOnRequest = false;
    stopLeftoverWait();
    if (!wantFull || !waitingNativeFs) return;
    if (container.classList.contains('is-fake-fullscreen')) return;
    // Leftover wait used Quitter (second ⛶/F exits). Grace wait is not
    // full yet — restore Plein écran so a tap does not look like exit.
    setFsControl(false);
    // Previous requestFullscreen often no-ops while leftover native is still
    // assigned. Re-request and restart grace after that exit actually lands.
    armNativeWait();
  };

  const armNativeWait = () => {
    const gen = fsGen;
    waitingNativeFs = true;
    nativeElOnRequest = false;
    if (nativeGraceTimer) {
      clearTimeout(nativeGraceTimer);
      nativeGraceTimer = 0;
    }
    stopNativeSample();
    nativeGraceTimer = setTimeout(() => {
      nativeGraceTimer = 0;
      if (gen !== fsGen) return;
      if (adoptNativeSuccess()) return;
      applyOverlayFallback();
    }, NATIVE_FS_GRACE_MS);
    requestNativeFs(container)
      .then(() => {
        if (gen !== fsGen || leftoverNative) return;
        noteNativeAssigned();
        if (nativeFsEl() === container) adoptNativeSuccess();
        else if (waitingNativeFs && nativeElOnRequest && !sawNativeFs) exitFull();
      })
      .catch(() => {
        if (gen !== fsGen || leftoverNative) return;
        applyOverlayFallback();
      });
    noteNativeAssigned();
    pumpNativeSample();
  };

  const exitFull = () => {
    fsGen += 1;
    leftoverNative = false;
    wantFull = false;
    sawNativeFs = false;
    nativeElOnRequest = false;
    exitingNativeUnderOverlay = false;
    stopNativeGrace();
    stopNativeWatch();
    container.classList.remove('is-fullscreen', 'is-fake-fullscreen', 'is-forced-landscape');
    document.documentElement.classList.remove('player-fs');
    setFsControl(false);
    exitNativeFs().catch(() => {});
    try {
      screen.orientation?.unlock?.();
    } catch {
      // unlock is optional
    }
  };
  const enterFull = () => {
    stopNativeGrace();
    stopNativeWatch();
    fsGen += 1;
    const gen = fsGen;
    leftoverNative = nativeFsEl() === container;
    wantFull = true;
    sawNativeFs = false;
    nativeElOnRequest = false;
    // Do not add is-fullscreen yet: .is-fullscreen sets aspect-ratio:auto and
    // height:100% without position:fixed, which collapses the player for the
    // ~400ms grace on no-op phones. Class is applied when native lands or
    // overlay fallback runs.
    waitingNativeFs = true;
    // Leftover native is still on screen: ⛶/F exits, so the control must
    // read Quitter. Grace wait stays Plein écran (second tap must not abort overlay).
    setFsControl(leftoverNative && waitingNativeFs);
    if (leftoverNative) {
      // Do not request while leftover native is still assigned (often a no-op).
      // Bound the wait so a hung prior exit cannot stall toggleFull; the
      // original exitFullscreen is already in flight.
      leftoverWaitTimer = setTimeout(() => {
        leftoverWaitTimer = 0;
        if (gen !== fsGen || !leftoverNative) return;
        // rAF may have been paused (background tab) while leftover already
        // left with no fullscreenchange — resume native, do not overlay.
        if (nativeFsEl() !== container) {
          resumeNativeAfterLeftover();
          return;
        }
        applyOverlayFallback();
        leftoverNative = false;
      }, LEFTOVER_NATIVE_WAIT_MS);
      pumpNativeSample();
      return;
    }
    armNativeWait();
  };
  const toggleFull = () => {
    // Leftover native is still on screen: a second ⛶/F must exit, not wait
    // for the 400ms leftover bound to overlay.
    if (waitingNativeFs && leftoverNative) {
      exitFull();
      return;
    }
    // Wait-only wantFull is not "already full": a second tap/F during the
    // native grace (common on iOS no-op) must not abort overlay fallback.
    if (waitingNativeFs) return;
    if (isFull()) exitFull();
    else enterFull();
  };
  btnFull.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFull();
  });
  const onFsChange = () => {
    if (leftoverNative) {
      if (nativeFsEl() !== container) {
        resumeNativeAfterLeftover();
        return;
      }
      if (wantFull) {
        syncForcedLandscape();
        return;
      }
    }
    noteNativeAssigned();
    // After overlay, still listen: cancel native, do not adopt.
    if (dismissNativeUnderOverlay()) {
      syncForcedLandscape();
      return;
    }
    if (wantFull && container.classList.contains('is-fake-fullscreen')) {
      syncForcedLandscape();
      return;
    }
    if (adoptNativeSuccess()) return;
    // Empty prefixed events during the request (element never assigned yet)
    // must not look like a leave. Assignment is noted when it lands (this
    // event, watch, rAF), so a short-lived native enter that is already
    // gone still stays exited instead of waiting for the grace overlay.
    if (waitingNativeFs && !sawNativeFs) {
      if (nativeElOnRequest) {
        exitFull();
        return;
      }
      return;
    }
    if (
      wantFull &&
      (sawNativeFs ||
        (container.classList.contains('is-fullscreen') &&
          !container.classList.contains('is-fake-fullscreen')))
    ) {
      // Esc / system UI left native fullscreen: drop overlay wait too.
      exitFull();
      return;
    }
    syncForcedLandscape();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  const onOrientation = () => syncForcedLandscape();
  window.addEventListener('orientationchange', onOrientation);
  window.addEventListener('resize', onOrientation);

  if (resumeFull?.overlay) {
    // Fake-FS: re-apply overlay immediately. Do not wait the native grace
    // or the hop flashes out of fullscreen for ~400ms.
    wantFull = true;
    applyOverlayFallback();
  } else if (resumeFull) {
    // Native FS is bound to the old container, which this remount replaces.
    // Re-request on the new node; overlay fallback still covers a no-op.
    enterFull();
  }

  showBar();
  render();
  container.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') showBar();
  });
  const bindChromeHold = (node) => {
    node.addEventListener('pointerdown', (e) => {
      chromeActivePointers.add(e.pointerId);
      showBar();
    });
    node.addEventListener('pointermove', (e) => {
      if (chromeActivePointers.has(e.pointerId) || e.buttons) showBar();
    });
    node.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      pointerInChrome = true;
      showBar();
    });
    node.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      pointerInChrome = false;
      showBar();
    });
    node.addEventListener('focusin', () => showBar());
    node.addEventListener('focusout', () => {
      window.queueMicrotask(() => showBar());
    });
    node.addEventListener('keydown', () => showBar());
  };
  bindChromeHold(bar);
  bindChromeHold(btnCast);
  const onChromePointerEnd = (e) => {
    if (!chromeActivePointers.has(e.pointerId)) return;
    chromeActivePointers.delete(e.pointerId);
    showBar();
  };
  const stopHoldSeeks = [];
  const onHoldPointerEnds = [];
  const onDocPointerEnd = (e) => {
    onChromePointerEnd(e);
    for (const fn of onHoldPointerEnds) fn(e);
  };
  document.addEventListener('pointerup', onDocPointerEnd);
  document.addEventListener('pointercancel', onDocPointerEnd);

  // --- touch zones: pointerdown/up, not click ---
  function bindThird(node, dir) {
    let tapCount = 0;
    let tapTimer = null;
    let holdTimer = 0;
    let holdInterval = 0;
    let holdStart = 0;
    let downAt = 0;
    let holdPointerId = null;
    let downOnThis = false;

    const flushTaps = () => {
      if (tapCount === 0) return;
      const total = tapCount * 10 * (dir === 'left' ? -1 : 1);
      video.currentTime = Math.min(
        Math.max(0, video.currentTime + total),
        video.duration || video.currentTime + total
      );
      tapCount = 0;
      seekHint.hidden = true;
    };

    const stopHoldSeek = (resume) => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = 0;
      }
      const active = Boolean(holdInterval);
      if (holdInterval) {
        clearInterval(holdInterval);
        holdInterval = 0;
      }
      holdPointerId = null;
      if (!active) return;
      holdSeeking = false;
      if (resume) {
        Promise.resolve(video.play())
          .catch(() => {})
          .finally(() => render());
      } else {
        render();
      }
    };
    stopHoldSeeks.push(() => {
      stopHoldSeek(false);
      clearTimeout(tapTimer);
      tapCount = 0;
    });
    onHoldPointerEnds.push((e) => {
      if (holdPointerId == null || e.pointerId !== holdPointerId) return;
      // Node pointerup still handles taps when the event lands on this third
      // (including captured slide-off). Document end covers release off-node.
      if (e.type === 'pointerup' && (e.target === node || node.contains(e.target))) return;
      stopHoldSeek(true);
    });

    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      downOnThis = true;
      downAt = Date.now();
      holdStart = Date.now();
      if (dir === 'center') return;
      holdPointerId = e.pointerId;
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic tests / some browsers: document pointerup still ends hold.
      }
      holdTimer = setTimeout(() => {
        holdSeeking = true;
        centerPlay.hidden = true;
        video.pause();
        holdInterval = setInterval(() => {
          const held = Date.now() - holdStart;
          const step = held > 3000 ? 30 : 10;
          video.currentTime = Math.min(
            Math.max(0, video.currentTime + (dir === 'left' ? -step : step)),
            video.duration || video.currentTime + step
          );
        }, 250);
      }, 500);
    });

    node.addEventListener('pointerup', (e) => {
      e.preventDefault();
      const fromThis = downOnThis;
      downOnThis = false;
      const heldMs = Date.now() - downAt;
      const wasHolding = Boolean(holdInterval);
      stopHoldSeek(true);
      if (!fromThis) return;
      if (wasHolding) return;
      if (heldMs >= 500) return;

      if (dir === 'center') {
        // Single tap pauses/plays after a short delay; a second tap in that
        // window cancels play-toggle and uses the existing native-first
        // fullscreen path (PRD §11.3). Mouse dblclick is debounced below so
        // it does not enter then immediately exit.
        tapCount += 1;
        if (tapCount === 1) {
          clearTimeout(tapTimer);
          tapTimer = setTimeout(() => {
            tapCount = 0;
            togglePlay();
          }, CENTER_DBLCLICK_MS);
          return;
        }
        clearTimeout(tapTimer);
        tapTimer = null;
        tapCount = 0;
        toggleFull();
        return;
      }

      // lateral: first tap shows the overlay; further taps in 800ms seek
      tapCount += 1;
      if (tapCount === 1) {
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          if (tapCount === 1) showBar();
          tapCount = 0;
        }, 300);
        return;
      }
      seekHint.hidden = false;
      seekHint.textContent = `${dir === 'left' ? '−' : '+'}${(tapCount - 1) * 10}s`;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(flushTaps, 800);
    });

    node.addEventListener('pointercancel', () => {
      downOnThis = false;
      stopHoldSeek(true);
    });
    if (dir === 'center') {
      node.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(tapTimer);
        tapTimer = null;
        // Two pointerups already toggled; a trailing mouse dblclick must not
        // immediately exit. If only dblclick arrived, still toggle.
        if (tapCount === 0) return;
        tapCount = 0;
        toggleFull();
      });
    }
  }
  bindThird(thirdL, 'left');
  bindThird(thirdC, 'center');
  bindThird(thirdR, 'right');

  // --- keyboard ---
  const onKey = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    switch (e.key) {
      case ' ':
        // Native buttons already activate on Space; don't toggle twice.
        if (e.target.closest('button')) return;
        e.preventDefault();
        togglePlay();
        showBar();
        break;
      case 'ArrowLeft':
        seekBy(-10);
        showBar();
        break;
      case 'ArrowRight':
        seekBy(10);
        showBar();
        break;
      case 'f':
      case 'F':
        toggleFull();
        break;
      case 'Escape':
        if (wantFull || container.classList.contains('is-fullscreen')) exitFull();
        break;
      default:
        break;
    }
  };
  document.addEventListener('keydown', onKey);

  video.play().catch(() => {
    render();
  });

  function cleanup() {
    castAlive = false;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    document.removeEventListener('pointerup', onDocPointerEnd);
    document.removeEventListener('pointercancel', onDocPointerEnd);
    for (const stop of stopHoldSeeks) stop();
    window.removeEventListener('orientationchange', onOrientation);
    window.removeEventListener('resize', onOrientation);
    clearTimeout(hideTimer);
    clearTimeout(badgeTimer);
    savePosition(file.path, video.currentTime, video.duration);
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (remote) {
      stopRemotePlayback();
      remote.removeEventListener('statechange', onRemoteState);
      const cancelWatch = (id) => {
        if (id == null || typeof remote.cancelWatchAvailability !== 'function') return;
        Promise.resolve(remote.cancelWatchAvailability(id)).catch(() => {});
      };
      cancelWatch(remoteWatchId);
      if (remoteWatchPending) {
        remoteWatchPending.then((id) => cancelWatch(id)).catch(() => {});
      }
    }
    video.removeAttribute('src');
    video.load();
    stopNativeGrace();
    stopNativeWatch();
    if (keepFullOnCleanup) {
      keepFullAcrossMount = snapshotKeepFull(wantFull, container);
      return;
    }
    keepFullAcrossMount = null;
    if (wantFull || isFull()) exitFull();
  }

  return { destroy: cleanup };
}
