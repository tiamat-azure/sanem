// Browser E2E for the Lukluk player chrome (smartphone overlay + fullscreen).
// Uses the system Chromium/Chrome via the DevTools protocol so we do not add
// an npm dependency. The tiny H.264/AAC fixture is committed; ffprobe is
// not required because the probe cache is seeded before the server starts.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const PASSWORD = 'integration-test-password';
const SESSION_SECRET = 'integration-test-session-secret-at-least-32-chars';
const CLIP = path.join(import.meta.dirname, 'fixtures', 'clip.mp4');
const PLAY_PATH = 'Serie/e01.mp4';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function chromePath() {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 204) return res;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`did not become ready: ${url}`);
}

async function startServer(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sanem-player-ui-'));
  const seriesDir = path.join(dataDir, 'uploads', 'Serie');
  await fs.mkdir(seriesDir, { recursive: true });
  const files = ['e01.mp4', 'e02.mp4'];
  for (const name of files) {
    const rel = `Serie/${name}`;
    await fs.copyFile(CLIP, path.join(seriesDir, name));
    const stats = await fs.stat(path.join(seriesDir, name));
    const hash = crypto.createHash('sha256').update(rel).digest('hex');
    const cacheDir = path.join(dataDir, 'transcode', hash);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'probe.json'),
      JSON.stringify({
        relativePath: rel,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        info: {
          kind: 'video',
          playback: 'direct',
          lane: 0,
          duration: 2,
          width: 320,
          height: 180,
          vcodec: 'h264',
          acodec: 'aac',
          container: 'mov,mp4,m4a,3gp,3g2,mj2',
          heavy: false,
          internalSubtitles: 0,
        },
      })
    );
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = path.join(import.meta.dirname, '..', 'src', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      SANEM_PASSWORD: PASSWORD,
      SANEM_SESSION_SECRET: SESSION_SECRET,
      SANEM_PORT: String(port),
      SANEM_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForHttp(`${baseUrl}/api/session`);
  return { baseUrl, dataDir };
}

async function loginCookie(baseUrl) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 204);
  const raw = res.headers.getSetCookie()[0];
  const pair = raw.split(';')[0];
  const eq = pair.indexOf('=');
  return {
    name: pair.slice(0, eq),
    value: decodeURIComponent(pair.slice(eq + 1)),
  };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id == null) return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else waiter.resolve(msg.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}

async function openChrome(t) {
  const bin = chromePath();
  assert.ok(bin, 'Google Chrome / Chromium is required for player UI E2E');
  const dbgPort = await getFreePort();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sanem-chrome-'));
  const child = spawn(
    bin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${dbgPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 150));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const versionRes = await waitForHttp(`http://127.0.0.1:${dbgPort}/json/version`);
  const version = await versionRes.json();
  const ws = new globalThis.WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('chrome websocket failed')), { once: true });
  });
  t.after(() => {
    try {
      ws.close();
    } catch {
      // already closed
    }
  });
  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  return { send };
}

async function setPhoneViewport(send, { width, height, landscape }) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
    screenWidth: landscape ? height : width,
    screenHeight: landscape ? width : height,
    screenOrientation: landscape
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 },
  });
  await send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const text =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'evaluate failed';
    throw new Error(text);
  }
  return result.result.value;
}

async function waitFor(send, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(send, expression);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${expression}`);
}

async function clickSelector(send, selector) {
  await evaluate(
    send,
    `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) throw new Error('missing ${selector}');
      el.scrollIntoView({block:'nearest',inline:'nearest'});
    })()`
  );
  const box = await waitFor(
    send,
    `(function(){const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) return null;
      const r=el.getBoundingClientRect();
      if(r.width===0||r.height===0) return null;
      return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  );
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
}

async function tapSelector(send, selector) {
  await evaluate(
    send,
    `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) throw new Error('missing ${selector}');
      el.click();
    })()`
  );
}

async function openPlayer(t, viewport) {
  const { baseUrl } = await startServer(t);
  const cookie = await loginCookie(baseUrl);
  const { send } = await openChrome(t);
  await setPhoneViewport(send, viewport);
  await send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    url: baseUrl,
    httpOnly: true,
    path: '/',
  });
  await send('Page.navigate', { url: `${baseUrl}/#/lukluk/play/${encodeURIComponent(PLAY_PATH)}` });
  await waitFor(send, 'Boolean(document.querySelector(".player-container"))');
  await waitFor(send, 'Boolean(document.querySelector(".control-bar"))');
  return { send };
}

const SNAPSHOT = `({
  skipBack: Boolean(document.querySelector('[aria-label="Reculer de 10 secondes"]')),
  skipFwd: Boolean(document.querySelector('[aria-label="Avancer de 10 secondes"]')),
  dock: Boolean(document.querySelector('.dock')),
  menuButton: Boolean(document.querySelector('#app-menu-button')),
  menuHidden: document.getElementById('app-menu')?.hidden ?? null,
  menuText: document.getElementById('app-menu')?.innerText ?? '',
  controlsVisible: document.querySelector('.player-container')?.classList.contains('controls-visible') ?? false,
  fs: document.querySelector('.player-container')?.classList.contains('is-fullscreen') ?? false,
  fakeFs: document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') ?? false,
  forcedLandscape: document.querySelector('.player-container')?.classList.contains('is-forced-landscape') ?? false,
  player: (() => {
    const el = document.querySelector('.player-container');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })(),
  bar: (() => {
    const bar = document.querySelector('.control-bar');
    if (!bar) return null;
    const visible = [...bar.children].filter((el) => getComputedStyle(el).display !== 'none' && !el.hidden);
    const rects = visible.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, width: r.width, cls: el.className };
    });
    const br = bar.getBoundingClientRect();
    const stacked = rects.some((a, i) =>
      rects.some((b, j) => i !== j && a.top >= b.bottom - 1)
    );
    const buttonTops = visible
      .filter((el) => el.tagName === 'BUTTON' || el.tagName === 'SELECT')
      .map((el) => el.getBoundingClientRect().top);
    return {
      height: br.height,
      width: br.width,
      wrap: buttonTops.length ? Math.max(...buttonTops) - Math.min(...buttonTops) : 0,
      stacked,
      childCount: visible.length,
      nextVisible: visible.some((el) => el.classList.contains('ctl-next')),
    };
  })(),
  viewport: { w: window.innerWidth, h: window.innerHeight, portrait: window.matchMedia('(orientation: portrait)').matches },
})`;

test('player UI on a smartphone portrait viewport', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });

  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.skipBack, false);
  assert.equal(ui.skipFwd, false);
  assert.equal(ui.dock, false);
  assert.equal(ui.menuButton, true);
  assert.equal(ui.viewport.portrait, true);
  assert.equal(ui.viewport.w, 390);

  await clickSelector(send, '#app-menu-button');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.menuHidden, false);
  assert.match(ui.menuText, /Putum/);
  assert.match(ui.menuText, /Lukluk/);
  assert.match(ui.menuText, /Thème clair|Thème obscur/);
  assert.match(ui.menuText, /Déconnexion/);

  await clickSelector(send, '#app-menu-button'); // close, keep the video free
  await waitFor(send, 'document.getElementById("app-menu").hidden === true');

  ui = await evaluate(send, SNAPSHOT);
  if (!ui.controlsVisible) {
    await clickSelector(send, '.touch-center');
    await new Promise((r) => setTimeout(r, 350));
    ui = await evaluate(send, SNAPSHOT);
  }
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true);
  assert.ok(ui.bar, 'control bar is present');
  assert.equal(ui.bar.nextVisible, true, 'next-episode control should be present for wrap check');
  assert.equal(ui.bar.stacked, false, 'toolbar children stacked onto a second line');
  assert.ok(ui.bar.wrap < 8, `toolbar wrapped by ${ui.bar.wrap}px`);
  assert.ok(ui.bar.height < 72, `toolbar height ${ui.bar.height} looks like two rows`);
  assert.ok(ui.bar.width <= ui.viewport.w + 1);

  await clickSelector(send, '.touch-center');
  await new Promise((r) => setTimeout(r, 350));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'first tap on the video hides the overlay');

  await clickSelector(send, '.touch-center');
  await new Promise((r) => setTimeout(r, 350));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'second tap shows the overlay again');
  assert.ok(ui.bar.wrap < 8, `toolbar wrapped after toggle by ${ui.bar.wrap}px`);

  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await new Promise((r) => setTimeout(r, 400));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, true, `expected fullscreen class, got ${JSON.stringify(ui)}`);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.forcedLandscape, true);
  assert.ok(ui.player.w > ui.viewport.w * 0.9, `fullscreen width ${ui.player.w} vs viewport ${ui.viewport.w}`);
  assert.ok(ui.player.h > ui.viewport.h * 0.9, `fullscreen height ${ui.player.h} vs viewport ${ui.viewport.h}`);
  // Long edge of the phone is the landscape width of the rotated player.
  const longEdge = Math.max(ui.player.w, ui.player.h);
  assert.ok(longEdge > 800, `expected landscape span, got ${longEdge}`);
});

test('player UI on a smartphone landscape viewport', async (t) => {
  const { send } = await openPlayer(t, { width: 844, height: 390, landscape: true });

  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.skipBack, false);
  assert.equal(ui.dock, false);
  assert.equal(ui.viewport.portrait, false);
  assert.equal(ui.viewport.w, 844);
  assert.equal(ui.viewport.h, 390);
  assert.equal(ui.bar.stacked, false, 'landscape toolbar stacked onto a second line');
  assert.ok(ui.bar.wrap < 8, `landscape toolbar wrapped by ${ui.bar.wrap}px`);
  assert.ok(ui.bar.height < 72, `landscape toolbar height ${ui.bar.height}`);

  if (!ui.controlsVisible) {
    await clickSelector(send, '.touch-center');
    await new Promise((r) => setTimeout(r, 350));
  }
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await new Promise((r) => setTimeout(r, 400));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, true, `expected fullscreen class, got ${JSON.stringify(ui)}`);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.forcedLandscape, false, 'already landscape: do not rotate again');
  assert.ok(Math.abs(ui.player.w - ui.viewport.w) < 8, `fs width ${ui.player.w} vs ${ui.viewport.w}`);
  assert.ok(Math.abs(ui.player.h - ui.viewport.h) < 8, `fs height ${ui.player.h} vs ${ui.viewport.h}`);
  assert.ok(ui.player.w > ui.player.h, 'landscape fullscreen is wider than it is tall');
});
