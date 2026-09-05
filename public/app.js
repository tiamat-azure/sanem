// Sanem frontend: session gate, hash router, Putum (Uppy drop) and Lukluk
// (video library) screens. No server navigation - GET / always serves the
// same page (PRD §11). Neon dark theme by default, light/dark toggle
// persisted in localStorage.

import {
  mountPlayer,
  loadPosition,
  loadWatchedAt,
  watchState,
  episodeLabel,
  seriesSiblings,
} from './player.js';

const THEME_KEY = 'sanem-theme';
const LAST_TAB_KEY = 'sanem-last-tab';
const MAX_FILE_GB = Number(document.body.dataset.maxFileGb) || 20;

// Locale-aware + numeric so "Serie 2" < "Serie 10" and S01E09 < S01E10.
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.path, b.path);

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const passwordInput = document.getElementById('password');
const view = document.getElementById('view');
const menuButton = document.getElementById('app-menu-button');
const appMenu = document.getElementById('app-menu');
const themeToggle = document.getElementById('theme-toggle');
const menuLinks = [...document.querySelectorAll('.app-menu-item')];

let filesCache = [];
let activePlayer = null;

// --- theme ---
// The toggle advertises the theme it switches *to*, icon included.
function themeAction(theme) {
  return theme === 'dark'
    ? { label: 'Thème clair', icon: 'i-sun' }
    : { label: 'Thème obscur', icon: 'i-moon' };
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const { label, icon } = themeAction(theme);
  themeToggle.querySelector('.menu-label').textContent = label;
  themeToggle.querySelector('.menu-icon use').setAttribute('href', `#${icon}`);
}
applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// --- overflow menu (Putum, Lukluk, theme, logout) ---
function setMenuOpen(open) {
  appMenu.hidden = !open;
  menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function toggleMenu() {
  setMenuOpen(appMenu.hidden);
}
menuButton.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});
appMenu.addEventListener('click', (e) => {
  // Follow a link or fire a button, then close so the chrome stays out of the way.
  if (e.target.closest('a, button')) setMenuOpen(false);
});
document.addEventListener('click', (e) => {
  if (appMenu.hidden) return;
  if (e.target.closest('#app-menu') || e.target.closest('#app-menu-button')) return;
  setMenuOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !appMenu.hidden) setMenuOpen(false);
});

// --- helpers ---
const escapeHtml = (s) => {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
};
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}
// Clock form (h:mm:ss / m:ss) for a resume position.
function formatClock(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}
function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
const mediaPath = (p) => p.split('/').map(encodeURIComponent).join('/');
// Deterministic gradient from a string, used when a thumbnail is missing (§10.6).
function gradientFor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 60) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 30%), hsl(${h2} 70% 22%))`;
}

async function api(path, opts) {
  return fetch(path, { credentials: 'same-origin', ...opts });
}

async function refreshFiles() {
  const res = await api('/api/files');
  if (!res.ok) return filesCache;
  filesCache = await res.json();
  return filesCache;
}

function seriesList(files) {
  const map = new Map();
  for (const f of files) {
    if (!f.dir) continue;
    if (!map.has(f.dir)) map.set(f.dir, []);
    map.get(f.dir).push(f);
  }
  return [...map.entries()]
    .map(([dir, items]) => ({ dir, items: [...items].sort(byName) }))
    .sort((a, b) => collator.compare(a.dir, b.dir));
}

// --- thumbnail element with graceful fallback ---
function thumbEl(file) {
  const wrap = document.createElement('div');
  wrap.className = 'thumb';
  wrap.style.backgroundImage = gradientFor(file.path);
  if (file.kind === 'video') {
    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.loading = 'lazy';
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('is-loaded'));
    img.addEventListener('error', () => img.remove());
    img.src = `/api/thumbs/${mediaPath(file.path)}`;
    wrap.appendChild(img);
  }
  const pos = loadPosition(file.path);
  if (pos > 0 && file.duration) {
    const bar = document.createElement('div');
    bar.className = 'thumb-resume';
    bar.style.width = `${Math.min(100, (pos / file.duration) * 100)}%`;
    wrap.appendChild(bar);
  }
  return wrap;
}

// --- screens ---
function fromTemplate(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function renderHub() {
  const frag = fromTemplate('tpl-hub');
  const files = filesCache;
  const vids = files.filter((f) => f.kind === 'video');
  const series = seriesList(files);
  frag.querySelector('[data-hub-count]').textContent =
    `Regarder les vidéos - ${series.length} série${series.length > 1 ? 's' : ''}, ${vids.length} vidéo${vids.length > 1 ? 's' : ''}`;
  view.replaceChildren(frag);
}

let uppy = null;
function renderPutum() {
  const frag = fromTemplate('tpl-putum');
  view.replaceChildren(frag);

  const select = document.getElementById('series-select');
  const newField = document.getElementById('new-series-field');
  const newInput = document.getElementById('new-series-name');
  const series = seriesList(filesCache).map((s) => s.dir).sort((a, b) => a.localeCompare(b, 'fr'));

  select.innerHTML =
    `<option value="">Aucune (racine)</option>` +
    series.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('') +
    `<option value="__new__">Nouvelle série…</option>`;
  select.addEventListener('change', () => {
    newField.hidden = select.value !== '__new__';
  });

  const targetFolder = () => {
    if (select.value === '__new__') return newInput.value.trim();
    return select.value;
  };

  if (uppy) {
    uppy.destroy();
    uppy = null;
  }
  uppy = new window.Uppy.Uppy({
    restrictions: { maxFileSize: MAX_FILE_GB * 1024 * 1024 * 1024 },
    locale: {
      strings: { exceedsSize: `Ce fichier dépasse la limite de ${MAX_FILE_GB} Go.` },
    },
  });
  uppy.use(window.Uppy.Dashboard, {
    inline: true,
    target: '#dashboard-container',
    theme: 'dark',
    proudlyDisplayPoweredByUppy: false,
    note: `Glisse-dépose fichiers et dossiers ici (max ${MAX_FILE_GB} Go).`,
  });
  uppy.use(window.Uppy.Tus, {
    endpoint: '/files',
    chunkSize: 8 * 1024 * 1024,
    retryDelays: [0, 1000, 3000, 5000, 10000],
    withCredentials: true,
  });
  // Transmit the relative path as an extra tus metadata field (§9, §11.2).
  uppy.on('file-added', (file) => {
    const rel = file.data?.webkitRelativePath || file.meta?.relativePath || file.name;
    const folder = targetFolder();
    const relativePath = folder ? `${folder}/${file.name}` : rel;
    uppy.setFileMeta(file.id, { relativePath, filename: file.name });
  });
  uppy.on('complete', () => refreshFiles());
}

function renderLukluk() {
  const frag = fromTemplate('tpl-lukluk');
  view.replaceChildren(frag);
  const files = [...filesCache].sort(byName);
  const vids = files.filter((f) => f.kind === 'video' || f.playback !== 'none');
  const rows = document.getElementById('rows');
  const empty = document.getElementById('lukluk-empty');

  if (files.length === 0) {
    empty.hidden = false;
    return;
  }

  // Featured: the last video watched but not finished, otherwise the first
  // playable one in alphabetical order (else the first file).
  const byRecent = [...files].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const lastWatched = vids
    .filter((f) => f.playback !== 'none' && loadPosition(f.path) > 0 && loadWatchedAt(f.path) > 0)
    .sort((a, b) => loadWatchedAt(b.path) - loadWatchedAt(a.path))[0];
  const featuredFile = lastWatched || files.find((f) => f.playback !== 'none') || files[0];
  if (featuredFile) {
    const feat = document.getElementById('featured');
    feat.hidden = false;
    feat.style.backgroundImage = gradientFor(featuredFile.path);
    feat.innerHTML = `
      <div class="featured-body">
        <h2>${escapeHtml(featuredFile.dir ? featuredFile.dir + ' · ' : '')}${escapeHtml(featuredFile.name)}</h2>
        <p>${escapeHtml(formatDuration(featuredFile.duration))} ${featuredFile.ready ? '' : '· analyse en cours'}</p>
      </div>`;
    const btn = document.createElement('button');
    btn.className = 'featured-play';
    btn.textContent = featuredFile.playback === 'none' ? 'Télécharger' : (loadPosition(featuredFile.path) > 0 ? 'Reprendre' : 'Lire');
    btn.addEventListener('click', () => {
      if (featuredFile.playback === 'none') {
        location.href = `/api/download/${mediaPath(featuredFile.path)}`;
      } else {
        location.hash = `#/lukluk/play/${encodeURIComponent(featuredFile.path)}`;
      }
    });
    feat.querySelector('.featured-body').appendChild(btn);
  }

  const resume = vids.filter((f) => loadPosition(f.path) > 0);
  const series = seriesList(files);
  const nouveautes = byRecent.filter((f) => f.kind === 'video').slice(0, 12);

  rows.replaceChildren();
  if (resume.length) rows.appendChild(buildRow('Reprendre la lecture', resume));
  if (series.length) rows.appendChild(buildSeriesRow(series));
  if (nouveautes.length) rows.appendChild(buildRow('Nouveautés', nouveautes));
  rows.appendChild(buildRow('Tout', vids));
}

function buildRow(title, items) {
  const section = document.createElement('section');
  section.className = 'row';
  section.innerHTML = `<h3>${escapeHtml(title)}</h3>`;
  const track = document.createElement('div');
  track.className = 'row-track';
  for (const file of items) {
    const card = document.createElement('article');
    card.className = 'card';
    card.appendChild(thumbEl(file));
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.innerHTML = `<span class="card-name">${escapeHtml(file.name)}</span>
      <span class="card-sub">${escapeHtml(file.dir || 'Racine')}${file.duration ? ' · ' + formatDuration(file.duration) : ''}</span>`;
    card.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (file.playback !== 'none') {
      const play = document.createElement('button');
      play.textContent = !file.ready ? 'Analyse…' : loadPosition(file.path) > 0 ? 'Reprendre' : 'Lire';
      play.disabled = !file.ready;
      play.addEventListener('click', () => {
        location.hash = `#/lukluk/play/${encodeURIComponent(file.path)}`;
      });
      actions.appendChild(play);
    }
    const dl = document.createElement('a');
    dl.textContent = 'Télécharger';
    dl.href = `/api/download/${mediaPath(file.path)}`;
    actions.appendChild(dl);
    card.appendChild(actions);
    track.appendChild(card);
  }
  section.appendChild(track);
  return section;
}

function buildSeriesRow(series) {
  const section = document.createElement('section');
  section.className = 'row';
  section.innerHTML = `<h3>Séries</h3>`;
  const track = document.createElement('div');
  track.className = 'row-track';
  for (const s of series) {
    const card = document.createElement('a');
    card.className = 'card card-series';
    card.href = `#/lukluk/serie/${encodeURIComponent(s.dir)}`;
    card.appendChild(thumbEl(s.items[0]));
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.innerHTML = `<span class="card-name">${escapeHtml(s.dir)}</span>
      <span class="card-sub">${s.items.length} épisode${s.items.length > 1 ? 's' : ''}</span>`;
    card.appendChild(meta);
    track.appendChild(card);
  }
  section.appendChild(track);
  return section;
}

// Action verb for a media, from what playback left behind (PRD §10.8):
// unseen -> Lire, in-progress -> Reprendre, done -> Revoir.
function playLabel(file) {
  if (!file.ready) return 'Analyse…';
  const state = watchState(file.path);
  if (state === 'in-progress') return 'Reprendre';
  return state === 'done' ? 'Revoir' : 'Lire';
}

// Thumbnail for the rail: same status markers as the hero poster, so both
// zones read identically (green check when done, magenta bar when in progress).
function railThumb(file) {
  const wrap = thumbEl(file);
  wrap.classList.add('rail-thumb');
  if (watchState(file.path) === 'done') {
    const seen = document.createElement('span');
    seen.className = 'seen-badge';
    seen.textContent = '✓';
    seen.title = 'Épisode vu';
    wrap.appendChild(seen);
  }
  return wrap;
}

function renderSerie(dir) {
  const frag = fromTemplate('tpl-serie');
  view.replaceChildren(frag);
  document.getElementById('serie-title').textContent = dir;
  const items = filesCache.filter((f) => f.dir === dir);
  if (!items.length) {
    document.getElementById('serie-empty').hidden = false;
    return;
  }

  const hero = document.getElementById('serie-hero');
  const rail = document.getElementById('serie-rail');
  const track = document.getElementById('serie-track');
  hero.hidden = false;
  rail.hidden = false;

  const doneCount = items.filter((f) => watchState(f.path) === 'done').length;
  document.getElementById('serie-count').textContent =
    `${items.length} épisode${items.length > 1 ? 's' : ''}` +
    (doneCount ? ` · ${doneCount} vu${doneCount > 1 ? 's' : ''}` : '');

  // --- hero: the focused episode, mirroring the Lukluk featured block ---
  function renderHero(file) {
    hero.style.backgroundImage = gradientFor(file.path);
    hero.replaceChildren();

    const poster = document.createElement('div');
    poster.className = 'serie-hero-poster';
    poster.appendChild(railThumb(file));
    hero.appendChild(poster);

    const body = document.createElement('div');
    body.className = 'serie-hero-body';
    const meta = [formatDuration(file.duration), formatSize(file.size)].filter(Boolean);
    if (!file.ready) meta.push('analyse en cours');
    const pos = loadPosition(file.path);
    if (pos > 0) meta.push(`reprendre à ${formatClock(pos)}`);
    else if (watchState(file.path) === 'done') meta.push('déjà vu');
    body.innerHTML = `<h2>${escapeHtml(episodeLabel(file))}</h2>
      <p class="serie-hero-meta">${escapeHtml(meta.join(' · '))}</p>
      <p class="serie-hero-file">${escapeHtml(file.name)}</p>`;

    const actions = document.createElement('div');
    actions.className = 'serie-hero-actions';
    if (file.playback !== 'none') {
      const play = document.createElement('button');
      play.className = 'serie-hero-play';
      play.textContent = playLabel(file);
      play.disabled = !file.ready;
      play.addEventListener('click', () => {
        location.hash = `#/lukluk/play/${encodeURIComponent(file.path)}`;
      });
      actions.appendChild(play);
    }
    const dl = document.createElement('a');
    dl.textContent = 'Télécharger';
    dl.href = `/api/download/${mediaPath(file.path)}`;
    actions.appendChild(dl);
    body.appendChild(actions);
    hero.appendChild(body);
  }

  // --- rail: one card per episode, drives the hero ---
  function focusCard(card, { scroll = false } = {}) {
    for (const c of track.children) c.classList.toggle('is-current', c === card);
    renderHero(items[Number(card.dataset.idx)]);
    if (scroll) {
      track.scrollTo({
        left: Math.max(0, card.offsetLeft - track.offsetLeft),
        behavior: 'smooth',
      });
    }
  }

  items.forEach((file, idx) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'rail-card';
    card.dataset.idx = String(idx);
    card.appendChild(railThumb(file));
    const cap = document.createElement('span');
    cap.className = 'rail-cap';
    cap.textContent = episodeLabel(file);
    card.appendChild(cap);
    card.addEventListener('click', () => focusCard(card));
    track.appendChild(card);
  });

  mountRailArrows(rail, track);

  // Start on the episode the viewer is most likely to want: the one in
  // progress, otherwise the first not yet finished, otherwise the first.
  const inProgress = items.findIndex((f) => watchState(f.path) === 'in-progress');
  const firstUnfinished = items.findIndex((f) => watchState(f.path) !== 'done');
  const startIdx = Math.max(0, inProgress >= 0 ? inProgress : firstUnfinished);
  const startCard = track.children[startIdx] || track.children[0];
  focusCard(startCard);
  // Skip the smooth animation on first paint - jump straight there.
  window.requestAnimationFrame(() => {
    track.scrollLeft = Math.max(0, startCard.offsetLeft - track.offsetLeft);
    updateRailArrows(rail, track);
  });
}

// Arrows appear on hover/focus only (PRD §11.4 keeps the clipped half-card as
// the touch affordance) and step by a whole visible page of cards.
function railStep(track) {
  const card = track.firstElementChild;
  if (!card) return track.clientWidth;
  const gap = parseFloat(window.getComputedStyle(track).columnGap) || 0;
  const unit = card.offsetWidth + gap;
  return Math.max(unit, Math.floor(track.clientWidth / unit) * unit);
}
function updateRailArrows(rail, track) {
  const max = track.scrollWidth - track.clientWidth - 2;
  rail.querySelector('.prev').disabled = track.scrollLeft <= 2;
  rail.querySelector('.next').disabled = track.scrollLeft >= max;
}
function mountRailArrows(rail, track) {
  const scrollBy = (dir) => {
    track.scrollBy({ left: dir * railStep(track), behavior: 'smooth' });
  };
  rail.querySelector('.prev').addEventListener('click', () => scrollBy(-1));
  rail.querySelector('.next').addEventListener('click', () => scrollBy(1));
  let t = null;
  track.addEventListener('scroll', () => {
    clearTimeout(t);
    t = setTimeout(() => updateRailArrows(rail, track), 80);
  });
  if (typeof window.ResizeObserver === 'function') {
    new window.ResizeObserver(() => updateRailArrows(rail, track)).observe(track);
  }
  updateRailArrows(rail, track);
}

function renderPlayer(path) {
  const frag = fromTemplate('tpl-player');
  view.replaceChildren(frag);
  const file = filesCache.find((f) => f.path === path);
  const back = document.getElementById('player-back');
  const warning = document.getElementById('player-warning');
  const rootEl = document.getElementById('player-root');

  if (!file || file.playback === 'none') {
    rootEl.innerHTML = '<p class="empty-message">Cette vidéo n\'est pas lisible ici.</p>';
    return;
  }
  back.href = file.dir ? `#/lukluk/serie/${encodeURIComponent(file.dir)}` : '#/lukluk';

  const { prev, next } = seriesSiblings(file, filesCache);
  const start = () => {
    warning.hidden = true;
    activePlayer = mountPlayer(rootEl, {
      file,
      prev,
      next,
      onNext: (nf) => {
        if (nf) location.hash = `#/lukluk/play/${encodeURIComponent(nf.path)}`;
        else location.hash = back.getAttribute('href');
      },
    });
  };

  // §10.5 - heavy path 3 above 1080p: warn before playing.
  if (file.heavy) {
    warning.hidden = false;
    warning.innerHTML =
      '<p>Cette vidéo est encodée dans un format lourd et en haute définition. ' +
      'La lecture est possible mais peut être lente&nbsp;; le téléchargement sera plus confortable.</p>';
    const go = document.createElement('button');
    go.textContent = 'Lire quand même';
    go.addEventListener('click', start);
    warning.appendChild(go);
    const dl = document.createElement('a');
    dl.textContent = 'Télécharger';
    dl.href = `/api/download/${mediaPath(file.path)}`;
    warning.appendChild(dl);
  } else {
    start();
  }
}

// --- router ---
function teardown() {
  if (activePlayer) {
    activePlayer.destroy();
    activePlayer = null;
  }
}

async function route() {
  teardown();
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean); // e.g. ['lukluk','serie','Frieren']

  await refreshFiles();

  let tab = 'putum';
  if (parts[0] === 'lukluk') tab = 'lukluk';
  if (parts[0] === 'putum') tab = 'putum';

  if (hash === '/') {
    const lastTab = localStorage.getItem(LAST_TAB_KEY);
    if (lastTab) {
      location.replace(`#/${lastTab}`);
      return;
    }
    setActiveTab(null);
    renderHub();
    return;
  }

  localStorage.setItem(LAST_TAB_KEY, tab);
  setActiveTab(tab);

  if (parts[0] === 'putum') return renderPutum();
  if (parts[0] === 'lukluk' && parts[1] === 'serie') return renderSerie(decodeURIComponent(parts.slice(2).join('/')));
  if (parts[0] === 'lukluk' && parts[1] === 'play') return renderPlayer(decodeURIComponent(parts.slice(2).join('/')));
  if (parts[0] === 'lukluk') return renderLukluk();
  location.replace('#/');
}

function setActiveTab(tab) {
  for (const link of menuLinks) {
    link.classList.toggle('is-active', link.dataset.tab === tab);
  }
}

window.addEventListener('hashchange', route);

// --- auth ---
function showApp(authenticated) {
  loginScreen.hidden = authenticated;
  appScreen.hidden = !authenticated;
  if (authenticated) {
    if (!location.hash) location.hash = '#/';
    else route();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const res = await api('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: passwordInput.value }),
  });
  if (res.status === 204) {
    passwordInput.value = '';
    showApp(true);
    route();
    return;
  }
  loginError.hidden = false;
  loginError.textContent =
    res.status === 429
      ? 'Trop de tentatives. Réessaie dans quelques minutes.'
      : 'Mot de passe incorrect.';
});

document.getElementById('logout-button').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  teardown();
  showApp(false);
});

(async () => {
  const res = await api('/api/session');
  const { authenticated } = await res.json();
  showApp(authenticated);
})();
