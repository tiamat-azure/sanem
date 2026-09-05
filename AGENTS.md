# AGENTS.md

## What this project does

Sanem is a self-hosted web service with two journeys, exposed publicly through Tailscale
Funnel behind a single shared password (no accounts):

- **Putum** (drop): remote friends drag & drop large files (~1.5 GB animes) over the
  resumable tus protocol. Uploads resume automatically after a network cut.
- **Lukluk** (watch): after login, browse a video library, stream in a custom player with
  next-episode chaining, or download. Non-playable files stay listed and downloadable.

A first-level folder in `uploads/` is a **series** - the only, deliberately flat, unit of
organization (one folder level max).

**PRD.md is the binding specification.** Choices marked "imposé" are locked; do not
deviate without asking the project owner. The `Makefile` is the one approved exception to
the PRD §3 file tree. Threat model note: from v3, the password also gates *read* access to
all content (PRD §8) - never weaken the `/api/login` rate limiting.

## Commands

`make help` lists all targets (`start`, `stop`, `restart`, `status`, `logs`, `build`,
`test`, `lint`, `thumbs`, `funnel-start/stop/status`). Prefer it over raw
`docker compose`/ `tailscale`. `make thumbs` pre-warms the probe/thumbnail/HLS-plan caches
by driving the running service's HTTP API - it adds no code, and `thumbs/`/`transcode/`
stay pure caches (PRD §6, §7.3).

```bash
npm install
npm start          # requires SANEM_PASSWORD + SANEM_SESSION_SECRET, see .env.example
npm test           # node --test - unit + integration; run before every change
npm run lint       # eslint .
make start         # full stack via docker compose, reads .env
```

`ffmpeg`/`ffprobe` are system binaries from the Docker image, not npm deps. Tests never
require them (missing binary => `playback: "none"`).

## Architecture

- `src/server.js` - Express bootstrap, route mounting order (see Known pitfalls).
- `src/config.js` - env var validation, fails fast on startup (PRD §5).
- `src/auth.js` - session cookie, `/api/login|logout|session`, rate limiting.
- `src/tus.js` - `@tus/server` + `@tus/file-store` at `/files`; `onUploadFinish` does the
  tmp -> `uploads/<series>/` rename, sidecar cleanup, and fires non-blocking media probe.
- `src/filename.js` - path sanitization + dedup, returns `(folder, name)`, one folder
  level max, realpath containment assertion (PRD §9, security-critical).
- `src/files.js` - `GET /api/files`, tree listing + media metadata.
- `src/media.js` - `GET /api/media|download/*splat`, direct read + `Range`/`206`.
- `src/transcode.js` - `ffprobe`, compat matrix, on-demand segmented HLS (PRD §10).
- `src/thumbs.js` - thumbnail extraction + cache (PRD §10.6).
- `src/cleanup.js` - `tmp/` safety-net sweep + `transcode/` LRU purge (PRD §7).
- `public/` - `index.html` (page + `#i-*` SVG icon sprite) + `favicon.svg` + `app.js` (screen router, Uppy dashboard, library, series
  hero + episode rail) + `player.js` (custom controls, touch zones, next episode,
  watch-state persistence) + `style.css` (neon theme).
- `test/` - `filename.test.js`, `media.test.js`, `resume.test.js`, `player-ui.test.js`
  (Chrome E2E for the player overlay and phone fullscreen), `serie-ui.test.js` (Chrome
  E2E for the series hero + rail), `helpers/browser.js` (shared CDP harness).

Full API table, storage layout, transcode matrix: PRD §6-10.

## Code conventions

- Plain Node.js ESM (`type: module`), no bundler, no frontend framework. Uppy v5 and
  hls.js load via pinned CDN `<script>` in `public/index.html`.
- `package.json` versions pinned exactly (no `^`/`~`); no new npm dep in v3.
- Comments and code in English; UI copy in French (PRD §2).
- Icons: one stroked 24x24 SVG family declared once as `<symbol id="i-*">` in
  `index.html`, instantiated with `<use href="#i-*">`. No emoji, no icon font (PRD §11.5).
- `ffmpeg`/`ffprobe` via `execFile` with an argument array, never a shell string.

## Tests

- `test/filename.test.js` - path traversal, Windows separators, unicode, truncation,
  per-folder dedup, symlinked series folder rejected, `a/b/c/d.mkv` -> `c/d.mkv`.
- `test/media.test.js` - `Range` -> `206` + exact bytes, encoded `../` -> `404`, the four
  media routes -> `401` without a session cookie.
- `test/resume.test.js` - real server on an ephemeral port, ~50 MB upload with
  `tus-js-client`, abort after 2 chunks, resume on the same URL, assert offset didn't
  reset, final hash matches, `tmp/` empty. **Main guardrail; never weaken or slow it** -
  this is why media probing is non-blocking.
- `test/player-ui.test.js` - system Chrome via CDP: smartphone portrait + landscape
  viewports, overlay toggle, single-row toolbar, hamburger chrome, fullscreen covers
  the long edge. Needs `google-chrome` / Chromium on the machine; no extra npm dep.
- `test/serie-ui.test.js` - series screen: Lire / Reprendre / Revoir verb, seen badge and
  resume bar mirrored on the hero poster, where the rail starts, hover-only arrows.
- `test/helpers/browser.js` - the CDP harness both UI suites share (ephemeral server with
  a seeded probe cache, Chrome launch, `evaluate` / `waitFor` / `clickSelector`).

## Known pitfalls

One line each; full rationale in PRD §13.

- Body parser before `/files` consumes the stream and breaks tus `PATCH` -
  `express.json()` is scoped to `/api` only.
- Express 5 `path-to-regexp` v8 needs a named wildcard: `/files/*splat`, and the four
  `/api/*splat` media routes likewise.
- Never serve media under `/files/…` (tus prefix) - use `/api/media|hls|thumbs|download`.
- `tus-js-client` needs explicit `chunkSize` (8 MB) or it sends one giant `PATCH`.
- Behind Funnel, cookies need `app.set('trust proxy', 1)` or login loops forever.
- Funnel exposes only ports 443/8443/10000; never expose local 3900 directly.
- `node:22-alpine` runs as root - compose sets `user: "1000:1000"`, Dockerfile uses the
  built-in `node` user; ensure it can write `thumbs/` and `transcode/`.
- `@tus/file-store` writes a `<id>.json` sidecar - `onUploadFinish` must delete it.
- No media route may block the tus response on `ffprobe`; no access token in a media URL.
- HLS segment boundaries on copy paths (1-2) must land on real keyframes, not fixed
  intervals, or the copied stream is unplayable.
- HLS segment ffmpeg flags:
  `-output_ts_offset <start> -avoid_negative_ts disabled -mpegts_flags +initial_discontinuity`.
  `-avoid_negative_ts make_zero` collapses every segment to PTS 0 and breaks seeking /
  native HLS (verified against a real 1080p H.264/AAC .mkv).
- Thumbnail ffmpeg needs an explicit `-f image2`: the temp output name ends in `.tmp` so
  the muxer cannot be inferred.
- The HLS segment plan (keyframe scan, up to ~20 s for a 1.5 GB file) is pre-built by
  `analyzeMedia` post-upload, non-blocking - never on the first playlist request.
- Fullscreen goes on the player container, never `<video>`, or the custom bar vanishes.
  Always try the native Fullscreen API first (including phones). CSS overlay + optional
  90° rotate only if native rejects or is a no-op; never rotate native fullscreen.
- Global `[hidden] { display: none !important }` is required: component rules set
  `display: flex/grid` and would otherwise beat the bare `hidden` attribute.
- A finished media has no resume position, exactly like one never started: only the
  persistent `sanem-done:` marker tells them apart (PRD §10.8). Never clear it alongside
  the position, or the series rail loses its anchor.
- At most `SANEM_FFMPEG_CONCURRENCY` (default 1) ffmpeg processes: uploads come first.
- `button:hover` lifts by `translateY(-1px)` globally: anything centred with a
  `transform` (the rail arrows) must be centred another way, or it jumps on hover.
- The player toolbar has no playback-rate control; `NEXT_UP_LEAD_S` is 120 s and the
  episode badge retires itself after `EPISODE_BADGE_MS`.

## Configuration

Env vars documented in `.env.example`, validated in `src/config.js`. Never add a variable
outside that set without updating both files and the PRD table (§5).
