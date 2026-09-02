// Custom video player (PRD §11.3): native <video>, home-made control bar,
// mobile-style touch zones, keyboard shortcuts, next-episode chaining and
// per-browser resume positions (localStorage). Fullscreen goes on the
// container, never on <video>, or the custom bar disappears (§13). Always
// try the native Fullscreen API first (Android Chrome can then hide the
// browser chrome). CSS overlay is the fallback when native rejects, is
// missing, or is a no-op. CSS landscape rotate is overlay + portrait +
// phone only — never rotate native fullscreen, and never rotate a
// tall/narrow desktop window.
// Do not add is-fullscreen until native lands or overlay fallback applies:
// the class sets aspect-ratio:auto; height:100% without position:fixed and
// would collapse the player for ~400ms on no-op phones.

const POS_PREFIX = 'sanem-pos:';
const WATCHED_PREFIX = 'sanem-watched:';
const VOLUME_KEY = 'sanem-volume';
const MUTED_KEY = 'sanem-muted';
const BAR_HIDE_MS = 2000;

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
function savePosition(path, seconds, duration) {
  if (duration && seconds / duration > 0.95) {
    clearPosition(path);
  } else if (seconds > 3) {
    localStorage.setItem(POS_PREFIX + path, String(Math.floor(seconds)));
    localStorage.setItem(WATCHED_PREFIX + path, String(Date.now()));
  }
}
export function clearPosition(path) {
  localStorage.removeItem(POS_PREFIX + path);
  localStorage.removeItem(WATCHED_PREFIX + path);
}

function el(tag, cls, attrs = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Mounts a player into `root`. Returns { destroy }.
 * @param {object} opts
 * @param {object} opts.file    - the media item ({ path, name, playback, duration, ... }).
 * @param {function} opts.onNext - called with the next file, or null at the end of a series.
 * @param {object|null} opts.next - the next episode file (same folder), or null.
 */
export function mountPlayer(root, { file, next, onNext }) {
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
  centerPlay.textContent = '▶';

  const bar = el('div', 'control-bar');

  const progress = el('div', 'progress', { role: 'slider', 'aria-label': 'Progression', tabindex: '0' });
  const progBuffer = el('div', 'progress-buffer');
  const progPlayed = el('div', 'progress-played');
  const progHandle = el('div', 'progress-handle');
  progress.append(progBuffer, progPlayed, progHandle);

  const time = el('span', 'time-display');
  time.textContent = '0:00 / 0:00';

  const btnMute = el('button', 'ctl', { type: 'button', 'aria-label': 'Couper le son' });
  btnMute.textContent = '🔊';
  const volume = el('input', 'volume', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Volume' });

  const speed = el('select', 'ctl speed', { 'aria-label': 'Vitesse de lecture' });
  for (const r of [0.75, 1, 1.25, 1.5, 1.75, 2]) {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `${r}×`;
    if (r === 1) o.selected = true;
    speed.appendChild(o);
  }

  const btnNext = el('button', 'ctl ctl-next', { type: 'button' });
  btnNext.textContent = 'Épisode suivant';
  btnNext.hidden = !next;

  const btnFull = el('button', 'ctl', { type: 'button', 'aria-label': 'Plein écran' });
  btnFull.textContent = '⛶';

  // Play/pause is the named Netflix-style center button, not a toolbar control.
  bar.append(progress, time, btnMute, volume, speed, btnNext, btnFull);

  const nextOverlay = el('div', 'next-overlay', { hidden: '' });

  container.append(video, touch, centerPlay, seekHint, nextOverlay, bar);
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

  // --- restore volume / position ---
  const savedVol = Number(localStorage.getItem(VOLUME_KEY));
  video.volume = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 1;
  video.muted = localStorage.getItem(MUTED_KEY) === '1';
  volume.value = String(video.muted ? 0 : video.volume);

  const resumeAt = loadPosition(file.path);
  video.addEventListener('loadedmetadata', () => {
    if (resumeAt > 0 && resumeAt < (video.duration || Infinity) - 5) {
      video.currentTime = resumeAt;
    }
    render();
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
    btnMute.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    const atEnd = !nextOverlay.hidden && nextOverlay.classList.contains('is-end');
    centerPlay.hidden = !video.paused || atEnd || holdSeeking;
    centerPlay.setAttribute('aria-label', video.paused ? 'Lire' : 'Pause');
  }

  let hideTimer = null;
  let pointerInBar = false;
  const barActivePointers = new Set();
  const hoverHoldBar = () =>
    window.matchMedia('(hover: hover)').matches &&
    window.matchMedia('(pointer: fine)').matches &&
    bar.matches(':hover');
  // Mouse/pen hover or an active pointer on the bar holds controls-visible
  // so the 2s timer cannot hide it under the cursor/finger.
  const barHoldsVisible = () =>
    pointerInBar ||
    hoverHoldBar() ||
    barActivePointers.size > 0 ||
    (document.activeElement != null && bar.contains(document.activeElement));
  const hideBar = () => {
    if (barHoldsVisible()) {
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
    // inert drops focus and tab order. Do not blur here: barHoldsVisible
    // already keeps the bar up while it contains document.activeElement.
  };
  const showBar = () => {
    bar.inert = false;
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
    if (next && video.duration && video.duration - video.currentTime <= 10) {
      nextOverlay.hidden = false;
    }
  });
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
    if (next) goNext();
    else {
      nextOverlay.hidden = false;
      nextOverlay.classList.add('is-end');
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
  const goNext = () => {
    cleanup();
    onNext(next || null);
  };

  btnNext.addEventListener('click', goNext);

  const nextBtnOverlay = el('button', 'ctl', { type: 'button' });
  nextBtnOverlay.textContent = next ? 'Épisode suivant ▸' : 'Revenir à la série';
  nextBtnOverlay.addEventListener('click', goNext);
  nextOverlay.appendChild(nextBtnOverlay);

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
  speed.addEventListener('change', () => {
    video.playbackRate = Number(speed.value);
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
    btnFull.setAttribute('aria-label', 'Quitter le plein écran');
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
    btnFull.setAttribute('aria-label', 'Quitter le plein écran');
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
    btnFull.setAttribute('aria-label', 'Plein écran');
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
    btnFull.setAttribute('aria-label', 'Plein écran');
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
    btnFull.setAttribute(
      'aria-label',
      leftoverNative && waitingNativeFs ? 'Quitter le plein écran' : 'Plein écran'
    );
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

  showBar();
  render();
  container.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') showBar();
  });
  bar.addEventListener('pointerdown', (e) => {
    barActivePointers.add(e.pointerId);
    showBar();
  });
  bar.addEventListener('pointermove', (e) => {
    if (barActivePointers.has(e.pointerId) || e.buttons) showBar();
  });
  const onBarPointerEnd = (e) => {
    if (!barActivePointers.has(e.pointerId)) return;
    barActivePointers.delete(e.pointerId);
    showBar();
  };
  const stopHoldSeeks = [];
  const onHoldPointerEnds = [];
  const onDocPointerEnd = (e) => {
    onBarPointerEnd(e);
    for (const fn of onHoldPointerEnds) fn(e);
  };
  document.addEventListener('pointerup', onDocPointerEnd);
  document.addEventListener('pointercancel', onDocPointerEnd);
  bar.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    pointerInBar = true;
    showBar();
  });
  bar.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    pointerInBar = false;
    showBar();
  });
  bar.addEventListener('focusin', () => showBar());
  bar.addEventListener('focusout', () => {
    window.queueMicrotask(() => showBar());
  });
  bar.addEventListener('keydown', () => showBar());

  // --- touch zones: pointerdown/up, not click ---
  function bindThird(node, dir) {
    let tapCount = 0;
    let tapTimer = null;
    let holdTimer = 0;
    let holdInterval = 0;
    let holdStart = 0;
    let downAt = 0;
    let holdPointerId = null;

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
    stopHoldSeeks.push(() => stopHoldSeek(false));
    onHoldPointerEnds.push((e) => {
      if (holdPointerId == null || e.pointerId !== holdPointerId) return;
      // Node pointerup still handles taps when the event lands on this third
      // (including captured slide-off). Document end covers release off-node.
      if (e.type === 'pointerup' && (e.target === node || node.contains(e.target))) return;
      stopHoldSeek(true);
    });

    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
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
      const heldMs = Date.now() - downAt;
      const wasHolding = Boolean(holdInterval);
      stopHoldSeek(true);
      if (wasHolding) return;
      if (heldMs >= 500) return;

      if (dir === 'center') {
        // Immediate play/pause. Double-tap fullscreen lives on the dedicated
        // fullscreen button, not on the video surface.
        togglePlay();
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
      stopHoldSeek(true);
    });
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
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    document.removeEventListener('pointerup', onDocPointerEnd);
    document.removeEventListener('pointercancel', onDocPointerEnd);
    for (const stop of stopHoldSeeks) stop();
    window.removeEventListener('orientationchange', onOrientation);
    window.removeEventListener('resize', onOrientation);
    clearTimeout(hideTimer);
    savePosition(file.path, video.currentTime, video.duration);
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.removeAttribute('src');
    video.load();
    stopNativeGrace();
    stopNativeWatch();
    if (wantFull || isFull()) exitFull();
  }

  return { destroy: cleanup };
}
