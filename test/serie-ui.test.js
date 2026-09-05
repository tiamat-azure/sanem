// Browser E2E for the Lukluk series screen (PRD §11.1): featured episode hero
// plus a horizontal episode rail. Covers the three-state action verb
// (Lire / Reprendre / Revoir), the status markers shared by the rail card and
// the hero poster, the hover-only arrows, and where the rail starts.
//
// Same harness as the player suite: system Chrome over CDP, seeded probe cache,
// no npm dependency and no ffmpeg.

import assert from 'node:assert/strict';
import {
  uiTest,
  startServer,
  loginCookie,
  openChrome,
  setDesktopViewport,
  evaluate,
  waitFor,
  clickSelector,
} from './helpers/browser.js';
import { DONE_RATIO } from '../public/player.js';

const SERIE = 'Serie';
const E01 = 'Serie/e01.mp4';
const E02 = 'Serie/e02.mp4';

// Opens the series screen with the given localStorage state pre-seeded, so the
// screen renders against a known watch history.
async function openSerie(t, { positions = {}, done = [] } = {}) {
  const { baseUrl } = await startServer(t);
  const cookie = await loginCookie(baseUrl);
  const { send } = await openChrome(t, { touch: false });
  await setDesktopViewport(send, { width: 1280, height: 800 });
  await send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    url: baseUrl,
    httpOnly: true,
    path: '/',
  });
  const seed = [
    ...Object.entries(positions).map(
      ([p, s]) => `localStorage.setItem('sanem-pos:' + ${JSON.stringify(p)}, '${s}');
        localStorage.setItem('sanem-watched:' + ${JSON.stringify(p)}, String(Date.now()));`
    ),
    ...done.map(
      (p) => `localStorage.setItem('sanem-done:' + ${JSON.stringify(p)}, String(Date.now()));`
    ),
  ].join('\n');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function(){ try { ${seed} } catch (e) { /* first load has no storage */ } })();`,
  });
  await send('Page.navigate', {
    url: `${baseUrl}/#/lukluk/serie/${encodeURIComponent(SERIE)}`,
  });
  await waitFor(send, 'Boolean(document.querySelector(".rail-card"))');
  return { send, baseUrl };
}

const SNAPSHOT = `({
  cards: [...document.querySelectorAll('.rail-card')].map((c) => ({
    cap: c.querySelector('.rail-cap')?.textContent ?? null,
    current: c.classList.contains('is-current'),
    seen: Boolean(c.querySelector('.seen-badge')),
    resume: Boolean(c.querySelector('.thumb-resume')),
  })),
  heroTitle: document.querySelector('.serie-hero-body h2')?.textContent ?? null,
  heroFile: document.querySelector('.serie-hero-file')?.textContent ?? null,
  heroMeta: document.querySelector('.serie-hero-meta')?.textContent ?? null,
  heroAction: document.querySelector('.serie-hero-play')?.textContent ?? null,
  heroSeen: Boolean(document.querySelector('.serie-hero-poster .seen-badge')),
  heroResume: Boolean(document.querySelector('.serie-hero-poster .thumb-resume')),
  count: document.getElementById('serie-count')?.textContent ?? null,
  listFallback: Boolean(document.querySelector('.episode-list')),
})`;

uiTest('series screen shows a hero plus one rail card per episode', async (t) => {
  const { send } = await openSerie(t);
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cards.length, 2, 'one card per episode');
  assert.equal(ui.listFallback, false, 'the vertical list is gone');
  assert.deepEqual(
    ui.cards.map((c) => c.cap),
    ['Épisode 1', 'Épisode 2'],
    'the episode number is lifted out of the filename'
  );
  assert.ok(ui.heroTitle, 'hero renders a title');
  assert.match(ui.count, /2 épisodes/);
});

uiTest('unseen episode offers Lire, and the hero carries no status marker', async (t) => {
  const { send } = await openSerie(t);
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.heroAction, 'Lire');
  assert.equal(ui.heroSeen, false);
  assert.equal(ui.heroResume, false);
  assert.equal(ui.cards[0].current, true, 'nothing watched: start on the first episode');
});

uiTest('in-progress episode offers Reprendre and a magenta resume bar', async (t) => {
  const { send } = await openSerie(t, { positions: { [E01]: 1 } });
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.heroAction, 'Reprendre');
  assert.equal(ui.heroResume, true, 'hero poster mirrors the rail resume bar');
  assert.equal(ui.heroSeen, false, 'in progress is not done');
  assert.match(ui.heroMeta, /reprendre à/);
  assert.equal(ui.cards[0].resume, true);
});

uiTest('finished episode offers Revoir and a green check on both zones', async (t) => {
  const { send } = await openSerie(t, { done: [E01, E02] });
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.heroAction, 'Revoir');
  assert.equal(ui.heroSeen, true, 'hero poster mirrors the rail seen badge');
  assert.equal(ui.heroResume, false, 'a finished episode has no resume position left');
  assert.deepEqual(
    ui.cards.map((c) => c.seen),
    [true, true]
  );
  assert.match(ui.count, /2 vus/);
});

uiTest('rail starts on the episode in progress, not on the first one', async (t) => {
  const { send } = await openSerie(t, { done: [E01], positions: { [E02]: 1 } });
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cards[1].current, true, 'E02 is the one being watched');
  assert.equal(ui.cards[0].current, false);
  assert.equal(ui.heroAction, 'Reprendre');
});

uiTest('with everything finished the rail falls back to the first episode', async (t) => {
  const { send } = await openSerie(t, { done: [E01, E02] });
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cards[0].current, true);
});

uiTest('rail starts on the first unfinished episode when nothing is in progress', async (t) => {
  const { send } = await openSerie(t, { done: [E01] });
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cards[1].current, true, 'E01 is done: land on E02');
  assert.equal(ui.heroAction, 'Lire');
});

uiTest('clicking a rail card retargets the hero', async (t) => {
  const { send } = await openSerie(t, { done: [E01] });
  const before = await evaluate(send, SNAPSHOT);
  assert.equal(before.heroFile, 'e02.mp4');
  await clickSelector(send, '.rail-card');
  const after = await evaluate(send, SNAPSHOT);
  assert.equal(after.heroFile, 'e01.mp4');
  assert.equal(after.heroAction, 'Revoir', 'the retargeted hero re-derives its verb');
  assert.equal(after.cards[0].current, true);
  assert.equal(after.cards[1].current, false);
});

uiTest('arrows stay hidden until hover and disable at both ends', async (t) => {
  const { send } = await openSerie(t);
  const arrows = await evaluate(
    send,
    `(function(){
      const prev = document.querySelector('.rail-arrow.prev');
      const next = document.querySelector('.rail-arrow.next');
      return {
        prevOpacity: getComputedStyle(prev).opacity,
        prevDisabled: prev.disabled,
        // Only two short cards: the track never overflows, so next is spent too.
        nextDisabled: next.disabled,
      };
    })()`
  );
  assert.equal(arrows.prevOpacity, '0', 'arrows are a hover affordance, not chrome');
  assert.equal(arrows.prevDisabled, true, 'at the left edge');
  assert.equal(arrows.nextDisabled, true, 'nothing to scroll to');
});

uiTest('hero Lire navigates to the player for the focused episode', async (t) => {
  const { send } = await openSerie(t);
  await clickSelector(send, '.serie-hero-play');
  await waitFor(send, 'Boolean(document.querySelector(".player-container"))');
  const hash = await evaluate(send, 'location.hash');
  assert.equal(hash, `#/lukluk/play/${encodeURIComponent(E01)}`);
});

uiTest('crossing the done ratio drops the resume position and marks the episode done', async (t) => {
  const { send, baseUrl } = await openSerie(t);
  await send('Page.navigate', {
    url: `${baseUrl}/#/lukluk/play/${encodeURIComponent(E01)}`,
  });
  await waitFor(send, 'Boolean(document.querySelector(".player-container"))', 25000);
  // Drive the video past DONE_RATIO and let timeupdate persist the transition.
  await evaluate(
    send,
    `(function(){
      const v = document.querySelector('.player-container video');
      v.currentTime = v.duration * ${DONE_RATIO} + 0.05;
    })()`
  );
  await waitFor(
    send,
    `Boolean(localStorage.getItem('sanem-done:' + ${JSON.stringify(E01)}))`,
    25000
  );
  const stored = await evaluate(
    send,
    `({
      pos: localStorage.getItem('sanem-pos:' + ${JSON.stringify(E01)}),
      done: Boolean(localStorage.getItem('sanem-done:' + ${JSON.stringify(E01)})),
    })`
  );
  assert.equal(stored.pos, null, 'resume position is dropped past the ratio');
  assert.equal(stored.done, true, 'and a persistent done marker takes its place');

  // Walk back the way a viewer does, through the player's back link. This test
  // crosses two full screen mounts, so it needs more than the default budget
  // when the whole suite loads the machine.
  await clickSelector(send, '#player-back');
  await waitFor(send, 'Boolean(document.querySelector(".rail-card"))', 25000);
  const ui = await evaluate(send, SNAPSHOT);
  assert.equal(ui.cards[0].seen, true);
  assert.equal(ui.cards[1].current, true, 'and the rail moves on to the next episode');
});
