// Shared browser E2E harness: ephemeral Sanem server with a seeded probe cache,
// system Chrome driven over the DevTools protocol, and the small evaluate /
// waitFor / click helpers the UI suites are written against. Extracted so the
// player and library suites drive the same browser plumbing (no npm dep).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CENTER_DBLCLICK_MS } from '../../public/player.js';

const PASSWORD = 'integration-test-password';
const SESSION_SECRET = 'integration-test-session-secret-at-least-32-chars';
const CLIP = path.join(import.meta.dirname, '..', 'fixtures', 'clip.mp4');
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

async function seedMedia(dataDir, rel, playback, extras = {}) {
  const abs = path.join(dataDir, 'uploads', ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.copyFile(CLIP, abs);
  const stats = await fs.stat(abs);
  const hash = crypto.createHash('sha256').update(rel).digest('hex');
  const cacheDir = path.join(dataDir, 'transcode', hash);
  await fs.mkdir(cacheDir, { recursive: true });
  const pb = extras.playback ?? playback;
  const heavy = Boolean(extras.heavy);
  await fs.writeFile(
    path.join(cacheDir, 'probe.json'),
    JSON.stringify({
      relativePath: rel,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      info: {
        kind: 'video',
        playback: pb,
        lane: heavy ? 3 : pb === 'direct' ? 0 : 1,
        duration: 2,
        width: heavy ? 3840 : 320,
        height: heavy ? 2160 : 180,
        vcodec: 'h264',
        acodec: 'aac',
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        heavy,
        internalSubtitles: 0,
      },
    })
  );
}

async function startServer(t, { playback = 'direct', extraFiles = [], fileMeta = {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sanem-player-ui-'));
  await fs.mkdir(path.join(dataDir, 'uploads', 'Serie'), { recursive: true });
  for (const name of ['e01.mp4', 'e02.mp4']) {
    const rel = `Serie/${name}`;
    await seedMedia(dataDir, rel, playback, fileMeta[rel] || {});
  }
  for (const rel of extraFiles) {
    await seedMedia(dataDir, rel, playback, fileMeta[rel] || {});
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = path.join(import.meta.dirname, '..', '..', 'src', 'server.js');
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

async function tapVideoCenter(send, pointerType = 'touch') {
  const pt = JSON.stringify(pointerType);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-center');
      if (!el) throw new Error('missing .touch-center');
      const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: ${pt} };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    })()`
  );
}

async function doubleTapVideoCenter(send, pointerType = 'touch') {
  const pt = JSON.stringify(pointerType);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-center');
      if (!el) throw new Error('missing .touch-center');
      const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: ${pt} };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      if (${pt} === 'mouse') {
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      }
    })()`
  );
}

function waitForCenterTapDelay() {
  return new Promise((r) => setTimeout(r, CENTER_DBLCLICK_MS + 80));
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

/** Override media duration/time so next-up can be tested on the ~2s fixture. */
async function fakeDurationAndTime(send, duration, currentTime) {
  const d = Number(duration);
  const t0 = Number(currentTime);
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      let t = ${t0};
      Object.defineProperty(v, 'duration', { configurable: true, get() { return ${d}; } });
      Object.defineProperty(v, 'currentTime', {
        configurable: true,
        get() { return t; },
        set(n) { t = n; },
      });
      v.dispatchEvent(new Event('timeupdate'));
      v.dispatchEvent(new Event('seeked'));
      return true;
    })()`
  );
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

function remotePlaybackStubSource(options = {}) {
  return `(function(){
    const opts = ${JSON.stringify({
      hasRemote: true,
      available: true,
      state: 'disconnected',
      watchReject: false,
      watchRejectDelayMs: 0,
      promptReject: false,
      promptRejectWhenLive: false,
      promptDismiss: false,
      ...options,
    })};
    window.__remotePrompts = 0;
    window.__remoteWatchCalls = 0;
    window.__remoteCancels = 0;
    window.__remoteFakes = [];
    window.__setRemoteAvailable = (available) => {
      for (const remote of window.__remoteFakes) {
        for (const cb of remote._cbs) cb(Boolean(available));
      }
    };
    const remotes = new WeakMap();
    class FakeRemote extends EventTarget {
      constructor() {
        super();
        this.state = opts.state;
        this._cbs = [];
        window.__remoteFakes.push(this);
      }
      watchAvailability(cb) {
        window.__remoteWatchCalls += 1;
        if (opts.watchReject) {
          const err = Object.assign(new Error('NotSupportedError'), { name: 'NotSupportedError' });
          const delay = Number(opts.watchRejectDelayMs) || 0;
          if (delay <= 0) return Promise.reject(err);
          return new Promise((_, reject) => {
            setTimeout(() => reject(err), delay);
          });
        }
        this._cbs.push(cb);
        queueMicrotask(() => cb(Boolean(opts.available)));
        return Promise.resolve(1);
      }
      cancelWatchAvailability() {
        this._cbs = [];
        return Promise.resolve();
      }
      prompt() {
        window.__remotePrompts += 1;
        if (opts.promptReject) {
          return Promise.reject(Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' }));
        }
        if (opts.promptRejectWhenLive && (this.state === 'connected' || this.state === 'connecting')) {
          // Picker cancel while live: reject, leave state unchanged, no statechange.
          return Promise.reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
        }
        if (opts.promptDismiss) {
          // Picker dismissed: promise fulfills, state stays disconnected,
          // no statechange (the UA path this stub models).
          return Promise.resolve();
        }
        if (this.state === 'disconnected') this.state = 'connected';
        else this.state = 'disconnected';
        this.dispatchEvent(new Event('statechange'));
        return Promise.resolve();
      }
      cancel() {
        window.__remoteCancels += 1;
        if (this.state === 'disconnected') return Promise.resolve();
        this.state = 'disconnected';
        this.dispatchEvent(new Event('statechange'));
        return Promise.resolve();
      }
    }
    Object.defineProperty(HTMLVideoElement.prototype, 'remote', {
      configurable: true,
      get() {
        if (!opts.hasRemote) return undefined;
        let remote = remotes.get(this);
        if (!remote) {
          remote = new FakeRemote();
          remotes.set(this, remote);
        }
        return remote;
      },
    });
  })();`;
}


export {
  PASSWORD,
  SESSION_SECRET,
  CLIP,
  PLAY_PATH,
  chromePath,
  HAS_CHROME,
  uiTest,
  getFreePort,
  waitForHttp,
  startServer,
  loginCookie,
  openChrome,
  setDesktopViewport,
  setPhoneViewport,
  evaluate,
  waitFor,
  clickSelector,
  clickAt,
  remotePlaybackStubSource,
  tapSelector,
  installFullscreenStub,
  tapVideoCenter,
  doubleTapVideoCenter,
  waitForCenterTapDelay,
  loopAndPlay,
  fakeDurationAndTime,
  clickFullscreen,
};
