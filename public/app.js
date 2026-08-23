// Sanem frontend: session gate, Uppy dashboard wiring, file listing, theme toggle.

const THEME_KEY = 'sanem-theme';
const MAX_FILE_GB = Number(document.body.dataset.maxFileGb) || 20;

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const passwordInput = document.getElementById('password');
const logoutButton = document.getElementById('logout-button');
const themeToggle = document.getElementById('theme-toggle');
const filesList = document.getElementById('files-list');
const filesEmpty = document.getElementById('files-empty');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved === 'light' ? 'light' : 'dark');
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

function showScreen(authenticated) {
  loginScreen.hidden = authenticated;
  appScreen.hidden = !authenticated;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('fr-FR');
}

async function refreshFiles() {
  const res = await fetch('/api/files', { credentials: 'same-origin' });
  if (!res.ok) return;
  const files = await res.json();

  filesList.innerHTML = '';
  filesEmpty.hidden = files.length > 0;

  for (const file of files) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <span class="file-name">${escapeHtml(file.name)}</span>
      <span class="file-meta">${formatSize(file.size)} · ${formatDate(file.uploadedAt)}</span>
    `;
    filesList.appendChild(li);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function checkSession() {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  const { authenticated } = await res.json();
  showScreen(authenticated);
  if (authenticated) {
    initUppy();
    refreshFiles();
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.hidden = true;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password: passwordInput.value }),
  });

  if (res.status === 204) {
    passwordInput.value = '';
    showScreen(true);
    initUppy();
    refreshFiles();
    return;
  }

  loginError.hidden = false;
  loginError.textContent =
    res.status === 429
      ? 'Trop de tentatives. Réessaie dans quelques minutes.'
      : 'Mot de passe incorrect.';
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  showScreen(false);
});

let uppyInitialized = false;

function initUppy() {
  if (uppyInitialized) return;
  uppyInitialized = true;

  const uppy = new Uppy.Uppy({
    restrictions: {
      maxFileSize: MAX_FILE_GB * 1024 * 1024 * 1024,
    },
    locale: {
      strings: {
        exceedsSize: `Ce fichier dépasse la limite de ${MAX_FILE_GB} Go.`,
      },
    },
  });

  uppy.use(Uppy.Dashboard, {
    inline: true,
    target: '#dashboard-container',
    theme: 'dark',
    proudlyDisplayPoweredByUppy: false,
    note: `Glisse-dépose tes fichiers ici (max ${MAX_FILE_GB} Go).`,
  });

  uppy.use(Uppy.Tus, {
    endpoint: '/files',
    chunkSize: 8 * 1024 * 1024,
    retryDelays: [0, 1000, 3000, 5000, 10000],
    withCredentials: true,
  });

  uppy.on('complete', () => {
    refreshFiles();
  });
}

initTheme();
checkSession();
