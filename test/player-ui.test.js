// Browser E2E for the Lukluk player chrome (smartphone overlay + fullscreen).
// Uses the system Chromium/Chrome via the DevTools protocol so we do not add
// an npm dependency. The tiny H.264/AAC fixture is committed; ffprobe is
// not required because the probe cache is seeded before the server starts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isAllowedCastSrc,
  shouldShowNextEpisode,
  NEXT_UP_LEAD_S,
  EPISODE_BADGE_MS,
  episodeLabel,
} from '../public/player.js';
import {
  PLAY_PATH,
  uiTest,
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
} from './helpers/browser.js';

async function openPlayer(
  t,
  viewport,
  {
    phone = true,
    playPath = PLAY_PATH,
    blockAutoplay = false,
    remotePlayback,
    playback = 'direct',
    hlsMode,
    failCastUrl = false,
    slowCastUrlMs = 0,
    spoofCastUrl,
  } = {}
) {
  const { baseUrl } = await startServer(t, { playback });
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
  if (remotePlayback) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: remotePlaybackStubSource(remotePlayback),
    });
  }
  if (hlsMode === 'mse' || hlsMode === 'native') {
    const native = hlsMode === 'native';
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        const orig = HTMLVideoElement.prototype.canPlayType;
        HTMLVideoElement.prototype.canPlayType = function(type) {
          if (/mpegurl/i.test(String(type))) return ${native ? "'maybe'" : "''"};
          return orig.call(this, type);
        };
      })();`,
    });
  }
  if (failCastUrl) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        const orig = window.fetch.bind(window);
        window.fetch = function(input, init) {
          const url = String(input);
          if (url.includes('/api/cast-url')) {
            return Promise.resolve(new Response('{"error":"fail"}', {
              status: 502,
              headers: { 'Content-Type': 'application/json' },
            }));
          }
          return orig(input, init);
        };
      })();`,
    });
  }
  if (spoofCastUrl) {
    const spoof = String(spoofCastUrl);
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        const orig = window.fetch.bind(window);
        const spoof = ${JSON.stringify(spoof)};
        window.fetch = function(input, init) {
          const url = String(input);
          if (!url.includes('/api/cast-url')) return orig(input, init);
          const exp = Math.floor(Date.now() / 1000) + 3600;
          return Promise.resolve(new Response(JSON.stringify({ url: spoof, exp }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        };
      })();`,
    });
  }
  if (slowCastUrlMs > 0) {
    const delay = Number(slowCastUrlMs);
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        const orig = window.fetch.bind(window);
        window.fetch = function(input, init) {
          const url = String(input);
          if (!url.includes('/api/cast-url')) return orig(input, init);
          return new Promise((resolve, reject) => {
            setTimeout(() => orig(input, init).then(resolve, reject), ${delay});
          });
        };
      })();`,
    });
  }
  if (remotePlayback) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        const orig = window.fetch.bind(window);
        window.__castUrlFetchCache = [];
        window.fetch = function(input, init) {
          if (String(input).includes('/api/cast-url')) {
            window.__castUrlFetchCache.push((init && init.cache) || null);
          }
          return orig(input, init);
        };
      })();`,
    });
  }
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
  episodeBadge: (() => {
    const el = document.querySelector('.episode-badge');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const bg = st.backgroundColor;
    return {
      text: (el.textContent || '').trim(),
      gone: el.classList.contains('is-gone'),
      opacity: Number(st.opacity),
      bare:
        (bg === 'transparent' || bg.replace(/ /g, '') === 'rgba(0,0,0,0)') &&
        st.borderTopWidth === '0px',
      bold: Number(st.fontWeight) >= 700,
      fontSize: parseFloat(st.fontSize),
      pointerEvents: st.pointerEvents,
      color: st.color,
      inTopRight: r.top < window.innerHeight / 2 && r.right > window.innerWidth / 2,
    };
  })(),
  nextUp: (() => {
    const wrap = document.querySelector('.next-overlay');
    const btn = wrap?.querySelector('button');
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    const bar = document.querySelector('.control-bar');
    const br = bar?.getBoundingClientRect();
    const vp = { w: window.innerWidth, h: window.innerHeight };
    return {
      hidden: wrap.hidden,
      isEnd: wrap.classList.contains('is-end'),
      tag: btn?.tagName ?? null,
      label: btn?.getAttribute('aria-label') ?? null,
      text: btn?.innerText ?? '',
      title: btn?.getAttribute('title') ?? '',
      plate: btn
        ? (() => {
            const st = getComputedStyle(btn);
            const bg = st.backgroundColor;
            const transparent = bg === 'transparent' || bg.replace(/ /g, '') === 'rgba(0,0,0,0)';
            return transparent && st.borderTopWidth === '0px' && st.boxShadow === 'none';
          })()
        : null,
      pointerEvents: getComputedStyle(wrap).pointerEvents,
      inert: Boolean(wrap.inert),
      right: r.right,
      bottom: r.bottom,
      top: r.top,
      w: r.width,
      h: r.height,
      barTop: br?.top ?? null,
      inRightHalf: r.left > vp.w / 2,
      aboveBar: !br || r.bottom <= br.top + 1,
    };
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
  remotePrompts: window.__remotePrompts ?? 0,
  remoteWatchCalls: window.__remoteWatchCalls ?? 0,
  remoteCancels: window.__remoteCancels ?? 0,
  castReady: document.querySelector('.cast-btn')?.getAttribute('data-cast-ready') ?? null,
  videoSrc: document.querySelector('video')?.getAttribute('src') ?? '',
  menuBtn: (() => {
    const el = document.getElementById('app-menu-button');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  })(),
  cast: (() => {
    const el = document.querySelector('.cast-btn');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      hidden: el.hidden,
      label: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      pressed: el.getAttribute('aria-pressed'),
      casting: el.classList.contains('is-casting'),
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      inert: Boolean(el.inert),
      display: cs.display,
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
    };
  })(),
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
  assert.equal(ui.paused, false, 'single tap must not pause until the double-tap window elapses');
  await waitForCenterTapDelay();
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'single surface tap still pauses after the double-tap delay');
  assert.equal(ui.controlsVisible, true, 'tap on playing video shows the toolbar');
  assert.equal(ui.centerPlay, true, 'paused state shows the center play icon');
  assert.equal(ui.centerPlayTag, 'BUTTON', 'center play must be a real button');
  assert.equal(ui.centerPlayLabel, 'Lire', 'center play must have an accessible name');
  assert.equal(ui.centerPlayAriaHidden, null, 'center play must not be aria-hidden');
  assert.notEqual(ui.centerPlayPointerEvents, 'none', 'center play must receive pointer events');
  assert.equal(ui.toolbarPlay, false);

  await tapVideoCenter(send);
  await waitForCenterTapDelay();
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false, 'single surface tap on paused video still resumes');
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

uiTest('hold-to-seek ends when the pointer is released off the third', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-left');
      if (!el) throw new Error('missing .touch-left');
      const opts = { bubbles: true, cancelable: true, pointerId: 13, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
    })()`
  );
  await new Promise((r) => setTimeout(r, 700));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'hold-to-seek pauses the video');
  assert.equal(ui.centerPlay, false, 'center play must stay hidden during the hold');
  await evaluate(
    send,
    `(function(){
      document.body.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId: 13,
        pointerType: 'touch',
      }));
    })()`
  );
  await waitFor(send, 'Boolean(document.querySelector("video") && !document.querySelector("video").paused)');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false, 'release off the third must end hold-seek and resume');
  assert.equal(ui.centerPlay, false, 'ended hold must not leave the play control hidden');
});

uiTest('hold-to-seek stops when the player is destroyed mid-hold', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-right');
      const opts = { bubbles: true, cancelable: true, pointerId: 14, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
    })()`
  );
  await new Promise((r) => setTimeout(r, 700));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'hold-to-seek pauses before next-episode');
  await tapSelector(send, '.ctl-next');
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(send, 'Boolean(document.querySelector("video"))');
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

uiTest('progress arrow keys seek once, not doubled by the document handler', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  const bubbled = await evaluate(
    send,
    `(function(){
      const seen = [];
      const onDoc = (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') seen.push(e.key);
      };
      document.addEventListener('keydown', onDoc);
      const progress = document.querySelector('.progress');
      progress.focus();
      progress.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));
      progress.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      }));
      document.removeEventListener('keydown', onDoc);
      return seen;
    })()`
  );
  assert.deepEqual(
    bubbled,
    [],
    'progress arrow keys must stopPropagation so the document handler does not seek a second time'
  );
});

const MUTE_SELECTOR = '.control-bar button[aria-label="Couper le son"]';

uiTest('keyboard focus on the control bar holds it visible', async (t) => {
  const { send } = await openPlayer(t, { width: 844, height: 390, landscape: true });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  const muteShown = await evaluate(
    send,
    `(function(){
      const el = document.querySelector('${MUTE_SELECTOR}');
      if (!el) return false;
      return getComputedStyle(el).display !== 'none';
    })()`
  );
  assert.equal(muteShown, true, 'mute button must be visible so it can take focus');
  await evaluate(send, `document.querySelector('${MUTE_SELECTOR}').focus()`);
  const focused = await evaluate(
    send,
    `document.activeElement === document.querySelector('${MUTE_SELECTOR}')`
  );
  assert.equal(focused, true);
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'focused bar control must not time-hide the bar');
  assert.equal(ui.paused, false);
  await evaluate(send, `document.querySelector('${MUTE_SELECTOR}').blur()`);
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

uiTest('center double-tap toggles native-first fullscreen; single tap still pauses', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed');
  await loopAndPlay(send);
  await doubleTapVideoCenter(send, 'touch');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  let ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, 'center double-tap must reuse the native fullscreen path');
  assert.equal(ui.nativeFs, true);
  assert.equal(ui.fs, true);
  assert.equal(ui.fakeFs, false, 'successful native fullscreen must not use the CSS overlay');
  assert.equal(ui.paused, false, 'double-tap must not also pause');

  await doubleTapVideoCenter(send, 'touch');
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("is-fullscreen") === false');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'second center double-tap exits fullscreen');
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.paused, false, 'exiting via double-tap must not pause');

  await tapVideoCenter(send);
  await waitForCenterTapDelay();
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'a single center tap still pauses');
  assert.equal(ui.fs, false);
});

uiTest('center mouse double-click toggles fullscreen', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await installFullscreenStub(send, 'succeed');
  await loopAndPlay(send);
  await doubleTapVideoCenter(send, 'mouse');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, 'mouse double-click on the center third must request fullscreen');
  assert.equal(ui.fs, true);
  assert.equal(ui.paused, false, 'double-click must not fight single-click pause');
});

uiTest('left-third double-tap seeks and does not toggle fullscreen', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed');
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.touch-left');
      const opts = { bubbles: true, cancelable: true, pointerId: 21, pointerType: 'touch' };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    })()`
  );
  await new Promise((r) => setTimeout(r, 900));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fsRequests, 0, 'edge double-tap must not request fullscreen');
  assert.equal(ui.fs, false);
  assert.equal(ui.paused, false);
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
  await waitFor(
    send,
    `(() => {
      const v = document.querySelector('video');
      const b = document.querySelector('button.center-play');
      return Boolean(v && !v.paused && b && b.hidden);
    })()`
  );
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

uiTest('episode number is shown bare over the picture at the start', async (t) => {
  const { send } = await openPlayer(t, { width: 844, height: 390, landscape: true });
  await loopAndPlay(send);
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.episodeBadge, 'episode badge must exist');
  assert.equal(ui.episodeBadge.text, 'Épisode 1', 'badge reads the number off the filename');
  assert.equal(ui.episodeBadge.gone, false, 'badge is up at the start of the episode');
  assert.ok(ui.episodeBadge.opacity > 0.9, `badge opacity ${ui.episodeBadge.opacity}`);
  assert.equal(ui.episodeBadge.bare, true, 'badge must have no background and no border');
  assert.equal(ui.episodeBadge.bold, true, 'badge uses the bold Sanem signature');
  assert.ok(ui.episodeBadge.fontSize >= 20, `badge is large, got ${ui.episodeBadge.fontSize}px`);
  assert.equal(ui.episodeBadge.inTopRight, true, 'badge sits in the video top-right');
  assert.equal(ui.episodeBadge.pointerEvents, 'none', 'badge must never eat a tap');
});

uiTest('episode number fades away on its own', async (t) => {
  const { send } = await openPlayer(t, { width: 844, height: 390, landscape: true });
  await loopAndPlay(send);
  await waitFor(
    send,
    'document.querySelector(".episode-badge")?.classList.contains("is-gone") === true',
    EPISODE_BADGE_MS + 8000
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.episodeBadge.gone, true, 'badge must retire without any user action');
});

uiTest('next-episode label stays away until the last two minutes', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await fakeDurationAndTime(send, 1500, 1300); // 200 s left, outside the window
  await new Promise((r) => setTimeout(r, 250));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, true, '200 s from the end is too early for the label');
  await fakeDurationAndTime(send, 1500, 1390); // 110 s left, inside the window
  await waitFor(send, 'document.querySelector(".next-overlay")?.hidden === false');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, false, 'label shows once under two minutes remain');
});

uiTest('next-episode chip stays hidden on short titles even with a next file', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, true, 'short clip must not show the chip from t=0');
  assert.equal(ui.nextUp.isEnd, false);
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      v.currentTime = Math.max(0, (v.duration || 0) - 0.2);
      v.dispatchEvent(new Event('timeupdate'));
      v.dispatchEvent(new Event('seeked'));
      return true;
    })()`
  );
  await new Promise((r) => setTimeout(r, 250));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, true, 'short clip must not show the chip near its own end');
  assert.equal(ui.nextUp.isEnd, false);
});

uiTest('next-episode chip appears near the end when a next file exists', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await fakeDurationAndTime(send, 1500, 1450);
  await waitFor(
    send,
    `(() => {
      const el = document.querySelector('.next-overlay');
      return Boolean(el) && !el.hidden && !el.classList.contains('is-end');
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, false, 'chip is visible when a next episode exists');
  assert.equal(ui.nextUp.isEnd, false);
  assert.equal(ui.nextUp.tag, 'BUTTON', 'next-up control must be a real button');
  assert.equal(ui.nextUp.label, 'Épisode suivant');
  assert.equal(
    ui.nextUp.text.trim(),
    'Épisode suivant',
    'the label is bare type: the filename moved to the title attribute'
  );
  assert.match(ui.nextUp.title, /e02\.mp4/);
  assert.equal(ui.nextUp.plate, true, 'no background plate behind the label');
  assert.equal(ui.nextUp.inRightHalf, true, 'chip sits on the bottom-right');
  assert.equal(ui.nextUp.pointerEvents, 'auto');
  assert.equal(ui.nextUp.inert, false);
  if (ui.controlsVisible) {
    assert.equal(ui.nextUp.aboveBar, true, 'chip sits just above the toolbar');
  }
});

uiTest('next-episode chip stays clickable after the toolbar auto-hides and loads the next file', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await fakeDurationAndTime(send, 1500, 1450);
  await waitFor(
    send,
    `(() => {
      const el = document.querySelector('.next-overlay');
      return Boolean(el) && !el.hidden && !el.classList.contains('is-end');
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'toolbar is auto-hidden');
  assert.equal(ui.nextUp.hidden, false, 'chip must remain visible without the toolbar');
  assert.equal(ui.nextUp.inert, false);
  await clickSelector(send, '.next-up-btn');
  await waitFor(send, 'location.hash.includes("e02")');
  const hash = await evaluate(send, 'location.hash');
  assert.match(hash, /e02/);
});

uiTest('next-episode chip is hidden when there is no next episode', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { playPath: 'Serie/e02.mp4' }
  );
  await loopAndPlay(send);
  await evaluate(
    send,
    `(async function(){
      const v = document.querySelector('video');
      v.currentTime = Math.max(0, (v.duration || 0) - 0.2);
      return true;
    })()`
  );
  await new Promise((r) => setTimeout(r, 250));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, true, 'last episode must not offer Épisode suivant');
  assert.equal(ui.nextUp.isEnd, false);
  assert.equal(ui.bar.nextVisible, false, 'toolbar next control stays hidden without a next file');
});

uiTest('next-episode chip hides after seeking back out of the end window', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await loopAndPlay(send);
  await fakeDurationAndTime(send, 1500, 1450);
  await waitFor(
    send,
    `(() => {
      const el = document.querySelector('.next-overlay');
      return Boolean(el) && !el.hidden && !el.classList.contains('is-end');
    })()`
  );
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      v.currentTime = 40;
      v.dispatchEvent(new Event('timeupdate'));
      v.dispatchEvent(new Event('seeked'));
      return true;
    })()`
  );
  await waitFor(
    send,
    `(() => {
      const el = document.querySelector('.next-overlay');
      return Boolean(el) && el.hidden && !el.classList.contains('is-end');
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, true, 'chip must hide after scrubbing out of the last 20s');
  assert.equal(ui.nextUp.isEnd, false);
});

uiTest('seeking after series-end does not hide the is-end overlay', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { playPath: 'Serie/e02.mp4' }
  );
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
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      v.currentTime = 0;
      v.dispatchEvent(new Event('timeupdate'));
      v.dispatchEvent(new Event('seeked'));
      return true;
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.endOverlay, true, 'is-end overlay must survive a seek after ended');
  assert.equal(ui.nextUp.hidden, false);
  assert.equal(ui.nextUp.isEnd, true);
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

function rectsOverlap(a, b, gap = 0) {
  return (
    a.left < b.right + gap &&
    a.right + gap > b.left &&
    a.top < b.bottom + gap &&
    a.bottom + gap > b.top
  );
}

async function waitCastReady(send) {
  await waitFor(send, 'document.querySelector(".cast-btn")?.getAttribute("data-cast-ready") === "1"');
}

uiTest('cast button is hidden when Remote Playback is unsupported', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { hasRemote: false } }
  );
  await waitFor(send, 'Boolean(document.querySelector(".cast-btn"))');
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cast.hidden, true);
  assert.equal(ui.cast.display, 'none');
  assert.equal(ui.remotePrompts, 0);
});

uiTest('cast button is hidden when watchAvailability reports no devices', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: false } }
  );
  await waitFor(send, '(window.__remoteWatchCalls ?? 0) >= 1');
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cast.hidden, true);
  assert.equal(ui.cast.display, 'none');
  assert.equal(ui.remotePrompts, 0, 'prompt must not run just because the player mounted');
});

uiTest('cast button is shown when watchAvailability cannot monitor devices', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { watchReject: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cast.hidden, false);
  assert.equal(ui.cast.label, 'Diffuser sur un écran');
  assert.equal(ui.controlsVisible, true);
  assert.notEqual(ui.cast.opacity, '0');
});

uiTest('cast button follows overlay chrome and sits in the video top-right', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true);
  assert.equal(ui.cast.hidden, false);
  assert.equal(ui.cast.label, 'Diffuser sur un écran');
  assert.equal(ui.cast.title, 'Diffuser sur un écran');
  assert.equal(ui.cast.pressed, 'false');
  assert.notEqual(ui.cast.opacity, '0');
  assert.notEqual(ui.cast.pointerEvents, 'none');
  assert.ok(ui.cast.w >= 44, `cast target too small: ${ui.cast.w}`);
  assert.ok(ui.cast.h >= 44, `cast target too small: ${ui.cast.h}`);
  assert.ok(ui.cast.y >= ui.player.y - 1, 'cast must sit inside the video frame');
  assert.ok(ui.cast.top - ui.player.y < 48, 'cast must be near the top of the video');
  assert.ok(ui.player.x + ui.player.w - ui.cast.right < 48, 'cast must be near the right of the video');
  assert.equal(rectsOverlap(ui.cast, ui.menuBtn), false, 'cast must not collide with the hamburger');

  await loopAndPlay(send);
  await waitFor(
    send,
    `(function(){
      const root = document.querySelector('.player-container');
      const el = document.querySelector('.cast-btn');
      if (!root || !el || root.classList.contains('controls-visible')) return false;
      const cs = getComputedStyle(el);
      return cs.opacity === '0' && cs.pointerEvents === 'none';
    })()`,
    3000
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false);
  assert.equal(ui.cast.hidden, false, 'availability stays true while chrome hides');
  assert.equal(ui.cast.opacity, '0');
  assert.equal(ui.cast.pointerEvents, 'none');
  assert.equal(ui.cast.inert, true);
  assert.equal(ui.paused, false);
});

uiTest('cast prompt is only opened from a user gesture', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 0, 'prompt must wait for a click/tap');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true);
  await waitCastReady(send);
  const mintCaches = await evaluate(send, 'window.__castUrlFetchCache');
  assert.ok(Array.isArray(mintCaches) && mintCaches.length >= 1, 'mint fetch must have run');
  assert.ok(
    mintCaches.every((c) => c === 'no-store'),
    `cast-url fetch must use cache: no-store, got ${JSON.stringify(mintCaches)}`
  );
  await clickSelector(send, '.cast-btn');
  await waitFor(send, '(window.__remotePrompts ?? 0) >= 1');
  await waitFor(send, '(window.__castUrlFetchCache || []).length >= 2');
  const afterClick = await evaluate(send, 'window.__castUrlFetchCache');
  assert.ok(
    afterClick.length > mintCaches.length,
    'non-live click must refresh the mint, not reuse a prefetch with a 60s floor'
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 1);
  assert.match(ui.videoSrc, /[?&]exp=/);
  assert.match(ui.videoSrc, /[?&]sig=/);
});

uiTest('cast button reflects connected state and does not pause playback', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  await loopAndPlay(send);
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await waitCastReady(send);
  await clickSelector(send, '.cast-btn');
  await waitFor(send, '(window.__remotePrompts ?? 0) >= 1');
  await waitFor(send, 'Boolean(document.querySelector("video") && !document.querySelector("video").paused)');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 1);
  assert.equal(ui.paused, false, 'casting must not click-through to pause the surface');
  assert.equal(ui.cast.pressed, 'true');
  assert.equal(ui.cast.casting, true);
  assert.equal(ui.cast.hidden, false);
  await clickSelector(send, '.cast-btn');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 2);
  assert.equal(ui.cast.pressed, 'false');
  assert.equal(ui.cast.casting, false);
  await waitFor(send, 'Boolean(document.querySelector("video") && !document.querySelector("video").paused)');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false);
});

uiTest('prompt reject while connected keeps the signed src', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true, promptRejectWhenLive: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await waitCastReady(send);
  await clickSelector(send, '.cast-btn');
  await waitFor(send, 'document.querySelector(".cast-btn")?.getAttribute("aria-pressed") === "true"');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 1);
  assert.match(ui.videoSrc, /[?&]sig=/);
  await clickSelector(send, '.cast-btn');
  await waitFor(send, '(window.__remotePrompts ?? 0) >= 2');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 2);
  assert.equal(ui.cast.pressed, 'true', 'reject while live must not disconnect');
  assert.equal(ui.cast.casting, true);
  assert.match(ui.videoSrc, /[?&]sig=/, 'must not restore cookie src while still connected');
});

uiTest('cast button hides after disconnect if devices disappeared while live', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await waitCastReady(send);
  await clickSelector(send, '.cast-btn');
  await waitFor(send, 'document.querySelector(".cast-btn")?.getAttribute("aria-pressed") === "true"');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cast.pressed, 'true');
  assert.equal(ui.cast.hidden, false);
  await evaluate(send, 'window.__setRemoteAvailable(false)');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cast.hidden, false, 'stay visible while still connected even if devices drop');
  assert.equal(ui.cast.pressed, 'true');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await clickSelector(send, '.cast-btn');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cast.pressed, 'false');
  assert.equal(ui.cast.hidden, true, 'disconnect must re-apply last watchAvailability (no devices)');
});

uiTest('late watchAvailability reject after destroy does not unhide a stale cast button', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { watchReject: true, watchRejectDelayMs: 400 } }
  );
  await waitFor(send, 'Boolean(document.querySelector(".cast-btn"))');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cast.hidden, true, 'button starts hidden until watchAvailability settles');
  await evaluate(send, 'window.__oldCast = document.querySelector(".cast-btn")');
  await tapSelector(send, '.ctl-next');
  await waitFor(send, 'location.hash.includes("e02")');
  await new Promise((r) => setTimeout(r, 600));
  const staleHidden = await evaluate(send, 'Boolean(window.__oldCast?.hidden)');
  assert.equal(staleHidden, true, 'destroyed player must ignore a late watchAvailability reject');
  ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.cast, 'new player still has a cast control');
});

uiTest('cast button is not offered on the hls.js MSE path', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { playback: 'hls', hlsMode: 'mse', remotePlayback: { available: true } }
  );
  await waitFor(send, 'Boolean(document.querySelector(".cast-btn"))');
  await new Promise((r) => setTimeout(r, 200));
  const info = await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      const src = v.getAttribute('src') || v.src || '';
      return {
        hidden: document.querySelector('.cast-btn')?.hidden ?? null,
        watches: window.__remoteWatchCalls ?? 0,
        prompts: window.__remotePrompts ?? 0,
        src,
        nativeHls: v.canPlayType('application/vnd.apple.mpegurl'),
        hlsSupported: Boolean(window.Hls && window.Hls.isSupported()),
      };
    })()`
  );
  assert.equal(info.nativeHls, '', 'test must force the non-native HLS branch');
  assert.equal(info.hlsSupported, true, 'hls.js must be the MSE driver');
  assert.equal(info.hidden, true, 'MSE/blob playback must not offer cast');
  assert.equal(info.watches, 0, 'must not watchAvailability on the hls.js path');
  assert.equal(info.prompts, 0);
  const mseReady = await evaluate(send, 'document.querySelector(".cast-btn")?.getAttribute("data-cast-ready")');
  assert.equal(mseReady, null, 'MSE path must not mint a cast URL');
});

uiTest('cast button is offered for native HLS src URL', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { playback: 'hls', hlsMode: 'native', remotePlayback: { available: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  await waitCastReady(send);
  const info = await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      const src = v.getAttribute('src') || '';
      return {
        hidden: document.querySelector('.cast-btn')?.hidden ?? null,
        watches: window.__remoteWatchCalls ?? 0,
        src,
        nativeHls: v.canPlayType('application/vnd.apple.mpegurl'),
      };
    })()`
  );
  assert.equal(info.nativeHls, 'maybe');
  assert.match(info.src, /\/api\/hls\//);
  assert.equal(info.hidden, false, 'native HLS src URL may offer Remote Playback');
  assert.ok(info.watches >= 1);
});

uiTest('teardown cancels an active Remote Playback session once', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true } }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await waitCastReady(send);
  await clickSelector(send, '.cast-btn');
  await waitFor(send, 'document.querySelector(".cast-btn")?.getAttribute("aria-pressed") === "true"');
  const before = await evaluate(send, 'window.__remoteCancels ?? 0');
  assert.equal(before, 0, 'cancel must not run just because a session connected');
  await tapSelector(send, '.ctl-next');
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(send, 'Boolean(document.querySelector("video"))');
  const cancels = await evaluate(send, 'window.__remoteCancels ?? 0');
  assert.equal(cancels, 1, 'goNext/cleanup must cancel a live session once, not twice');
});

uiTest('cast prompt is skipped when signed URL mint fails', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true }, failCastUrl: true }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  await new Promise((r) => setTimeout(r, 250));
  const ready = await evaluate(send, 'document.querySelector(".cast-btn")?.getAttribute("data-cast-ready")');
  assert.equal(ready, null);
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await clickSelector(send, '.cast-btn');
  await new Promise((r) => setTimeout(r, 200));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 0, 'must not prompt with a cookie URL when mint fails');
  assert.doesNotMatch(ui.videoSrc, /[?&]sig=/);
});

uiTest('prompt cancel restores the cookie-gated src', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true, promptReject: true } }
  );
  await waitCastReady(send);
  await evaluate(
    send,
    `(async function(){
      const v = document.querySelector('video');
      v.loop = true;
      await new Promise((r) => {
        if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0) return r();
        v.addEventListener('loadedmetadata', r, { once: true });
      });
      v.currentTime = 0.8;
      await v.play().catch(() => {});
      return true;
    })()`
  );
  await waitFor(send, '(document.querySelector("video")?.currentTime || 0) >= 0.5');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await clickSelector(send, '.cast-btn');
  await waitFor(send, '(window.__remotePrompts ?? 0) >= 1');
  await waitFor(
    send,
    `(function(){
      const v = document.querySelector('video');
      const src = v?.getAttribute('src') || '';
      if (!src.includes('/api/media/') || /[?&]sig=/.test(src)) return false;
      return (v.currentTime || 0) >= 0.5;
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 1);
  assert.equal(ui.cast.pressed, 'false');
  assert.match(ui.videoSrc, /\/api\/media\//);
  assert.doesNotMatch(ui.videoSrc, /[?&]sig=/);
  assert.equal(ui.paused, false, 'pendingPlay from applySignedSrc must survive picker cancel');
});

uiTest('prompt fulfill while disconnected restores the cookie-gated src', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true, promptDismiss: true } }
  );
  await waitCastReady(send);
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await clickSelector(send, '.cast-btn');
  await waitFor(send, '(window.__remotePrompts ?? 0) >= 1');
  await waitFor(
    send,
    `(function(){
      const src = document.querySelector('video')?.getAttribute('src') || '';
      return src.includes('/api/media/') && !/[?&]sig=/.test(src);
    })()`
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 1);
  assert.equal(ui.cast.pressed, 'false');
  assert.match(ui.videoSrc, /\/api\/media\//);
  assert.doesNotMatch(ui.videoSrc, /[?&]sig=/);
});

uiTest('cast click still prompts after an in-flight mint', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { remotePlayback: { available: true }, slowCastUrlMs: 2000 }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  const readyBefore = await evaluate(
    send,
    'document.querySelector(".cast-btn")?.getAttribute("data-cast-ready")'
  );
  assert.equal(readyBefore, null, 'click before prefetch must exercise the refresh chain');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await clickSelector(send, '.cast-btn');
  // The mint is deliberately slowed by 2 s (slowCastUrlMs); the default 10 s
  // budget leaves too little margin when the whole suite loads the machine.
  // Observed >20 s once under a full-suite run, hence the wide budget: the
  // assertion below is what fails a real regression, not this deadline.
  await waitFor(send, '(window.__remotePrompts ?? 0) >= 1', 45000);
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.remotePrompts >= 1, 'same gesture must prompt once mint succeeds');
  assert.match(ui.videoSrc, /[?&]sig=/);
});

test('episodeLabel reads the number off a release-style filename', () => {
  assert.equal(episodeLabel({ name: 'Dr.STONE.S04E18.MULTi.1080p.mkv' }), 'Épisode 18');
  assert.equal(episodeLabel({ name: 'e01.mp4' }), 'Épisode 1');
  assert.equal(episodeLabel({ name: 'film.mkv' }), 'film.mkv', 'no marker -> bare filename');
});

test('cast src allowlist is same-origin relative /api/media or /api/hls only', () => {
  assert.equal(isAllowedCastSrc('/api/media/Serie/e01.mp4?exp=1&sig=abc'), true);
  assert.equal(isAllowedCastSrc('/api/hls/Serie/e01.mp4/index.m3u8?exp=1&sig=abc'), true);
  assert.equal(isAllowedCastSrc('https://evil.example/api/media/Serie/e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('http://127.0.0.1/api/media/Serie/e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('//evil.example/api/media/Serie/e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/\\/evil.example/api/media/x'), false);
  assert.equal(isAllowedCastSrc('/api/download/Serie/e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/thumbs/Serie/e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/files/Serie/e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc(''), false);
  assert.equal(isAllowedCastSrc(null), false);
  assert.equal(isAllowedCastSrc('/api/media/Serie/e01.mp4'), false, 'missing exp+sig');
  assert.equal(isAllowedCastSrc('/api/media/Serie/e01.mp4?exp=1'), false, 'missing sig');
  assert.equal(isAllowedCastSrc('/api/media/Serie/e01.mp4?sig=abc'), false, 'missing exp');
  assert.equal(isAllowedCastSrc('/api/media/Serie/e01.mp4?exp=&sig=abc'), false, 'empty exp');
  assert.equal(isAllowedCastSrc('/api/media/../etc/passwd?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/media/foo/../../etc/passwd?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/media/%2e%2e/etc/passwd?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/media/%2E%2e/secret?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/media/%252e%252e/secret?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/media/./e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/media/%2e/e01.mp4?exp=1&sig=abc'), false);
  assert.equal(isAllowedCastSrc('/api/media//e01.mp4?exp=1&sig=abc'), false, 'empty path segment');
  assert.equal(isAllowedCastSrc('/api/hls/Serie/e01.mp4/%2e%2e/index.m3u8?exp=1&sig=abc'), false);
});

test('next-episode prompt is only near the end and only when a next file exists', () => {
  const next = { path: 'Serie/e02.mp4', name: 'e02.mp4' };
  assert.equal(NEXT_UP_LEAD_S, 120, 'offered for the last two minutes');
  assert.equal(shouldShowNextEpisode(next, 1500, 1380), true, 'exactly 120s remaining');
  assert.equal(shouldShowNextEpisode(next, 1500, 1450), true, 'inside the last 120s');
  assert.equal(shouldShowNextEpisode(next, 1500, 1379), false, 'more than 120s remaining');
  assert.equal(shouldShowNextEpisode(next, 1500, 1500), true, 'ended / remaining 0');
  assert.equal(shouldShowNextEpisode(null, 1500, 1499), false, 'no next episode');
  assert.equal(shouldShowNextEpisode(next, 0, 0), false, 'unknown duration');
  assert.equal(shouldShowNextEpisode(next, 120, 119), false, 'duration equal to lead');
  assert.equal(shouldShowNextEpisode(next, 2, 1), false, 'short title near its own end');
  assert.equal(shouldShowNextEpisode(next, 121, 1), true, 'just longer than lead, 120s remaining');
  assert.equal(shouldShowNextEpisode(next, 121, 0), false, 'just longer than lead, still outside window');
});

uiTest('hostile mint URL is not assigned and does not prompt', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    {
      remotePlayback: { available: true },
      spoofCastUrl: 'https://evil.example/api/media/Serie/e01.mp4',
    }
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  await new Promise((r) => setTimeout(r, 250));
  const ready = await evaluate(send, 'document.querySelector(".cast-btn")?.getAttribute("data-cast-ready")');
  assert.equal(ready, null, 'rejected mint must not mark the button ready');
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
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await clickSelector(send, '.cast-btn');
  await new Promise((r) => setTimeout(r, 200));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.remotePrompts, 0, 'must not prompt with a rejected cast URL');
  assert.match(ui.videoSrc, /\/api\/media\//);
  assert.doesNotMatch(ui.videoSrc, /evil\.example/);
  assert.doesNotMatch(ui.videoSrc, /^https?:/i);
  assert.doesNotMatch(ui.videoSrc, /^\/\//);
});







