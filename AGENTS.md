# AGENTS.md

## What this project does

Sanem is a self-hosted web service for receiving large files (~1.5 GB average) from remote
friends via drag & drop, over a resumable upload protocol, exposed publicly through
Tailscale Funnel. Single shared password, no accounts, no file management features (see
PRD.md §1 for full scope and explicit out-of-scope items).

**PRD.md is the binding specification.** Technical choices marked "imposé" in it are
locked; do not deviate without asking the project owner first.

## Commands

```bash
npm install
npm start          # node src/server.js - requires SANEM_PASSWORD and
                    # SANEM_SESSION_SECRET env vars, see .env.example
npm test           # node --test - unit + integration tests
npm run lint        # eslint .

docker compose up --build   # full stack, reads .env
```

## Architecture

- `src/server.js` - Express bootstrap, route mounting order (see Known pitfalls).
- `src/config.js` - env var validation, fails fast on startup (PRD §5).
- `src/auth.js` - session cookie, `/api/login`, `/api/logout`, `/api/session`, rate
  limiting.
- `src/tus.js` - `@tus/server` + `@tus/file-store` instance mounted at `/files`,
  `onUploadFinish` hook does the tmp -> uploads rename and sidecar cleanup.
- `src/filename.js` - sanitizes/deduplicates upload filenames (PRD §9, security-critical).
- `src/cleanup.js` - safety-net sweep of orphaned files in `tmp/` (PRD §7).
- `src/files.js` - `GET /api/files` listing.
- `public/` - single-page frontend: `index.html` + `app.js` (Uppy v5 via CDN, no bundler)
  - `style.css` (neon dark theme).
- `test/filename.test.js`, `test/resume.test.js` - see Tests below.

Full API table, storage layout, and finalization steps: PRD.md §6-8.

## Code conventions

- Plain Node.js ESM (`type: module`), no bundler, no frontend framework - Uppy is loaded
  via `<script>` from a pinned CDN URL in `public/index.html`.
- Dependency versions in `package.json` are pinned exactly (no `^`/`~`); update the PRD
  reasoning if you ever need to bump one.
- Comments and code in English; UI copy in French (PRD §2).

## Tests

- `test/filename.test.js` - unit tests for path traversal, unicode, truncation, dedup.
- `test/resume.test.js` - spawns the real server on an ephemeral port, uploads a ~50 MB
  file with `tus-js-client`, aborts after 2 chunks, resumes on the same upload URL, and
  asserts the offset didn't reset to zero, the final hash matches, and `tmp/` is empty.
  This is the project's main guardrail; do not weaken it.
- Run everything with `npm test` before considering a change done.

## Known pitfalls

- Mounting a body parser before the `/files` route breaks tus `PATCH` requests (it
  consumes the stream) - `express.json()` is scoped to `/api` only in `server.js`.
- Express 5's `path-to-regexp` v8 requires a named wildcard: `/files/*splat`, not `*`.
- `tus-js-client` needs an explicit `chunkSize` (8 MB, PRD §10) or it sends the whole file
  in one `PATCH`, which defeats resumability.
- Behind Tailscale Funnel, cookies need `app.set('trust proxy', 1)` or `Secure` cookies
  never get set and login loops forever.
- Funnel only exposes ports 443/8443/10000 publicly; never try to expose the local port
  (3900) directly.
- `node:22-alpine` runs as root by default - `docker-compose.yml` sets `user: "1000:1000"`
  to avoid root-owned files in `~/sanem-data`; the Dockerfile switches to the image's
  built-in `node` user (uid/gid 1000).
- `@tus/file-store` writes a `<id>.json` sidecar per upload; `onUploadFinish` in
  `src/tus.js` must delete it explicitly, or `tmp/` accumulates orphans.

Full detail and rationale for each: PRD.md §12.

## Configuration

Env vars are documented in `.env.example` and validated in `src/config.js`. Never add a
variable outside that set without updating both files and the PRD table (§5).
