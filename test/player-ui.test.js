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
  BAR_HIDE_MS,
  POINTER_MOVE_MIN_PX,
  notePointerPosition,
  pointInRect,
  pointerLeaveAbandonsChrome,
  episodeLabel,
  seriesSiblings,
  scheduleBadgeHide,
  TIP_MUTE,
  TIP_UNMUTE,
  TIP_VOLUME,
  TIP_PREV,
  TIP_NEXT,
  TIP_FS_ENTER,
  TIP_FS_EXIT,
  VOLUME_STEP,
  playerKeyCommand,
  isPlayerTypingTarget,
  volumeAfterUnmute,
  volumeToPersist,
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
    extraFiles = [],
    fileMeta = {},
  } = {}
) {
  const { baseUrl } = await startServer(t, { playback, extraFiles, fileMeta });
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

// Real mouse activity must change clientX/Y: Gecko fires zero-delta
// pointermove on <video>, and the first event only seeds the last pixel.
async function mouseMoveOnPlayer(send, dx = 48, dy = 36) {
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      if (!el) throw new Error('missing .player-container');
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' };
      el.dispatchEvent(new PointerEvent('pointermove', {
        ...opts,
        clientX: r.x + 2,
        clientY: r.y + 2,
      }));
      el.dispatchEvent(new PointerEvent('pointermove', {
        ...opts,
        clientX: r.x + ${Number(dx)},
        clientY: r.y + ${Number(dy)},
      }));
    })()`
  );
}

const SNAPSHOT = `({
  skipBack: Boolean(document.querySelector('[aria-label="Reculer de 10 secondes"]')),
  skipFwd: Boolean(document.querySelector('[aria-label="Avancer de 10 secondes"]')),
  dock: Boolean(document.querySelector('.dock')),
  menuButton: Boolean(document.querySelector('#app-menu-button')),
  menuHidden: document.getElementById('app-menu')?.hidden ?? null,
  menuText: document.getElementById('app-menu')?.innerText ?? '',
  controlsVisible: document.querySelector('.player-container')?.classList.contains('controls-visible') ?? false,
  cursor: (() => {
    const el = document.querySelector('.player-container');
    const video = document.querySelector('.player-video') || document.querySelector('video');
    if (!el) return null;
    return {
      container: getComputedStyle(el).cursor,
      video: video ? getComputedStyle(video).cursor : null,
    };
  })(),
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
    const btn = wrap?.querySelector('.next-up-btn:not(.prev-up-btn)');
    const prevBtn = wrap?.querySelector('.prev-up-btn');
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    const bar = document.querySelector('.control-bar');
    const br = bar?.getBoundingClientRect();
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const chip = (el) =>
      el
        ? {
            hidden: el.hidden,
            tag: el.tagName,
            label: el.getAttribute('aria-label') ?? null,
            hasTip: el.classList.contains('has-tip'),
            text: (el.innerText ?? '').trim(),
            icon: el.querySelector('use')?.getAttribute('href') ?? null,
            tip: getComputedStyle(el, '::after').content,
            title: el.getAttribute('title'),
          }
        : null;
    return {
      hidden: wrap.hidden,
      isEnd: wrap.classList.contains('is-end'),
      tag: btn?.tagName ?? null,
      label: btn?.getAttribute('aria-label') ?? null,
      text: (btn?.innerText ?? '').trim(),
      hasTip: btn?.classList.contains('has-tip') ?? false,
      icon: btn?.querySelector('use')?.getAttribute('href') ?? null,
      tip: btn ? getComputedStyle(btn, '::after').content : '',
      title: btn?.getAttribute('title') ?? null,
      prev: chip(prevBtn),
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
    if (!el) return false;
    return (document.fullscreenElement || document.webkitFullscreenElement) === el;
  })(),
  htmlFs: document.documentElement.classList.contains('player-fs'),
  fsLabel: document.querySelector('.ctl-fs')?.getAttribute('aria-label') ?? null,
  fsHasTip: document.querySelector('.ctl-fs')?.classList.contains('has-tip') ?? false,
  fsTitle: document.querySelector('.ctl-fs')?.getAttribute('title') ?? null,
  fsIcon: document.querySelector('.ctl-fs use')?.getAttribute('href') ?? null,
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
      prevVisible: visible.some((el) => el.classList.contains('ctl-prev')),
    };
  })(),
  prevCtl: (() => {
    const el = document.querySelector('.ctl-prev');
    if (!el) return null;
    return {
      hidden: el.hidden,
      label: el.getAttribute('aria-label'),
      hasTip: el.classList.contains('has-tip'),
      text: (el.innerText || '').trim(),
      icon: el.querySelector('use')?.getAttribute('href') ?? null,
      tip: getComputedStyle(el, '::after').content,
      title: el.getAttribute('title'),
    };
  })(),
  nextCtl: (() => {
    const el = document.querySelector('.ctl-next');
    if (!el) return null;
    return {
      hidden: el.hidden,
      label: el.getAttribute('aria-label'),
      hasTip: el.classList.contains('has-tip'),
      text: (el.innerText || '').trim(),
      icon: el.querySelector('use')?.getAttribute('href') ?? null,
      tip: getComputedStyle(el, '::after').content,
      title: el.getAttribute('title'),
    };
  })(),
  muteCtl: (() => {
    const el = document.querySelector('.ctl-mute');
    if (!el) return null;
    return {
      label: el.getAttribute('aria-label'),
      hasTip: el.classList.contains('has-tip'),
      title: el.getAttribute('title'),
      icon: el.querySelector('use')?.getAttribute('href') ?? null,
    };
  })(),
  volumeCtl: (() => {
    const wrap = document.querySelector('.volume-wrap');
    const input = document.querySelector('.volume');
    if (!wrap && !input) return null;
    return {
      wrapLabel: wrap?.getAttribute('aria-label') ?? null,
      wrapHasTip: wrap?.classList.contains('has-tip') ?? false,
      wrapTitle: wrap?.getAttribute('title') ?? null,
      inputLabel: input?.getAttribute('aria-label') ?? null,
      inputTitle: input?.getAttribute('title') ?? null,
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
  assert.equal(ui.bar.prevVisible, false, 'first episode has no previous control');
  assert.equal(ui.nextCtl.text, '', 'next is icon-only');
  assert.equal(ui.nextCtl.label, TIP_NEXT);
  assert.equal(ui.nextCtl.hasTip, true);
  assert.equal(ui.nextCtl.icon, '#i-next');
  assert.equal(ui.fsIcon, '#i-fullscreen');
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
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
  assert.equal(ui.cursor.container, 'none', 'cursor hides with the toolbar');
  assert.equal(ui.cursor.video, 'none', 'video surface cursor hides with the toolbar');
  assert.equal(ui.paused, false);

  await tapVideoCenter(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, false, 'single tap must not pause until the double-tap window elapses');
  await waitForCenterTapDelay();
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.paused, true, 'single surface tap still pauses after the double-tap delay');
  assert.equal(ui.controlsVisible, true, 'tap on playing video shows the toolbar');
  assert.notEqual(ui.cursor.container, 'none', 'cursor returns when chrome is shown');
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
  assert.equal(ui.cursor.container, 'none', 'cursor hides again after resume idle');
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
  assert.equal(ui.cursor.container, 'none', 'idle playback hides the mouse cursor');
  assert.equal(ui.cursor.video, 'none');
  assert.equal(ui.paused, false);
  await mouseMoveOnPlayer(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'mouse pointermove must reveal a hidden toolbar');
  assert.notEqual(ui.cursor.container, 'none', 'moving the mouse restores the cursor with chrome');
  assert.equal(ui.paused, false, 'revealing the bar with the mouse must not pause playback');
});

uiTest('same-coordinate pointermove does not reveal chrome (Firefox video quirk)', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  await mouseMoveOnPlayer(send, 48, 36);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'a real move must reveal chrome');
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false);
  assert.equal(ui.cursor.container, 'none');
  await evaluate(
    send,
    `(function(){
      const el = document.querySelector('.player-container');
      const video = document.querySelector('video');
      const r = el.getBoundingClientRect();
      const x = r.x + 48;
      const y = r.y + 36;
      const opts = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
      };
      for (let i = 0; i < 25; i += 1) {
        video.dispatchEvent(new PointerEvent('pointermove', opts));
        el.dispatchEvent(new PointerEvent('pointermove', opts));
      }
    })()`
  );
  await new Promise((r) => setTimeout(r, 400));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'Gecko-style zero-delta pointermove must not reveal chrome');
  assert.equal(ui.cursor.container, 'none', 'cursor stays hidden through zero-delta moves');
  assert.equal(ui.paused, false);
  await mouseMoveOnPlayer(send, 80, 70);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'a later real move still reveals chrome');
  assert.notEqual(ui.cursor.container, 'none');
});

uiTest('pointermove over the video drops a stale chrome hover hold', async (t) => {
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
  await new Promise((r) => setTimeout(r, 400));
  await evaluate(
    send,
    `(function(){
      const video = document.querySelector('video');
      const r = video.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      };
      video.dispatchEvent(new PointerEvent('pointermove', opts));
      video.dispatchEvent(new PointerEvent('pointermove', opts));
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'stale pointerenter must not trap hide after video pointermove');
  assert.equal(ui.cursor.container, 'none');
  assert.equal(ui.paused, false);
});

uiTest('mouse-click focus on a bar control does not trap auto-hide', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await evaluate(
    send,
    `(function(){
      const mute = document.querySelector('.control-bar .ctl-mute');
      mute.focus({ preventScroll: true, focusVisible: false });
    })()`
  );
  const focus = await evaluate(
    send,
    `(function(){
      const mute = document.querySelector('.control-bar .ctl-mute');
      const ae = document.activeElement;
      return {
        stillMute: ae === mute,
        focusVisible: Boolean(ae && ae.matches(':focus-visible') &&
          document.querySelector('.control-bar')?.contains(ae)),
      };
    })()`
  );
  assert.equal(focus.stillMute, true, 'A1a: mouse-style focus must remain on the control');
  assert.equal(focus.focusVisible, false, 'mouse click must not be :focus-visible');
  // Settle so a focus-ring reflow cannot re-seed lastMouse after leave.
  await new Promise((r) => setTimeout(r, 50));
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      const video = document.querySelector('video');
      const r = video.getBoundingClientRect();
      bar.dispatchEvent(new PointerEvent('pointerleave', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: r.x + r.width / 2,
        clientY: r.y + Math.min(40, r.height / 4),
        relatedTarget: video,
      }));
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    4000
  );
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'clicking a control then leaving must still auto-hide');
  assert.equal(ui.cursor.container, 'none');
  assert.equal(ui.paused, false);
});

uiTest('mouse pointerup does not blur a focused progress or volume control', async (t) => {
  const { send } = await openPlayer(t, { width: 1100, height: 700 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  const after = await evaluate(
    send,
    `(function(){
      const report = [];
      for (const sel of ['.progress', '.volume']) {
        const el = document.querySelector(sel);
        if (!el || getComputedStyle(el).display === 'none') {
          report.push({ sel, skipped: true });
          continue;
        }
        const opts = { bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse' };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.focus();
        document.dispatchEvent(new PointerEvent('pointerup', opts));
        report.push({
          sel,
          skipped: false,
          stillFocused: document.activeElement === el,
          focusVisible: el.matches(':focus-visible'),
        });
      }
      return report;
    })()`
  );
  const checked = after.filter((r) => !r.skipped);
  assert.ok(checked.length >= 1, 'progress and/or volume must be present');
  for (const row of checked) {
    assert.equal(row.stillFocused, true, `${row.sel} must keep focus after mouse pointerup`);
  }
});

uiTest('hovering the control bar holds it visible and clicks hit controls', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  const box = await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.control-bar .ctl-mute');
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

uiTest('spurious pointerleave inside the bar does not drop geometric hover hold', async (t) => {
  const { send } = await openPlayer(t, { width: 500, height: 800 }, { phone: false });
  await loopAndPlay(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  const box = await waitFor(
    send,
    `(function(){
      const el = document.querySelector('.control-bar .ctl-mute');
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
      const mute = document.querySelector('.control-bar .ctl-mute');
      const x = ${Number(box.x)};
      const y = ${Number(box.y)};
      const move = (from) => new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: from ? x - 4 : x,
        clientY: y,
      });
      bar.dispatchEvent(new PointerEvent('pointerenter', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
      }));
      bar.dispatchEvent(move(true));
      bar.dispatchEvent(move(false));
      // Gecko-style leave with relatedTarget still a bar child and coords
      // still on the control: must not abandon lastMouse.
      bar.dispatchEvent(new PointerEvent('pointerleave', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
        relatedTarget: mute,
      }));
    })()`
  );
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'leave still inside bar/cast geometry must not drop chrome');
  await evaluate(
    send,
    `(function(){
      const bar = document.querySelector('.control-bar');
      const video = document.querySelector('video');
      const br = bar.getBoundingClientRect();
      bar.dispatchEvent(new PointerEvent('pointerleave', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: br.x + br.width / 2,
        clientY: br.y - 40,
        relatedTarget: video,
      }));
    })()`
  );
  await waitFor(
    send,
    'document.querySelector(".player-container")?.classList.contains("controls-visible") === false',
    3000
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, false, 'leave outside chrome geometry must resume auto-hide');
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

const MUTE_SELECTOR = '.control-bar .ctl-mute';

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
  await evaluate(send, `document.querySelector('${MUTE_SELECTOR}').focus({ focusVisible: true })`);
  const focused = await evaluate(
    send,
    `document.activeElement === document.querySelector('${MUTE_SELECTOR}')`
  );
  assert.equal(focused, true);
  const focusVisible = await evaluate(
    send,
    `document.querySelector('${MUTE_SELECTOR}')?.matches(':focus-visible')`
  );
  assert.equal(focusVisible, true, 'keyboard-style focus must match :focus-visible to hold chrome');
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
      const btn = document.querySelector('.ctl-fs');
      if (!btn) throw new Error('missing fullscreen button');
      btn.focus({ focusVisible: true });
    })()`
  );
  let focused = await evaluate(
    send,
    'document.activeElement?.classList.contains("ctl-fs")'
  );
  assert.equal(focused, true);
  await new Promise((r) => setTimeout(r, 2500));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.controlsVisible, true, 'focus on a bar control must hold the bar visible');
  await evaluate(
    send,
    `(function(){
      const btn = document.querySelector('.ctl-fs');
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
      const btn = document.querySelector('.ctl-fs');
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
  await tapSelector(send, '.ctl-fs');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.equal(ui.fsRequests, 2, 'leftover leave must issue exactly one new native request');
});

uiTest('second fullscreen toggle during leftover wait exits native', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed-slow-exit');
  await clickFullscreen(send);
  await tapSelector(send, '.ctl-fs');
  await tapSelector(send, '.ctl-fs');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'leftover native is still on screen during leftover wait');
  assert.equal(ui.fs, false, 'leftover wait has not adopted native yet');
  assert.equal(ui.fsRequests, 1, 'leftover enter must not re-request while native is still assigned');
  assert.equal(ui.fsLabel, TIP_FS_EXIT, 'leftover wait must offer exit, not a second enter');
  await tapSelector(send, '.ctl-fs');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'second toggle during leftover wait must exit');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
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
  await tapSelector(send, '.ctl-fs');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.equal(ui.fsRequests, 2);
});

uiTest('hung leftover native exit falls back to overlay instead of stalling', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'exit-hang');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true);
  await tapSelector(send, '.ctl-fs');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.ok(
    ui.fsExits >= 2,
    'overlay must dismiss leftover native immediately, not on the first 50ms poll'
  );
  await tapSelector(send, '.ctl-fs');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'after leftover overlay, toggle must be able to exit');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
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
  assert.equal(ui.fsIcon, '#i-exit-fullscreen', 'native fullscreen swaps to the exit glyph');
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.equal(ui.fsHasTip, true);
});

uiTest('overlay fallback when native fullscreen is a no-op', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'noop');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1, `native Fullscreen API must be attempted first, got ${ui.fsRequests}`);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, true, 'is-fullscreen applies after overlay fallback');
  assert.equal(ui.fakeFs, true, 'no-op native request must fall back to the CSS overlay');
  assert.equal(ui.forcedLandscape, true, 'portrait fake-fullscreen rotates onto the long edge');
  assert.equal(ui.fsIcon, '#i-exit-fullscreen', 'overlay fullscreen swaps to the exit glyph');
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  const longEdge = Math.max(ui.player.w, ui.player.h);
  assert.ok(longEdge > 800, `expected landscape span, got ${longEdge}`);
  await tapSelector(send, '.ctl-fs');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false);
  assert.equal(ui.fsIcon, '#i-fullscreen', 'leaving overlay restores the enter glyph');
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
});

uiTest('second fullscreen tap during native wait does not abort overlay fallback', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'noop');
  await tapSelector(send, '.ctl-fs');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
});

uiTest('delayed webkit fullscreen is not treated as a no-op', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-delayed');
  await tapSelector(send, '.ctl-fs');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await new Promise((r) => setTimeout(r, 50));
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'is-fullscreen must not apply during the native wait');
  assert.equal(ui.htmlFs, false, 'player-fs must not apply during the native wait');
  assert.equal(ui.fakeFs, false, 'must not overlay before delayed webkitFullscreenElement is assigned');
  assert.equal(ui.forcedLandscape, false, 'must not rotate during the native wait');
  assert.equal(ui.nativeFs, false, 'webkit assignment is still pending');
  assert.equal(ui.fsLabel, TIP_FS_ENTER, 'do not claim fullscreen until native or overlay lands');
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
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.equal(ui.forcedLandscape, true, 'phone overlay in portrait keeps forced landscape');
});

uiTest('async exit under overlay keeps rotate and does not re-exit', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-late-async-exit');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
});

uiTest('silent native assign after the 900ms watch cap is still cancelled', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-after-watch-silent');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
});

uiTest('silent late webkit assign does not snap overlay to native', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-late-silent');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
});

uiTest('exiting during the grace window aborts a late native enter', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'webkit-delayed');
  await tapSelector(send, '.ctl-fs');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
  await waitFor(send, '(window.__fsExits ?? 0) >= 1');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, false, 'late native enter after cancel must be exited');
  assert.equal(ui.fs, false);
  assert.equal(ui.htmlFs, false, 'player-fs must not return after cancel');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
  assert.ok(ui.fsExits >= 1);
});

uiTest('system leave during grace does not apply overlay fallback', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed-then-leave');
  await tapSelector(send, '.ctl-fs');
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
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
});

uiTest('brief native enter then leave during wait does not apply overlay', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'brief-enter-leave');
  await tapSelector(send, '.ctl-fs');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await new Promise((r) => setTimeout(r, 450));
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, false, 'must not stay in is-fullscreen after a leave during wait');
  assert.equal(ui.fakeFs, false, 'leave during wait must not apply overlay after grace');
  assert.equal(ui.forcedLandscape, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
});

uiTest('async native enter then leave during wait does not apply overlay', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'async-brief-enter-leave');
  await tapSelector(send, '.ctl-fs');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  await new Promise((r) => setTimeout(r, 450));
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.fsRequests >= 1);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.fs, false, 'must not stay in is-fullscreen after an async leave during wait');
  assert.equal(ui.fakeFs, false, 'async leave during wait must not apply overlay after grace');
  assert.equal(ui.forcedLandscape, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
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

uiTest('the shell uses the Sanem mark and one SVG icon family, no emoji', async (t) => {
  const { send } = await openPlayer(t, { width: 844, height: 390, landscape: true });
  const brand = await evaluate(
    send,
    `(function(){
      const marks = [...document.querySelectorAll('.brand-mark')];
      return {
        count: marks.length,
        allSanem: marks.every((m) => m.querySelector('use')?.getAttribute('href') === '#i-sanem'),
        symbolExists: Boolean(document.querySelector('symbol#i-sanem')),
      };
    })()`
  );
  assert.ok(brand.count >= 2, 'the mark is on the header and the login card');
  assert.equal(brand.allSanem, true);
  assert.equal(brand.symbolExists, true, 'the #i-sanem symbol must be in the sprite');

  const icons = await evaluate(
    send,
    `(function(){
      // Every icon slot must be an <svg><use href="#i-*"> resolving to a real symbol.
      const hosts = [...document.querySelectorAll('.ico')];
      const bad = hosts.filter((el) => {
        if (el.tagName.toLowerCase() !== 'svg') return true;
        const href = el.querySelector('use')?.getAttribute('href') || '';
        return !href.startsWith('#i-') || !document.querySelector('symbol' + href);
      });
      // No emoji anywhere in the chrome: they cannot follow the theme.
      // Codepoint scan rather than a unicode property class, which would need
      // escaping twice to survive this template literal.
      const isEmoji = (cp) =>
        (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf);
      const chrome = [
        document.querySelector('.app-header'),
        document.querySelector('.player-container'),
      ].filter(Boolean);
      const withEmoji = chrome.filter((el) =>
        [...(el.innerText || '')].some((ch) => isEmoji(ch.codePointAt(0)))
      );
      return { hosts: hosts.length, bad: bad.length, withEmoji: withEmoji.length };
    })()`
  );
  assert.ok(icons.hosts >= 6, `expected the icon family to be in use, saw ${icons.hosts}`);
  assert.equal(icons.bad, 0, 'every .ico must be an <svg> pointing at an existing #i-* symbol');
  assert.equal(icons.withEmoji, 0, 'no emoji left in the header or the player chrome');
});

uiTest('the theme toggle swaps its icon with the theme it offers', async (t) => {
  const { send } = await openPlayer(t, { width: 844, height: 390, landscape: true });
  const read = `(function(){
    const btn = document.getElementById('theme-toggle');
    return {
      theme: document.documentElement.dataset.theme,
      label: btn.querySelector('.menu-label').textContent,
      icon: btn.querySelector('.menu-icon use').getAttribute('href'),
    };
  })()`;
  const dark = await evaluate(send, read);
  assert.equal(dark.theme, 'dark');
  assert.equal(dark.label, 'Thème clair');
  assert.equal(dark.icon, '#i-sun', 'dark theme offers the sun');
  await evaluate(send, 'document.getElementById("theme-toggle").click()');
  const light = await evaluate(send, read);
  assert.equal(light.theme, 'light');
  assert.equal(light.label, 'Thème obscur');
  assert.equal(light.icon, '#i-moon', 'light theme offers the moon');
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
    EPISODE_BADGE_MS + 4000
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
  assert.equal(ui.nextUp.label, TIP_NEXT);
  assert.equal(ui.nextUp.hasTip, true);
  assert.equal(ui.nextUp.title, null);
  assert.equal(ui.nextUp.text, '', 'chip is icon-only');
  assert.equal(ui.nextUp.icon, '#i-next');
  assert.equal(ui.nextUp.prev.hidden, true, 'first episode has no previous chip');
  assert.equal(ui.nextUp.plate, true, 'no background plate behind the icon');
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
  assert.equal(ui.bar.prevVisible, true, 'last episode still offers previous');
  assert.equal(ui.prevCtl.label, TIP_PREV);
  assert.equal(ui.prevCtl.hasTip, true);
  assert.equal(ui.prevCtl.text, '', 'previous is icon-only');
  assert.equal(ui.prevCtl.icon, '#i-prev');
});

uiTest('previous-episode control loads the previous file', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { playPath: 'Serie/e02.mp4' }
  );
  await waitFor(send, 'document.querySelector(".ctl-prev") && !document.querySelector(".ctl-prev").hidden');
  await tapSelector(send, '.ctl-prev');
  await waitFor(send, 'location.hash.includes("e01")');
  const hash = await evaluate(send, 'location.hash');
  assert.match(hash, /e01/);
});

// Hash updates in onNext before hashchange remounts. Waiting on hash +
// "current container is fullscreen" can pass against the old node (still
// native FS, no new request). The new episode's video src is set on the
// remounted node.
function nativeFsKeptOn(ep) {
  return `(() => {
    const el = document.querySelector('.player-container');
    const src = document.querySelector('video')?.getAttribute('src') || '';
    return Boolean(el)
      && src.includes(${JSON.stringify(ep)})
      && (document.fullscreenElement || document.webkitFullscreenElement) === el
      && el.classList.contains('is-fullscreen')
      && !el.classList.contains('is-fake-fullscreen');
  })()`;
}
function overlayFsKeptOn(ep) {
  return `(() => {
    const el = document.querySelector('.player-container');
    const src = document.querySelector('video')?.getAttribute('src') || '';
    return Boolean(el)
      && src.includes(${JSON.stringify(ep)})
      && el.classList.contains('is-fullscreen')
      && el.classList.contains('is-fake-fullscreen');
  })()`;
}

uiTest('next during native grace does not let the old request drop remount FS', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed-deferred');
  await tapSelector(send, '.ctl-fs');
  await waitFor(send, '(window.__fsRequests ?? 0) >= 1');
  const exitsAtHop = await evaluate(send, 'window.__fsExits ?? 0');
  await tapSelector(send, '.ctl-next');
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(send, nativeFsKeptOn('e02'));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'remount must still adopt native FS after a mid-grace hop');
  assert.equal(ui.fs, true);
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.htmlFs, true, 'old then/catch must not strip html.player-fs');
  assert.equal(ui.fsExits, exitsAtHop, 'torn-down mount must not exitNativeFs on the remount');
});

uiTest('next and previous keep native fullscreen across the remount', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      if (v) { v.loop = true; v.pause(); }
    })()`
  );
  await installFullscreenStub(send, 'succeed');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true);
  const requestsAtFull = ui.fsRequests;
  await tapSelector(send, '.ctl-next');
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(send, nativeFsKeptOn('e02'));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'native FS must survive next-episode remount');
  assert.equal(ui.fs, true);
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.forcedLandscape, false);
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.equal(ui.fsIcon, '#i-exit-fullscreen');
  assert.ok(ui.fsRequests > requestsAtFull, 're-request native FS on the new container');
  await waitFor(send, 'document.querySelector(".ctl-prev") && !document.querySelector(".ctl-prev").hidden');
  await tapSelector(send, '.ctl-prev');
  await waitFor(send, 'location.hash.includes("e01")');
  await waitFor(send, nativeFsKeptOn('e01'));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'native FS must survive previous-episode remount');
  assert.equal(ui.fs, true);
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
});

uiTest('next chip and previous keep overlay fullscreen across the remount', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'noop');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true);
  const requestsAtFull = ui.fsRequests;
  await loopAndPlay(send);
  await fakeDurationAndTime(send, 1500, 1450);
  await waitFor(
    send,
    `(() => {
      const el = document.querySelector('.next-overlay');
      return Boolean(el) && !el.hidden && !el.classList.contains('is-end');
    })()`
  );
  await clickSelector(send, '.next-up-btn');
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(send, overlayFsKeptOn('e02'));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, true, 'overlay FS must survive next-episode remount');
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.forcedLandscape, true);
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.equal(ui.fsIcon, '#i-exit-fullscreen');
  assert.equal(ui.fsRequests, requestsAtFull, 'overlay hop must not re-enter the native wait');
  await waitFor(send, 'document.querySelector(".ctl-prev") && !document.querySelector(".ctl-prev").hidden');
  await tapSelector(send, '.ctl-prev');
  await waitFor(send, 'location.hash.includes("e01")');
  await waitFor(send, overlayFsKeptOn('e01'));
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true, 'overlay FS must survive previous-episode remount');
  assert.equal(ui.fs, true);
  assert.equal(ui.forcedLandscape, true);
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
});

uiTest('ended auto-chain keeps native fullscreen', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'succeed');
  await clickFullscreen(send);
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
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(send, nativeFsKeptOn('e02'));
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true, 'ended auto-chain must stay in native fullscreen');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
});

const FS_CHROME_CLEARED = `(() => {
  const htmlFs = document.documentElement.classList.contains('player-fs');
  const el = document.querySelector('.player-container');
  const native = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const overlay = Boolean(el?.classList.contains('is-fake-fullscreen') || el?.classList.contains('is-fullscreen'));
  return !htmlFs && !native && !overlay;
})()`;

uiTest('next into a heavy warning clears keep-full so Lire quand même does not restore FS', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { fileMeta: { 'Serie/e02.mp4': { heavy: true } } }
  );
  await installFullscreenStub(send, 'noop');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.htmlFs, true);
  await tapSelector(send, '.ctl-next');
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(
    send,
    `(() => {
      const w = document.getElementById('player-warning');
      return Boolean(w) && !w.hidden && w.textContent.includes('Lire quand même');
    })()`
  );
  await waitFor(send, FS_CHROME_CLEARED);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.htmlFs, false, 'heavy warning must drop leftover player-fs chrome');
  assert.equal(ui.player, null, 'heavy warning must not mount a player yet');
  assert.equal(ui.fs, false);
  assert.equal(ui.fakeFs, false);
  await tapSelector(send, '#player-warning button');
  await waitFor(send, 'Boolean(document.querySelector(".player-container"))');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'deferred mount after heavy warning must not restore FS');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.htmlFs, false);
  assert.equal(ui.nativeFs, false);
});

uiTest('next into playback:none clears keep-full so a later playable mount does not restore FS', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { fileMeta: { 'Serie/e02.mp4': { playback: 'none' } } }
  );
  await installFullscreenStub(send, 'succeed');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nativeFs, true);
  await tapSelector(send, '.ctl-next');
  await waitFor(send, 'location.hash.includes("e02")');
  await waitFor(
    send,
    `Boolean(document.querySelector('.empty-message'))`
  );
  await waitFor(send, FS_CHROME_CLEARED);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.htmlFs, false, 'unplayable target must drop leftover player-fs chrome');
  assert.equal(ui.player, null, 'playback:none must not mount a player');
  await evaluate(send, `location.hash = ${JSON.stringify('#/lukluk/play/Serie/e01.mp4')}`);
  await waitFor(send, 'Boolean(document.querySelector(".player-container") && document.querySelector(".control-bar"))');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'later unrelated mountPlayer must not restore FS');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.nativeFs, false);
  assert.equal(ui.htmlFs, false);
});

uiTest('missing file and series route clear document FS without restoring on the next play', async (t) => {
  const { send } = await openPlayer(t, { width: 390, height: 844, landscape: false });
  await installFullscreenStub(send, 'noop');
  await clickFullscreen(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fakeFs, true);
  assert.equal(ui.htmlFs, true);
  await evaluate(send, `location.hash = ${JSON.stringify('#/lukluk/play/Serie/missing.mp4')}`);
  await waitFor(send, `Boolean(document.querySelector('.empty-message'))`);
  await waitFor(send, FS_CHROME_CLEARED);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.htmlFs, false, 'missing file must drop leftover player-fs chrome');
  await evaluate(send, `location.hash = ${JSON.stringify('#/lukluk/serie/Serie')}`);
  await waitFor(send, 'Boolean(document.querySelector(".serie-hero-play"))');
  await waitFor(send, FS_CHROME_CLEARED);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.htmlFs, false, 'non-player series route must not keep player-fs');
  await evaluate(send, `location.hash = ${JSON.stringify('#/lukluk/play/Serie/e01.mp4')}`);
  await waitFor(send, 'Boolean(document.querySelector(".player-container") && document.querySelector(".control-bar"))');
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fs, false, 'play after a non-player route must not restore FS');
  assert.equal(ui.fakeFs, false);
  assert.equal(ui.htmlFs, false);
});

uiTest('previous and next stay hidden on a non-series root file', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { playPath: 'loose.mp4', extraFiles: ['loose.mp4'] }
  );
  await waitFor(send, 'Boolean(document.querySelector(".control-bar"))');
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.bar.prevVisible, false, 'root upload has no previous episode');
  assert.equal(ui.bar.nextVisible, false, 'root upload has no next episode');
  assert.equal(ui.prevCtl.hidden, true);
  assert.equal(ui.nextCtl.hidden, true);
});

uiTest('near-end chips pair previous and next as icon-only controls', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 390, height: 844, landscape: false },
    { extraFiles: ['Serie/e00.mp4'] }
  );
  await loopAndPlay(send);
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.bar.prevVisible, true, 'middle episode offers previous');
  assert.equal(ui.bar.nextVisible, true, 'middle episode offers next');
  await fakeDurationAndTime(send, 1500, 1450);
  await waitFor(
    send,
    `(() => {
      const el = document.querySelector('.next-overlay');
      return Boolean(el) && !el.hidden && !el.classList.contains('is-end');
    })()`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.nextUp.hidden, false);
  assert.equal(ui.nextUp.prev.hidden, false, 'previous chip sits with the next chip');
  assert.equal(ui.nextUp.prev.label, TIP_PREV);
  assert.equal(ui.nextUp.prev.hasTip, true);
  assert.equal(ui.nextUp.prev.title, null);
  assert.equal(ui.nextUp.prev.text, '', 'previous chip is icon-only');
  assert.equal(ui.nextUp.prev.icon, '#i-prev');
  assert.equal(ui.nextUp.label, TIP_NEXT);
  assert.equal(ui.nextUp.hasTip, true);
  assert.equal(ui.nextUp.title, null);
  assert.equal(ui.nextUp.text, '', 'next chip is icon-only');
  assert.equal(ui.nextUp.icon, '#i-next');
  await clickSelector(send, '.prev-up-btn');
  await waitFor(send, 'location.hash.includes("e00")');
});

uiTest('episode chrome tooltips are French aria-labels, not visible text', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 900, height: 600 },
    { phone: false, extraFiles: ['Serie/e00.mp4'] }
  );
  await waitFor(send, 'document.querySelector(".ctl-prev") && !document.querySelector(".ctl-prev").hidden');
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.prevCtl.text, '');
  assert.equal(ui.nextCtl.text, '');
  assert.equal(ui.prevCtl.label, TIP_PREV);
  assert.equal(ui.nextCtl.label, TIP_NEXT);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
  assert.equal(ui.fsHasTip, true);
  assert.equal(ui.fsTitle, null, 'T1: no native title= on fullscreen');
  assert.equal(ui.prevCtl.hasTip, true);
  assert.equal(ui.nextCtl.hasTip, true);
  assert.equal(ui.prevCtl.title, null);
  assert.equal(ui.nextCtl.title, null);
  assert.match(ui.prevCtl.tip, /Épisode précédent/);
  assert.match(ui.prevCtl.tip, /Page précédente/);
  assert.match(ui.nextCtl.tip, /Épisode suivant/);
  assert.match(ui.nextCtl.tip, /Page suivante/);
  const fsTip = await evaluate(send, 'getComputedStyle(document.querySelector(".ctl-fs"), "::after").content');
  assert.match(fsTip, /Plein écran/);
  assert.match(fsTip, /raccourci : F/);
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      if (!v) return;
      v.muted = false;
      if (!v.volume) v.volume = 0.8;
      v.dispatchEvent(new Event('volumechange'));
    })()`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.muteCtl.hasTip, true);
  assert.equal(ui.muteCtl.title, null, 'T1: no native title= on mute');
  assert.equal(ui.muteCtl.label, TIP_MUTE);
  assert.equal(ui.volumeCtl.wrapHasTip, true);
  assert.equal(ui.volumeCtl.wrapTitle, null);
  assert.equal(ui.volumeCtl.inputTitle, null);
  assert.equal(ui.volumeCtl.wrapLabel, TIP_VOLUME);
  assert.match(ui.volumeCtl.wrapLabel, /flèche haut/);
  assert.match(ui.volumeCtl.wrapLabel, /flèche en bas/);
  assert.equal(ui.volumeCtl.inputLabel, 'Volume');
  const volTip = await evaluate(
    send,
    'getComputedStyle(document.querySelector(".volume-wrap"), "::after").content'
  );
  assert.match(volTip, /flèche haut/);
  assert.match(volTip, /flèche en bas/);
});

uiTest('mute toggle and fullscreen labels document their shortcuts', async (t) => {
  const { send } = await openPlayer(t, { width: 900, height: 600 }, { phone: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      v.muted = false;
      v.volume = 0.8;
      v.dispatchEvent(new Event('volumechange'));
    })()`
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.muteCtl.label, TIP_MUTE);
  assert.equal(ui.fsLabel, TIP_FS_ENTER);
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true, cancelable: true }))`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.muteCtl.label, TIP_UNMUTE);
  const muted = await evaluate(send, 'Boolean(document.querySelector("video")?.muted)');
  assert.equal(muted, true);
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true, cancelable: true }))`
  );
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.muteCtl.label, TIP_MUTE);
  await installFullscreenStub(send, 'succeed');
  await clickFullscreen(send);
  ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.fsLabel, TIP_FS_EXIT);
  assert.match(ui.fsLabel, /raccourci : F/);
  assert.equal(ui.fsTitle, null);
});

uiTest('PageDown and PageUp hop episodes and no-op without a sibling', async (t) => {
  const { send } = await openPlayer(
    t,
    { width: 900, height: 600 },
    { phone: false, extraFiles: ['Serie/e00.mp4'] }
  );
  await waitFor(send, 'document.querySelector(".ctl-prev") && !document.querySelector(".ctl-prev").hidden');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))`
  );
  await waitFor(send, 'location.hash.includes("e02")');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))`
  );
  await new Promise((r) => setTimeout(r, 200));
  let hash = await evaluate(send, 'location.hash');
  assert.match(hash, /e02/, 'PageDown on the last episode must not leave the series');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }))`
  );
  await waitFor(send, 'location.hash.includes("e01")');
  await evaluate(
    send,
    `location.hash = ${JSON.stringify('#/lukluk/play/Serie/e00.mp4')}`
  );
  await waitFor(send, 'location.hash.includes("e00") && Boolean(document.querySelector("video"))');
  await waitFor(send, 'document.querySelector(".ctl-prev") && document.querySelector(".ctl-prev").hidden');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }))`
  );
  await new Promise((r) => setTimeout(r, 200));
  hash = await evaluate(send, 'location.hash');
  assert.match(hash, /e00/, 'PageUp on the first episode is a no-op');
});

uiTest('ArrowUp and ArrowDown adjust volume; text inputs keep their keys', async (t) => {
  const { send } = await openPlayer(t, { width: 900, height: 600 }, { phone: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      v.volume = 0.5;
      v.muted = false;
      v.dispatchEvent(new Event('volumechange'));
    })()`
  );
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`
  );
  let vol = await evaluate(send, 'document.querySelector("video").volume');
  assert.equal(vol, 0.5 + VOLUME_STEP);
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`
  );
  vol = await evaluate(send, 'document.querySelector("video").volume');
  assert.equal(vol, 0.5);
  const stolen = await evaluate(
    send,
    `(function(){
      const input = document.createElement('input');
      input.type = 'text';
      document.body.appendChild(input);
      input.focus();
      const before = location.hash;
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'PageDown',
        bubbles: true,
        cancelable: true,
      }));
      const hash = location.hash;
      input.remove();
      return { before, hash };
    })()`
  );
  assert.equal(stolen.hash, stolen.before, 'PageDown must not hop while a text input is focused');
});

uiTest('Ctrl+ArrowUp after volume hits 0 restores last audible level', async (t) => {
  const { send } = await openPlayer(t, { width: 900, height: 600 }, { phone: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const slider = document.querySelector('.volume');
      slider.value = '0.4';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.value = '0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  let audio = await evaluate(
    send,
    `({ volume: document.querySelector('video').volume, muted: document.querySelector('video').muted })`
  );
  assert.equal(audio.volume, 0);
  assert.equal(audio.muted, true);
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true, cancelable: true }))`
  );
  audio = await evaluate(
    send,
    `({
      volume: document.querySelector('video').volume,
      muted: document.querySelector('video').muted,
      label: document.querySelector('.ctl-mute')?.getAttribute('aria-label'),
    })`
  );
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 0.4, 'unmute must restore the last non-zero volume, not stay at 0');
  assert.equal(audio.label, TIP_MUTE);
});

uiTest('unmute after ArrowDown to 0 restores a non-zero volume', async (t) => {
  const { send } = await openPlayer(t, { width: 900, height: 600 }, { phone: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const slider = document.querySelector('.volume');
      slider.value = '0.1';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  for (let i = 0; i < 4; i += 1) {
    await evaluate(
      send,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`
    );
  }
  let audio = await evaluate(
    send,
    `({ volume: document.querySelector('video').volume, muted: document.querySelector('video').muted })`
  );
  assert.equal(audio.volume, 0);
  assert.equal(audio.muted, true);
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true, cancelable: true }))`
  );
  audio = await evaluate(
    send,
    `({ volume: document.querySelector('video').volume, muted: document.querySelector('video').muted })`
  );
  assert.equal(audio.muted, false);
  assert.ok(audio.volume > 0, `unmute after bump-to-zero must restore sound, got ${audio.volume}`);
});

uiTest('volume range ArrowLeft/Right do not seek playback', async (t) => {
  const { send } = await openPlayer(t, { width: 900, height: 600 }, { phone: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      v.currentTime = 1;
      const slider = document.querySelector('.volume');
      slider.value = '0.5';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.focus();
      slider.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      }));
    })()`
  );
  const after = await evaluate(
    send,
    `({ t: document.querySelector('video').currentTime, ae: document.activeElement?.className })`
  );
  assert.ok(after.ae.includes('volume'), 'volume range must keep focus');
  assert.ok(after.t > 0.4, `ArrowLeft on volume must not seek -10s, currentTime=${after.t}`);
});

uiTest('mute click restores audio when silenced even if muted is false', async (t) => {
  const { send } = await openPlayer(t, { width: 900, height: 600 }, { phone: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const slider = document.querySelector('.volume');
      slider.value = '0.4';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const v = document.querySelector('video');
      v.volume = 0;
      v.muted = false;
      v.dispatchEvent(new Event('volumechange'));
    })()`
  );
  let ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.muteCtl.label, TIP_UNMUTE);
  await evaluate(send, 'document.querySelector(".ctl-mute").click()');
  const audio = await evaluate(
    send,
    `({
      volume: document.querySelector('video').volume,
      muted: document.querySelector('video').muted,
      label: document.querySelector('.ctl-mute')?.getAttribute('aria-label'),
    })`
  );
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 0.4);
  assert.equal(audio.label, TIP_MUTE);
});

uiTest('last audible volume survives remount after hitting 0', async (t) => {
  const { send } = await openPlayer(t, { width: 900, height: 600 }, { phone: false });
  await loopAndPlay(send);
  await evaluate(
    send,
    `(function(){
      const slider = document.querySelector('.volume');
      slider.value = '0.4';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.value = '0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  const stored = await evaluate(
    send,
    `({ volume: localStorage.getItem('sanem-volume'), muted: localStorage.getItem('sanem-muted') })`
  );
  assert.equal(stored.volume, '0.4', 'VOLUME_KEY must keep last non-zero, not 0');
  assert.equal(stored.muted, '1');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))`
  );
  await waitFor(send, 'location.hash.includes("e02") && Boolean(document.querySelector("video"))');
  await evaluate(
    send,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true, cancelable: true }))`
  );
  const audio = await evaluate(
    send,
    `({ volume: document.querySelector('video').volume, muted: document.querySelector('video').muted })`
  );
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 0.4, 'remount must seed last audible from VOLUME_KEY');
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  await mouseMoveOnPlayer(send);
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
  // Fixture is 2 s and the series always has e02. Autoplay `ended` auto-chains
  // (keep-full remount, castAlive=false) during the slowed mint, so prompt
  // never runs — CI DIAG src was /api/media/Serie/e02.mp4. Pin this mount.
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('video');
      if (!v) return;
      v.loop = true;
      v.pause();
    })()`
  );
  await waitFor(send, 'document.querySelector(".cast-btn")?.hidden === false');
  const readyBefore = await evaluate(
    send,
    'document.querySelector(".cast-btn")?.getAttribute("data-cast-ready")'
  );
  assert.equal(readyBefore, null, 'click before prefetch must exercise the refresh chain');
  await mouseMoveOnPlayer(send);
  await waitFor(send, 'document.querySelector(".player-container")?.classList.contains("controls-visible") === true');
  await waitFor(send, 'location.hash.includes("e01")');
  await clickSelector(send, '.cast-btn');
  // Mint is delayed 2 s (slowCastUrlMs). Stay on e01; if we hopped, prompt
  // will never come (old mount's then() sees !castAlive).
  try {
    await waitFor(send, '(window.__remotePrompts ?? 0) >= 1', 15000);
  } catch (err) {
    const diag = await evaluate(
      send,
      `JSON.stringify({
        prompts: window.__remotePrompts ?? null,
        fetches: (window.__castUrlFetchCache || []).length,
        ready: document.querySelector('.cast-btn')?.getAttribute('data-cast-ready') ?? null,
        hidden: document.querySelector('.cast-btn')?.hidden ?? null,
        vis: document.visibilityState,
        hash: location.hash,
        src: (document.querySelector('video')?.getAttribute('src') || '').slice(0, 80),
      })`
    );
    throw new Error(`${err.message} | DIAG ${diag}`);
  }
  const ui = await evaluate(send, SNAPSHOT);
  assert.ok(ui.remotePrompts >= 1, 'same gesture must prompt once mint succeeds');
  assert.match(ui.videoSrc, /\/api\/media\/Serie\/e01\.mp4/);
  assert.match(ui.videoSrc, /[?&]sig=/);
  assert.match(await evaluate(send, 'location.hash'), /e01/, 'must not have auto-chained off the minting episode');
});

test('volumeAfterUnmute restores last audible when volume is 0', () => {
  assert.equal(volumeAfterUnmute(0.8, 0.4), 0.8);
  assert.equal(volumeAfterUnmute(0, 0.4), 0.4);
  assert.equal(volumeAfterUnmute(0, 0), VOLUME_STEP);
  assert.equal(volumeAfterUnmute(0, Number.NaN), VOLUME_STEP);
  assert.equal(volumeAfterUnmute(0, 1.5), 1);
});

test('volumeToPersist never stores zero', () => {
  assert.equal(volumeToPersist(0.4, 0.8), 0.4);
  assert.equal(volumeToPersist(0, 0.4), 0.4);
  assert.equal(volumeToPersist(0, 0), null);
  assert.equal(volumeToPersist(0, Number.NaN), null);
  assert.equal(volumeToPersist(1.5, 0.2), 1);
});

test('playerKeyCommand maps watching shortcuts and ignores typing targets', () => {
  assert.equal(VOLUME_STEP, 0.05);
  assert.equal(TIP_MUTE, 'Couper le son (raccourci : Contrôle + flèche en bas)');
  assert.equal(TIP_UNMUTE, 'Réactiver le son (raccourci : Contrôle + flèche haut)');
  assert.equal(TIP_VOLUME, 'Volume (raccourci : flèche haut / flèche en bas)');
  const body = { tagName: 'BODY' };
  const cmd = (key, extra = {}) => playerKeyCommand({ key, target: body, ctrlKey: false, altKey: false, ...extra });
  assert.equal(cmd('PageDown'), 'nextEpisode');
  assert.equal(cmd('PageUp'), 'prevEpisode');
  assert.equal(cmd('ArrowUp'), 'volumeUp');
  assert.equal(cmd('ArrowDown'), 'volumeDown');
  assert.equal(cmd('ArrowDown', { ctrlKey: true }), 'mute');
  assert.equal(cmd('ArrowUp', { ctrlKey: true }), 'unmute');
  assert.equal(cmd('f'), 'toggleFull');
  assert.equal(cmd('F'), 'toggleFull');
  assert.equal(cmd('ArrowUp', { altKey: true }), null);
  assert.equal(cmd('ArrowLeft'), 'seekBack');
  assert.equal(cmd('ArrowRight'), 'seekFwd');
  assert.equal(cmd(' '), 'togglePlay');
  assert.equal(
    cmd(' ', { target: { tagName: 'BUTTON', closest: (sel) => (sel === 'button' ? {} : null) } }),
    null,
    'Space on a button must not double-toggle'
  );
  const text = { tagName: 'INPUT', type: 'text' };
  assert.equal(isPlayerTypingTarget(text), true);
  assert.equal(playerKeyCommand({ key: 'PageDown', target: text }), null);
  const range = { tagName: 'INPUT', type: 'range' };
  assert.equal(isPlayerTypingTarget(range), false);
  assert.equal(playerKeyCommand({ key: 'ArrowUp', target: range, ctrlKey: false, altKey: false }), 'volumeUp');
  assert.equal(playerKeyCommand({ key: 'ArrowDown', target: range, ctrlKey: false, altKey: false }), 'volumeDown');
  assert.equal(playerKeyCommand({ key: 'ArrowDown', target: range, ctrlKey: true, altKey: false }), 'mute');
  assert.equal(
    playerKeyCommand({ key: 'ArrowLeft', target: range, ctrlKey: false, altKey: false }),
    null,
    'focused volume range must keep native Left/Right'
  );
  assert.equal(
    playerKeyCommand({ key: 'ArrowRight', target: range, ctrlKey: false, altKey: false }),
    null
  );
  assert.equal(isPlayerTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isPlayerTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isPlayerTypingTarget({ tagName: 'DIV' }), false);
});

test('notePointerPosition ignores the seed event and zero-delta moves', () => {
  assert.equal(BAR_HIDE_MS, 2000);
  assert.equal(POINTER_MOVE_MIN_PX, 1);
  const seed = notePointerPosition(null, 10, 20);
  assert.equal(seed.moved, false, 'first pixel only seeds last position');
  assert.deepEqual(seed.pos, { x: 10, y: 20 });
  const same = notePointerPosition(seed.pos, 10, 20);
  assert.equal(same.moved, false, 'Firefox same-coordinate pointermove is not activity');
  assert.deepEqual(same.pos, { x: 10, y: 20 });
  const jitter = notePointerPosition(seed.pos, 10.4, 20.2);
  assert.equal(jitter.moved, false, 'sub-pixel jitter must not accumulate into a reveal');
  assert.deepEqual(jitter.pos, { x: 10, y: 20 });
  const moved = notePointerPosition(seed.pos, 12, 20);
  assert.equal(moved.moved, true);
  assert.deepEqual(moved.pos, { x: 12, y: 20 });
  const nan = notePointerPosition(seed.pos, Number.NaN, 20);
  assert.equal(nan.moved, false);
  assert.deepEqual(nan.pos, { x: 10, y: 20 });
});

test('pointInRect is a closed box used for chrome hover-hold', () => {
  const box = { left: 0, right: 10, top: 0, bottom: 10 };
  assert.equal(pointInRect(box, 0, 0), true);
  assert.equal(pointInRect(box, 10, 10), true);
  assert.equal(pointInRect(box, 5, 5), true);
  assert.equal(pointInRect(box, 11, 5), false);
  assert.equal(pointInRect(box, 5, -1), false);
  assert.equal(pointInRect(null, 1, 1), false);
  assert.equal(
    pointInRect({ left: 0, right: 0, top: 0, bottom: 0 }, 0, 0),
    false,
    'degenerate 0×0 rect at origin is not a hit'
  );
});

test('pointerLeaveAbandonsChrome ignores leave still inside bar or cast', () => {
  const bar = { left: 0, right: 100, top: 80, bottom: 120 };
  const cast = { left: 200, right: 240, top: 8, bottom: 48 };
  const rects = [bar, cast];
  assert.equal(pointerLeaveAbandonsChrome(true, 10, 10, rects), false, 'relatedTarget in chrome keeps hold');
  assert.equal(pointerLeaveAbandonsChrome(false, 50, 100, rects), false, 'coords still in the bar');
  assert.equal(pointerLeaveAbandonsChrome(false, 220, 20, rects), false, 'coords still on the cast button');
  assert.equal(pointerLeaveAbandonsChrome(false, 50, 10, rects), true, 'coords in the video, not chrome');
  assert.equal(pointerLeaveAbandonsChrome(false, 0, 0, rects), true, 'missing/default coords are a real leave');
  assert.equal(
    pointerLeaveAbandonsChrome(false, 0, 0, [{ left: 0, right: 0, top: 0, bottom: 0 }]),
    true,
    'empty hidden-cast rect at origin must not swallow a synthetic leave'
  );
});

test('episodeLabel reads the number off a release-style filename', () => {
  assert.equal(episodeLabel({ name: 'Dr.STONE.S04E18.MULTi.1080p.mkv' }), 'Épisode 18');
  assert.equal(episodeLabel({ name: 'e01.mp4' }), 'Épisode 1');
  assert.equal(episodeLabel({ name: 'film.mkv' }), 'film.mkv', 'no marker -> bare filename');
});

test('seriesSiblings follows the files collator inside one folder', () => {
  const files = [
    { path: 'Serie/S01E10.mkv', dir: 'Serie', name: 'S01E10.mkv' },
    { path: 'Serie/S01E09.mkv', dir: 'Serie', name: 'S01E09.mkv' },
    { path: 'Other/e01.mkv', dir: 'Other', name: 'e01.mkv' },
    { path: 'loose.mp4', dir: null, name: 'loose.mp4' },
  ];
  const first = seriesSiblings({ path: 'Serie/S01E09.mkv', dir: 'Serie' }, files);
  assert.equal(first.prev, null);
  assert.equal(first.next.path, 'Serie/S01E10.mkv');
  const last = seriesSiblings({ path: 'Serie/S01E10.mkv', dir: 'Serie' }, files);
  assert.equal(last.prev.path, 'Serie/S01E09.mkv');
  assert.equal(last.next, null);
  assert.deepEqual(seriesSiblings({ path: 'loose.mp4', dir: null }, files), { prev: null, next: null });
  assert.deepEqual(seriesSiblings({ path: 'Other/e01.mkv', dir: 'Other' }, files), {
    prev: null,
    next: null,
  });
});

test('episode badge hides after 5 seconds', (t) => {
  assert.equal(EPISODE_BADGE_MS, 5000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const classes = new Set();
  const badge = { classList: { add: (c) => classes.add(c) } };
  scheduleBadgeHide(badge);
  t.mock.timers.tick(EPISODE_BADGE_MS - 1);
  assert.equal(classes.has('is-gone'), false, 'still visible just before 5 s');
  t.mock.timers.tick(1);
  assert.equal(classes.has('is-gone'), true, 'gone at 5 s');
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
  await mouseMoveOnPlayer(send);
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







