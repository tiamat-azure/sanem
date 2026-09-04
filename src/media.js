// Direct media read and original-file download (PRD §8, §10 lane 0).
//
// Both routes sit behind the session middleware and AFTER the tus route
// (mounted in server.js). Each re-applies the §9.5 containment assertion via
// resolveReadPath and answers 404 - never 403 - on any failure, so a probe
// cannot confirm the existence of a target.
//
// On-device playback uses the same-origin session cookie. Cast (Chromecast-
// class Remote Playback) cannot send that HttpOnly cookie: GET /api/cast-url
// (session required) mints a short-lived exp+sig query token, verified here
// and on /api/hls as a targeted §8 exception. Download stays cookie-only.
// No long-lived secret is ever given to the client.

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { mintCastToken, requireSession, requireSessionOrCastSig, signedCastPath } from './auth.js';
import { config } from './config.js';
import { resolveReadPath } from './filename.js';
import { getMediaInfo } from './transcode.js';

const uploadsDir = path.join(config.dataDir, 'uploads');

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// Parses a single-range `Range` header. Returns null (no range), 'invalid'
// (unsatisfiable -> 416), or { start, end } inclusive.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match) return null;
  let start = match[1] === '' ? null : Number.parseInt(match[1], 10);
  let end = match[2] === '' ? null : Number.parseInt(match[2], 10);
  if (start === null && end === null) return 'invalid';
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return 'invalid';
  }
  return { start, end };
}

function splatPath(req) {
  const raw = req.params.splat;
  return Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
}

async function serveFile(req, res, { attachment }) {
  let resolved;
  try {
    resolved = await resolveReadPath(uploadsDir, splatPath(req));
  } catch {
    return res.status(404).end();
  }
  const { abs, stats } = resolved;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeFor(abs));
  res.setHeader('Cache-Control', 'private, max-age=0');
  if (attachment) {
    const name = path.basename(abs);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    );
  }

  const range = parseRange(req.headers.range, stats.size);
  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${stats.size}`);
    return res.status(416).end();
  }

  const { start, end } = range ?? { start: 0, end: stats.size - 1 };
  const length = end - start + 1;

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
  }
  res.setHeader('Content-Length', String(length));

  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export const mediaRouter = Router();

mediaRouter.get('/cast-url/*splat', requireSession, async (req, res) => {
  let resolved;
  try {
    resolved = await resolveReadPath(uploadsDir, splatPath(req));
  } catch {
    return res.status(404).end();
  }
  const kind = req.query.kind === 'hls' ? 'hls' : req.query.kind === 'media' ? 'media' : null;
  const { relativePath, stats } = resolved;
  const info = getMediaInfo(relativePath, stats.mtimeMs, stats.size);
  const useKind = kind ?? (info.ready && info.playback === 'hls' ? 'hls' : 'media');
  const token = mintCastToken({
    kind: useKind,
    mediaPath: relativePath,
    durationSec: info.ready ? info.duration : null,
  });
  res.json({ url: signedCastPath(useKind, relativePath, token), exp: token.exp });
});

const mediaAuth = requireSessionOrCastSig((req) => ({
  kind: 'media',
  mediaPath: splatPath(req),
}));

for (const method of ['get', 'head']) {
  mediaRouter[method]('/media/*splat', mediaAuth, (req, res) =>
    serveFile(req, res, { attachment: false })
  );
  mediaRouter[method]('/download/*splat', requireSession, (req, res) =>
    serveFile(req, res, { attachment: true })
  );
}
