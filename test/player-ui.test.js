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

const HAS_CHROME = Boolean(chromePath());

function uiTest(name, fn) {
  test(name, { skip: HAS_CHROME ? false : 'Chromium not installed; skipping player UI E2E' }, fn);
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

async function openChrome(t, { touch = true } = {}) {
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
  if (touch) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  return { send };
}

async function setDesktopViewport(send, { width, height }) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
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

async function clickAt(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
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

async function installFullscreenStub(send, behavior) {
  const script = `(function(){
    window.__fsRequests = 0;
    window.__fsExits = 0;
    let fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get() { return fsEl; },
    });
    Object.defineProperty(document, 'webkitFullscreenElement', {
      configurable: true,
      get() { return fsEl; },
    });
    let exitDelayMs = 0;
    const exit = function() {
      window.__fsExits += 1;
      const finish = () => {
        fsEl = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      if (exitDelayMs <= 0) {
        finish();
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          finish();
          resolve();
        }, exitDelayMs);
      });
    };
    document.exitFullscreen = exit;
    document.webkitExitFullscreen = exit;
    const behavior = ${JSON.stringify(behavior)};
    const installPrefixed = (delayMs, emptyFirst, fireOnAssign) => {
      Element.prototype.requestFullscreen = undefined;
      Element.prototype.webkitRequestFullscreen = function() {
        window.__fsRequests += 1;
        const node = this;
        if (emptyFirst) document.dispatchEvent(new Event('webkitfullscreenchange'));
        setTimeout(() => {
          fsEl = node;
          if (fireOnAssign) document.dispatchEvent(new Event('webkitfullscreenchange'));
        }, delayMs);
      };
    };
    if (behavior === 'webkit-delayed') {
      installPrefixed(200, false, true);
      return;
    }
    if (behavior === 'webkit-late') {
      installPrefixed(700, true, true);
      return;
    }
    if (behavior === 'webkit-late-silent') {
      installPrefixed(700, true, false);
      return;
    }
    if (behavior === 'webkit-late-async-exit') {
      exitDelayMs = 300;
      installPrefixed(700, true, true);
      return;
    }
    if (behavior === 'webkit-after-watch-silent') {
      installPrefixed(1500, true, false);
      return;
    }
    if (behavior === 'succeed-slow-exit') {
      exitDelayMs = 250;
      const impl = function() {
        window.__fsRequests += 1;
        fsEl = this;
        queueMicrotask(() => document.dispatchEvent(new Event('fullscreenchange')));
        return Promise.resolve();
      };
      Element.prototype.requestFullscreen = impl;
      Element.prototype.webkitRequestFullscreen = impl;
      return;
    }
    if (behavior === 'exit-hang') {
      const impl = function() {
        window.__fsRequests += 1;
        fsEl = this;
        queueMicrotask(() => document.dispatchEvent(new Event('fullscreenchange')));
        return Promise.resolve();
      };
      const hangExit = function() {
        window.__fsExits += 1;
        return Promise.resolve();
      };
      document.exitFullscreen = hangExit;
      document.webkitExitFullscreen = hangExit;
      Element.prototype.requestFullscreen = impl;
      Element.prototype.webkitRequestFullscreen = impl;
      return;
    }
    if (behavior === 'exit-silent-clear') {
      const impl = function() {
        window.__fsRequests += 1;
        fsEl = this;
        queueMicrotask(() => document.dispatchEvent(new Event('fullscreenchange')));
        return Promise.resolve();
      };
      const silentExit = function() {
        window.__fsExits += 1;
        setTimeout(() => {
          fsEl = null;
        }, 80);
        return Promise.resolve();
      };
      document.exitFullscreen = silentExit;
      document.webkitExitFullscreen = silentExit;
      Element.prototype.requestFullscreen = impl;
      Element.prototype.webkitRequestFullscreen = impl;
      return;
    }
    if (behavior === 'succeed-then-leave') {
      const impl = function() {
        window.__fsRequests += 1;
        fsEl = this;
        queueMicrotask(() => document.dispatchEvent(new Event('fullscreenchange')));
        setTimeout(() => {
          fsEl = null;
          document.dispatchEvent(new Event('fullscreenchange'));
        }, 120);
        return Promise.resolve();
      };
      Element.prototype.requestFullscreen = impl;
      Element.prototype.webkitRequestFullscreen = impl;
      return;
    }
    if (behavior === 'brief-enter-leave') {
      // Assign synchronously, then leave before adopt can observe the element.
      const impl = function() {
        window.__fsRequests += 1;
        fsEl = this;
        return Promise.resolve().then(() => {
          fsEl = null;
          queueMicrotask(() => document.dispatchEvent(new Event('fullscreenchange')));
        });
      };
      Element.prototype.requestFullscreen = impl;
      Element.prototype.webkitRequestFullscreen = impl;
      return;
    }
    if (behavior === 'async-brief-enter-leave') {
      // Assignment lands after the call returns (standard async FS). Note it
      // on the change event, then leave before overlay grace.
      const impl = function() {
        window.__fsRequests += 1;
        const node = this;
        return Promise.resolve().then(() => {
          fsEl = node;
          document.dispatchEvent(new Event('fullscreenchange'));
          fsEl = null;
          queueMicrotask(() => document.dispatchEvent(new Event('fullscreenchange')));
        });
      };
      Element.prototype.requestFullscreen = impl;
      Element.prototype.webkitRequestFullscreen = impl;
      return;
    }
    const impl = function() {
      window.__fsRequests += 1;
      if (behavior === 'reject') return Promise.reject(new Error('fullscreen denied'));
      if (behavior === 'noop') return Promise.resolve();
      fsEl = this;
      queueMicrotask(() => document.dispatchEvent(new Event('fullscreenchange')));
      return Promise.resolve();
    };
    Element.prototype.requestFullscreen = impl;
    Element.prototype.webkitRequestFullscreen = impl;
  })()`;
  await evaluate(send, script);
}

async function tapVideoCenter(send) {
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-center');
      if (!el) throw new Error('missing .touch-center');
      const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    })()`
  );
}

async function loopAndPlay(send) {
  await evaluate(
    send,
    `(async function(){
      const v = document.querySelector('video');
      v.loop = true;
      v.pause();
      v.currentTime = 0;
      await v.play();
      return true;
    })()`
  );
  await waitFor(send, 'Boolean(document.querySelector("video") && !document.querySelector("video").paused)');
}

async function clickFullscreen(send) {
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  // Wait until native was attempted and either overlay fallback or native FS
  // landed. Do not require is-fullscreen during the wait (captain decision B).
  await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      if (!el) return false;
      if ((window.__fsRequests ?? 0) < 1) return false;
      return el.classList.contains('is-fake-fullscreen')
        || (document.fullscreenElement || document.webkitFullscreenElement) === el;
    })()`
  );
}

async function openPlayer(t, viewport, { phone = true, playPath = PLAY_PATH, blockAutoplay = false } = {}) {
  const { baseUrl } = await startServer(t);
  const cookie = await loginCookie(baseUrl);
  const { send } = await openChrome(t, { touch: phone });
  if (phone) await setPhoneViewport(send, viewport);
  else await setDesktopViewport(send, viewport);
  await send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    url: baseUrl,
    httpOnly: true,
    path: '/',
  });
  if (blockAutoplay) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        HTMLMediaElement.prototype.play = function() {
          this.pause();
          return Promise.reject(Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' }));
        };
      })();`,
    });
  }
  await send('Page.navigate', { url: `${baseUrl}/#/lukluk/play/${encodeURIComponent(playPath)}` });
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
  toolbarPlay: Boolean(document.querySelector('.control-bar .ctl-play')) ||
    Boolean(document.querySelector('.control-bar [aria-label="Lire"], .control-bar [aria-label="Pause"]')),
  centerPlay: (() => {
    const el = document.querySelector('.center-play');
    return Boolean(el) && !el.hidden;
  })(),
  centerPlayTag: document.querySelector('.center-play')?.tagName ?? null,
  centerPlayLabel: document.querySelector('.center-play')?.getAttribute('aria-label') ?? null,
  centerPlayAriaHidden: document.querySelector('.center-play')?.getAttribute('aria-hidden') ?? null,
  centerPlayPointerEvents: (() => {
    const el = document.querySelector('.center-play');
    if (!el || el.hidden) return null;
    return getComputedStyle(el).pointerEvents;
  })(),
  endOverlay: (() => {
    const el = document.querySelector('.next-overlay');
    return Boolean(el) && !el.hidden && el.classList.contains('is-end');
  })(),
  paused: document.querySelector('video')?.paused ?? null,
  fs: document.querySelector('.player-container')?.classList.contains('is-fullscreen') ?? false,
  fakeFs: document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') ?? false,
  forcedLandscape: document.querySelector('.player-container')?.classList.contains('is-forced-landscape') ?? false,
  nativeFs: (() => {
    const el = document.querySelector('.player-container');
    return (document.fullscreenElement || document.webkitFullscreenElement) === el;
  })(),
  htmlFs: document.documentElement.classList.contains('player-fs'),
  fsLabel: document.querySelector('.player-container button[aria-label="Plein écran"], .player-container button[aria-label="Quitter le plein écran"]')?.getAttribute('aria-label') ?? null,
  fsRequests: window.__fsRequests ?? 0,
  fsExits: window.__fsExits ?? 0,
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

uiTest('player UI on a smartphone portrait viewport', async (t) => {
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
  assert.equal(ui.toolbarPlay, false, 'play/pause must not live on the bottom toolbar');
  assert.ok(ui.bar, 'control bar is present');
  assert.equal(ui.bar.nextVisible, true, 'next-episode control should be present for wrap check');
  assert.equal(ui.bar.stacked, false, 'toolbar children stacked onto a second line');
  assert.ok(ui.bar.wrap < 8, `toolbar wrapped by ${ui.bar.wrap}px`);
  assert.ok(ui.bar.height < 72, `toolbar height ${ui.bar.height} looks like two rows`);
  assert.ok(ui.bar.width <= ui.viewport.w + 1);

  await installFullscreenStub(send, 'reject');
  await clickFullscreen(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, `native Fullscreen API must be attempted first, got ${ui.fsRequests}`);
  assert.equal(ui.nativeFs, false, 'rejected native request must not report a fullscreen element');
  assert.equal(ui.fs, true, `expected fullscreen class, got ${JSON.stringify(ui)}`);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.forcedLandscape, true);
  assert.ok(ui.player.w > ui.viewport.w * 0.9, `fullscreen width ${ui.player.w} vs viewport ${ui.viewport.w}`);
  assert.ok(ui.player.h > ui.viewport.h * 0.9, `fullscreen height ${ui.player.h} vs viewport ${ui.viewport.h}`);
  // Long edge of the phone is the landscape width of the rotated player.
  const longEdge = Math.max(ui.player.w, ui.player.h);
  assert.ok(longEdge > 800, `expected landscape span, got ${longEdge}`);
});

uiTest('player UI on a smartphone landscape viewport', async (t) => {
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
  await installFullscreenStub(send, 'reject');
  await clickFullscreen(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, `native Fullscreen API must be attempted first, got ${ui.fsRequests}`);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, true, `expected fullscreen class, got ${JSON.stringify(ui)}`);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.forcedLandscape, false, 'already landscape: do not rotate again');
  assert.ok(Math.abs(ui.player.w - ui.viewport.w) < 8, `fs width ${ui.player.w} vs ${ui.viewport.w}`);
  assert.ok(Math.abs(ui.player.h - ui.viewport.h) < 8, `fs height ${ui.player.h} vs ${ui.viewport.h}`);
  assert.ok(ui.player.w > ui.player.h, 'landscape fullscreen is wider than it is tall');
});

uiTest('player overlay hide delay, pause-on-tap and resume-on-tap', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.toolbarPlay, false, 'no play/pause control on the bottom toolbar');

  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await new Promise((r) => setTimeout(r, 1500));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false);
  assert.equal(ui.controlsVisible, true, 'toolbar must stay visible before the 2s hide delay');
  assert.equal(ui.centerPlay, false, 'center play icon is hidden while playing');
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    1500
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'toolbar auto-hides 2s after playback starts');
  assert.equal(ui.paused, false);

  await tapVideoCenter(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'surface tap pauses immediately, without a double-tap delay');
  assert.equal(ui.controlsVisible, true, 'tap on playing video shows the toolbar');
  assert.equal(ui.centerPlay, true, 'paused state shows the center play icon');
  assert.equal(ui.centerPlayTag, 'BUTTON', 'center play must be a real button');
  assert.equal(ui.centerPlayLabel, 'Lire', 'center play must have an accessible name');
  assert.equal(ui.centerPlayAriaHidden, null, 'center play must not be aria-hidden');
  assert.notEqual(ui.centerPlayPointerEvents, 'none', 'center play must receive pointer events');
  assert.equal(ui.toolbarPlay, false);

  await tapVideoCenter(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false, 'surface tap on paused video resumes immediately');
  assert.equal(ui.centerPlay, false, 'center play icon hides once playing');
  assert.equal(ui.controlsVisible, true, 'toolbar is shown on resume');
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'toolbar fades 2s after resume');
  assert.equal(ui.paused, false);
});

uiTest('hold-to-seek on a side third does not show the center play icon', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-left');
      if (!el) throw new Error('missing .touch-left');
      const opts = { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
    })()`
  );
  await new Promise((r) => setTimeout(r, 700));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'hold-to-seek pauses the video');
  assert.equal(ui.centerPlay, false, 'center play must stay hidden for the whole hold');
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-left');
      const opts = { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    })()`
  );
  await waitFor(send, 'Boolean(document.querySelector("video") && !document.querySelector("video").paused)');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false);
  assert.equal(ui.centerPlay, false, 'center play hides again once playback resumes');
});

uiTest('hold-to-seek shows center play if resume play is blocked', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-left');
      const opts = { bubbles: true, cancelable: true, pointerId: 12, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
    })()`
  );
  await new Promise((r) => setTimeout(r, 700));
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      v.play = function() {
        this.pause();
        return Promise.reject(Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' }));
      };
      const el = document.querySelector('.touch-left');
      const opts = { bubbles: true, cancelable: true, pointerId: 12, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    })()`
  );
  await waitFor(
    send,
    `(function(){
      const v = document.querySelector('video');
      const b = document.querySelector('button.center-play');
      return Boolean(v?.paused && b && !b.hidden);
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'blocked play after hold must leave the video paused');
  assert.equal(ui.centerPlay, true, 'named play control must reappear if hold-resume play is blocked');
});

uiTest('mouse move reveals a hidden toolbar', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false);
  assert.equal(ui.paused, false);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      el.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
      }));
    })()`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'mouse pointermove must reveal a hidden toolbar');
  assert.equal(ui.paused, false, 'revealing the bar with the mouse must not pause playback');
});

uiTest('hovering the control bar holds it visible and clicks hit controls', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  const box = await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.control-bar [aria-label="Couper le son"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`
  );
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      bar.dispatchEvent(new PointerEvent('pointerenter', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
      }));
    })()`
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'bar must not time-hide under the cursor');
  assert.equal(ui.paused, false);
  const mutedBefore = await evaluate(send, 'Boolean(document.querySelector("video")?.muted)');
  assert.equal(mutedBefore, false);
  await clickAt(send, box.x, box.y);
  ui = await evaluate(send, SNAPSHOT);
  const mutedAfter = await evaluate(send, 'Boolean(document.querySelector("video")?.muted)');
  assert.equal(ui.paused, false, 'click on a bar control must not click-through to pause the surface');
  assert.equal(mutedAfter, true, 'click at the control coordinates must hit mute, not the video');
  assert.equal(ui.controlsVisible, true);
});

uiTest('leaving the control bar resumes auto-hide', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      bar.dispatchEvent(new PointerEvent('pointerenter', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
      }));
    })()`
  );
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'hover must keep the bar up past the 2s timer');
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      bar.dispatchEvent(new PointerEvent('pointerleave', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
      }));
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'pointerleave must restart the 2s auto-hide');
  assert.equal(ui.paused, false);
});

uiTest('using the control bar refreshes the auto-hide timer', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await new Promise((r) => setTimeout(r, 1200));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'bar still visible before the 2s hide');
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      bar.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch',
      }));
    })()`
  );
  await new Promise((r) => setTimeout(r, 1500));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'pointerdown on the bar must reset the 2s auto-hide');
  assert.equal(ui.paused, false);
});

uiTest('a stationary finger on the control bar holds it visible', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      bar.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 4,
        pointerType: 'touch',
      }));
    })()`
  );
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'active pointer on the bar must not time-hide under the finger');
  assert.equal(ui.paused, false);
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      bar.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId: 4,
        pointerType: 'touch',
      }));
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'pointerup must restart the 2s auto-hide');
  assert.equal(ui.paused, false);
});

uiTest('pointerup outside the control bar still releases the auto-hide hold', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      bar.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: 'touch',
      }));
    })()`
  );
  await evaluate(
    send,
    `(function(){
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: 'touch',
      }));
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'release outside the bar must not leak the pointer hold');
  assert.equal(ui.paused, false);
});

uiTest('touch pointermove on the bar during a scrub keeps it visible', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await new Promise((r) => setTimeout(r, 1200));
  await evaluate(
    send,
    `(function(){
      const progress = document.querySelector('.progress');
      const opts = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', buttons: 1 };
      progress.dispatchEvent(new PointerEvent('pointerdown', opts));
      progress.dispatchEvent(new PointerEvent('pointermove', opts));
    })()`
  );
  await new Promise((r) => setTimeout(r, 1500));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'captured touch pointermove on the bar must reset auto-hide');
  assert.equal(ui.paused, false);
});

uiTest('keydown on a focused bar control refreshes auto-hide', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await evaluate(send, 'document.querySelector(".progress").focus()');
  await new Promise((r) => setTimeout(r, 1200));
  await evaluate(
    send,
    `(function(){
      const progress = document.querySelector('.progress');
      progress.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));
    })()`
  );
  await new Promise((r) => setTimeout(r, 1500));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'keydown while a bar control is focused must reset auto-hide');
  assert.equal(ui.paused, false);
});

uiTest('keyboard focus on the control bar holds it visible', async (t) => {
  // Landscape so .speed is displayed (hidden under 640px portrait).
  const { send } = await openPlayer(t, { width: 844, height: 390, landscape: true });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  const speedShown = await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.speed');
      if (!el) return false;
      return getComputedStyle(el).display !== 'none';
    })()`
  );
  assert.equal(speedShown, true, 'speed select must be visible so it can take focus');
  await evaluate(send, 'document.querySelector(".speed").focus()');
  const focused = await evaluate(send, 'document.activeElement?.classList.contains("speed") === true');
  assert.equal(focused, true);
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'focused speed select must not time-hide the bar');
  assert.equal(ui.paused, false);
  await evaluate(send, 'document.querySelector(".speed").blur()');
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'blurring the bar control must restart auto-hide');
});

uiTest('hiding the toolbar blurs bar controls so Space pauses', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed');
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await evaluate(
    send,
    `(function(){
      const btn = document.querySelector('.player-container button[aria-label="Plein écran"]');
      if (!btn) throw new Error('missing fullscreen button');
      btn.focus();
    })()`
  );
  let focused = await evaluate(
    send,
    'document.activeElement?.getAttribute("aria-label") === "Plein écran"'
  );
  assert.equal(focused, true);
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'focus on a bar control must hold the bar visible');
  await evaluate(
    send,
    `(function(){
      const btn = document.querySelector('.player-container button[aria-label="Plein écran"]');
      if (btn) btn.blur();
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  focused = await evaluate(
    send,
    'document.activeElement && document.querySelector(".control-bar")?.contains(document.activeElement)'
  );
  assert.equal(focused, false, 'inert hidden bar must not keep focus');
  const inert = await evaluate(send, 'Boolean(document.querySelector(".control-bar")?.inert)');
  assert.equal(inert, true, 'hidden bar must be inert so it leaves the tab order');
  const canFocusHidden = await evaluate(
    send,
    `(function(){
      const btn = document.querySelector('.player-container button[aria-label="Plein écran"]');
      btn.focus();
      return document.activeElement === btn;
    })()`
  );
  assert.equal(canFocusHidden, false, 'inert bar controls must not take focus');
  await evaluate(
    send,
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'Space after hide must pause, not activate the hidden fullscreen button');
  assert.equal(ui.fsRequests, 0, 'Space must not fire the off-screen fullscreen control');
  assert.equal(ui.fs, false);
  assert.equal(ui.nativeFs, false);
});

uiTest('rapid fullscreen re-enter ignores a leftover native leave', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed-slow-exit');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true);
  await tapSelector(send, 'button[aria-label="Quitter le plein écran"]');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      const native = (document.fullscreenElement || document.webkitFullscreenElement) === el;
      return native
        && el.classList.contains('is-fullscreen')
        && !el.classList.contains('is-fake-fullscreen')
        && (window.__fsRequests ?? 0) >= 2;
    })()`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'after leftover native leaves, re-request must adopt native');
  assert.equal(ui.fakeFs, false, 'rapid re-enter must not drop to overlay');
  assert.equal(ui.fs, true);
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
  assert.equal(ui.fsRequests, 2, 'leftover leave must issue exactly one new native request');
});

uiTest('second fullscreen toggle during leftover wait exits native', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed-slow-exit');
  await clickFullscreen(send);
  await tapSelector(send, 'button[aria-label="Quitter le plein écran"]');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'leftover native is still on screen during leftover wait');
  assert.equal(ui.fs, false, 'leftover wait has not adopted native yet');
  assert.equal(ui.fsRequests, 1, 'leftover enter must not re-request while native is still assigned');
  assert.equal(ui.fsLabel, 'Quitter le plein écran', 'leftover wait must offer exit, not a second enter');
  await tapSelector(send, 'button[aria-label="Quitter le plein écran"]');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'second toggle during leftover wait must exit');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, 'Plein écran');
  await new Promise((r) => setTimeout(r, 400));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'leftover bound must not overlay after the user exited');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.htmlFs, false);
});

uiTest('leftover timer resumes native if leftover already left', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'exit-silent-clear');
  await clickFullscreen(send);
  // Pause leftover rAF so a silent leftover leave is only seen by the 400ms
  // bound — background tabs pause rAF the same way.
  await evaluate(send, 'window.requestAnimationFrame = function() { return 0; }');
  await tapSelector(send, 'button[aria-label="Quitter le plein écran"]');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      const native = (document.fullscreenElement || document.webkitFullscreenElement) === el;
      return native
        && el.classList.contains('is-fullscreen')
        && !el.classList.contains('is-fake-fullscreen')
        && (window.__fsRequests ?? 0) >= 2;
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'leftover timer must resume native after a silent leftover leave');
  assert.equal(ui.fakeFs, false, 'cleared leftover must not apply overlay');
  assert.equal(ui.fs, true);
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
  assert.equal(ui.fsRequests, 2);
});

uiTest('hung leftover native exit falls back to overlay instead of stalling', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'exit-hang');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true);
  await tapSelector(send, 'button[aria-label="Quitter le plein écran"]');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  // Poll-only dismiss would wait 50ms; freeze setInterval so only the
  // immediate overlay-apply tick can call exitFullscreen.
  await evaluate(send, 'window.setInterval = function() { return 0; }');
  await waitFor(
    send,
    `document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') === true`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true, 'hung leftover native must not stall waitingNativeFs forever');
  assert.equal(ui.fs, true);
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
  assert.ok(
    ui.fsExits >= 2,
    'overlay must dismiss leftover native immediately, not on the first 50ms poll'
  );
  await tapSelector(send, 'button[aria-label="Quitter le plein écran"]');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'after leftover overlay, toggle must be able to exit');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.fsLabel, 'Plein écran');
});

uiTest('video surface double-tap does not toggle fullscreen', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed');
  await loopAndPlay(send);
  await tapVideoCenter(send);
  await tapVideoCenter(send);
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fsRequests, 0, 'double-tap on the video surface must not request fullscreen');
  assert.equal(ui.fs, false);
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.htmlFs, false);
});

uiTest('center play button is named and usable by click and keyboard', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await tapVideoCenter(send);
  await waitFor(send, 'document.querySelector("video")?.paused === true');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.centerPlay, true);
  assert.equal(ui.centerPlayTag, 'BUTTON');
  assert.equal(ui.centerPlayLabel, 'Lire');
  assert.equal(ui.centerPlayAriaHidden, null);
  assert.notEqual(ui.centerPlayPointerEvents, 'none');
  assert.equal(ui.toolbarPlay, false, 'play/pause must not live on the bottom toolbar');

  await clickSelector(send, 'button.center-play');
  await waitFor(send, 'document.querySelector("video") && !document.querySelector("video").paused');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false, 'clicking the center play button resumes playback');
  assert.equal(ui.centerPlay, false);

  await tapVideoCenter(send);
  await waitFor(send, 'document.querySelector("video")?.paused === true');
  await evaluate(send, 'document.querySelector("button.center-play").focus()');
  const active = await evaluate(send, 'document.activeElement?.classList.contains("center-play") === true');
  assert.equal(active, true, 'center play button is focusable');
  await evaluate(
    send,
    `(function(){
      const b = document.querySelector('button.center-play');
      b.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
    })()`
  );
  await waitFor(send, 'document.querySelector("video") && !document.querySelector("video").paused');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false, 'keyboard activation of the center play button resumes playback');
  assert.equal(ui.centerPlay, false);
});

uiTest('center play button is shown when autoplay is blocked', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { blockAutoplay: true }
  );
  await waitFor(send, 'Boolean(document.querySelector("button.center-play"))');
  await waitFor(
    send,
    `(() => {
      const v = document.querySelector('video');
      const b = document.querySelector('button.center-play');
      return Boolean(v?.paused && b && !b.hidden);
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'blocked autoplay leaves the video paused');
  assert.equal(ui.centerPlay, true, 'named play control must be visible before metadata/play');
  assert.equal(ui.centerPlayTag, 'BUTTON');
  assert.equal(ui.centerPlayLabel, 'Lire');
  assert.equal(ui.centerPlayAriaHidden, null);
  assert.notEqual(ui.centerPlayPointerEvents, 'none');
});

uiTest('native fullscreen is used on a portrait phone when the API works', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed');
  await clickFullscreen(send);
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, `native Fullscreen API must be attempted first, got ${ui.fsRequests}`);
  assert.equal(ui.nativeFs, true);
  assert.equal(ui.fs, true);
  assert.equal(ui.fakeFs, false, 'successful native fullscreen must not use the CSS overlay');
  assert.equal(ui.forcedLandscape, false, 'do not CSS-rotate native fullscreen in portrait');
});

uiTest('overlay fallback when native fullscreen is a no-op', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'noop');
  await clickFullscreen(send);
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, `native Fullscreen API must be attempted first, got ${ui.fsRequests}`);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, true, 'is-fullscreen applies after overlay fallback');
  assert.equal(ui.fakeFs, true, 'no-op native request must fall back to the CSS overlay');
  assert.equal(ui.forcedLandscape, true, 'portrait fake-fullscreen rotates onto the long edge');
  const longEdge = Math.max(ui.player.w, ui.player.h);
  assert.ok(longEdge > 800, `expected landscape span, got ${longEdge}`);
});

uiTest('second fullscreen tap during native wait does not abort overlay fallback', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'noop');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }))`
  );
  await waitFor(
    send,
    `document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') === true`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true, 'impatient second activation must not cancel overlay fallback');
  assert.equal(ui.fs, true);
  assert.equal(ui.htmlFs, true);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
});

uiTest('delayed webkit fullscreen is not treated as a no-op', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-delayed');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await new Promise((r) => setTimeout(r, 50));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'is-fullscreen must not apply during the native wait');
  assert.equal(ui.htmlFs, false, 'player-fs must not apply during the native wait');
  assert.equal(ui.fakeFs, false, 'must not overlay before delayed webkitFullscreenElement is assigned');
  assert.equal(ui.forcedLandscape, false, 'must not rotate during the native wait');
  assert.equal(ui.nativeFs, false, 'webkit assignment is still pending');
  assert.equal(ui.fsLabel, 'Plein écran', 'do not claim fullscreen until native or overlay lands');
  await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      return (document.fullscreenElement || document.webkitFullscreenElement) === el;
    })()`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1);
  assert.equal(ui.nativeFs, true);
  assert.equal(ui.fs, true, 'is-fullscreen applies after native success');
  assert.equal(ui.fakeFs, false, 'late webkit fullscreen must not keep the CSS overlay');
  assert.equal(ui.forcedLandscape, false, 'do not CSS-rotate native fullscreen in portrait');
});

uiTest('late native fullscreen does not override overlay fallback', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-late');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(
    send,
    `document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') === true`
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1);
  assert.equal(ui.fakeFs, true, 'grace timeout applies overlay before a very late native assign');
  assert.equal(ui.fs, true, 'is-fullscreen applies after overlay fallback');
  assert.equal(ui.nativeFs, false);
  await waitFor(send, '(window.__fsExits ?? 0) >= 1');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true, 'stay overlay; do not snap to native after grace');
  assert.equal(ui.fs, true);
  assert.equal(ui.htmlFs, true);
  assert.equal(ui.nativeFs, false, 'late native under overlay must be cancelled');
  assert.ok(ui.fsExits >= 1, 'late native under overlay must call exitFullscreen');
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
  assert.equal(ui.forcedLandscape, true, 'phone overlay in portrait keeps forced landscape');
});

uiTest('async exit under overlay keeps rotate and does not re-exit', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-late-async-exit');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(
    send,
    `document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') === true`
  );
  await waitFor(send, '(window.__fsExits ?? 0) >= 1');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true, 'overlay stays while async exitFullscreen is in flight');
  assert.equal(ui.forcedLandscape, true, 'must not drop rotate/chrome while native is still assigned');
  assert.equal(ui.htmlFs, true);
  assert.equal(ui.fsExits, 1, 'must not re-call exitFullscreen every watch tick');
  await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      return (document.fullscreenElement || document.webkitFullscreenElement) !== el;
    })()`
  );
  await new Promise((r) => setTimeout(r, 400));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.forcedLandscape, true);
  assert.equal(ui.fsExits, 1, 'watch must not hammer exitFullscreen after the first dismiss');
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
});

uiTest('silent native assign after the 900ms watch cap is still cancelled', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-after-watch-silent');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(
    send,
    `document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') === true`
  );
  await new Promise((r) => setTimeout(r, 600));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.nativeFs, false, '900ms wait-watch cap must not leave native sitting under overlay yet');
  assert.equal(ui.fsExits, 0, 'no native assign yet, so no exit');
  await waitFor(send, '(window.__fsExits ?? 0) >= 1');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true, 'stay overlay after a silent assign past the 900ms cap');
  assert.equal(ui.forcedLandscape, true);
  assert.equal(ui.nativeFs, false, 'overlay watch must still dismiss silent native after 900ms');
  assert.ok(ui.fsExits >= 1);
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
});

uiTest('silent late webkit assign does not snap overlay to native', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-late-silent');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(
    send,
    `document.querySelector('.player-container')?.classList.contains('is-fake-fullscreen') === true`
  );
  await waitFor(send, '(window.__fsExits ?? 0) >= 1');
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true, 'watch must not strip overlay after grace for a silent late assign');
  assert.equal(ui.forcedLandscape, true);
  assert.equal(ui.fs, true);
  assert.equal(ui.htmlFs, true);
  assert.equal(ui.nativeFs, false, 'silent late native under overlay must be cancelled');
  assert.ok(ui.fsExits >= 1, 'silent late native under overlay must call exitFullscreen');
  assert.equal(ui.fsLabel, 'Quitter le plein écran');
});

uiTest('exiting during the grace window aborts a late native enter', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-delayed');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, 'Plein écran');
  await waitFor(send, '(window.__fsExits ?? 0) >= 1');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, false, 'late native enter after cancel must be exited');
  assert.equal(ui.fs, false);
  assert.equal(ui.htmlFs, false, 'player-fs must not return after cancel');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.fsLabel, 'Plein écran');
  assert.ok(ui.fsExits >= 1);
});

uiTest('system leave during grace does not apply overlay fallback', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed-then-leave');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      return (document.fullscreenElement || document.webkitFullscreenElement) === el;
    })()`
  );
  await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      const native = (document.fullscreenElement || document.webkitFullscreenElement) === el;
      return !native && !el.classList.contains('is-fullscreen') && !el.classList.contains('is-fake-fullscreen');
    })()`
  );
  await new Promise((r) => setTimeout(r, 450));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, false);
  assert.equal(ui.fakeFs, false, 'system leave during grace must not apply overlay');
  assert.equal(ui.forcedLandscape, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, 'Plein écran');
});

uiTest('brief native enter then leave during wait does not apply overlay', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'brief-enter-leave');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await new Promise((r) => setTimeout(r, 450));
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, false, 'must not stay in is-fullscreen after a leave during wait');
  assert.equal(ui.fakeFs, false, 'leave during wait must not apply overlay after grace');
  assert.equal(ui.forcedLandscape, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, 'Plein écran');
});

uiTest('async native enter then leave during wait does not apply overlay', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'async-brief-enter-leave');
  await tapSelector(send, 'button[aria-label="Plein écran"]');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await new Promise((r) => setTimeout(r, 450));
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, false, 'must not stay in is-fullscreen after an async leave during wait');
  assert.equal(ui.fakeFs, false, 'async leave during wait must not apply overlay after grace');
  assert.equal(ui.forcedLandscape, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, 'Plein écran');
});

uiTest('center tap does not play while the series-end overlay is showing', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false }, { playPath: 'Serie/e02.mp4' });
  await waitFor(send, 'Boolean(document.querySelector("video"))');
  await evaluate(
    send,
    `(async function(){
      const v = document.querySelector('video');
      v.muted = true;
      await new Promise((r) => {
        if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0) return r();
        v.addEventListener('loadedmetadata', r, { once: true });
      });
      v.currentTime = Math.max(0, v.duration - 0.05);
      await v.play().catch(() => {});
      return true;
    })()`
  );
  await waitFor(
    send,
    `(() => {
      const el = document.querySelector('.next-overlay');
      return Boolean(el) && !el.hidden && el.classList.contains('is-end');
    })()`
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.endOverlay, true, 'last episode must show the series-end overlay');
  assert.equal(ui.paused, true);
  assert.equal(ui.centerPlay, false, 'center play icon stays hidden behind the end overlay');

  await tapVideoCenter(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'center tap must not call play while is-end is showing');
  assert.equal(ui.endOverlay, true, 'end overlay must stay up; tap is not replay');
  assert.equal(ui.centerPlay, false);
});

uiTest('narrow desktop window still tries native fullscreen', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  const before = await evaluate(
    send,
    `({
      w: window.innerWidth,
      h: window.innerHeight,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      portrait: window.matchMedia('(orientation: portrait)').matches,
    })`
  );
  assert.equal(before.w, 500);
  assert.equal(before.h, 800);
  assert.equal(before.coarse, false, 'desktop viewport must not be treated as a coarse-pointer phone');
  assert.equal(before.portrait, true);

  await installFullscreenStub(send, 'succeed');
  await clickFullscreen(send);
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, `native Fullscreen API must be attempted first, got ${ui.fsRequests}`);
  assert.equal(ui.nativeFs, true);
  assert.equal(ui.fakeFs, false, 'a merely narrow desktop window must not skip native fullscreen');
  assert.equal(ui.forcedLandscape, false, 'native fullscreen must not CSS-rotate in portrait');
});

uiTest('narrow desktop overlay fallback does not CSS-rotate', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  const before = await evaluate(
    send,
    `({
      w: window.innerWidth,
      h: window.innerHeight,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      portrait: window.matchMedia('(orientation: portrait)').matches,
    })`
  );
  assert.equal(before.w, 500);
  assert.equal(before.h, 800);
  assert.equal(before.coarse, false, 'desktop viewport must not be treated as a coarse-pointer phone');
  assert.equal(before.portrait, true);

  await installFullscreenStub(send, 'reject');
  await clickFullscreen(send);
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, `native Fullscreen API must be attempted first, got ${ui.fsRequests}`);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, true, 'overlay still applies when native fullscreen fails on desktop');
  assert.equal(ui.fakeFs, true, 'reject on desktop must use the CSS overlay');
  assert.equal(ui.htmlFs, true);
  assert.equal(ui.forcedLandscape, false, 'a tall/narrow desktop window must not CSS-rotate');
  assert.ok(Math.abs(ui.player.w - ui.viewport.w) < 8, `overlay width ${ui.player.w} vs ${ui.viewport.w}`);
  assert.ok(Math.abs(ui.player.h - ui.viewport.h) < 8, `overlay height ${ui.player.h} vs ${ui.viewport.h}`);
  assert.ok(ui.player.h > ui.player.w, 'desktop overlay stays portrait, not rotated onto the long edge');
});
