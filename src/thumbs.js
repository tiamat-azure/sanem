// Thumbnail extraction and cache (PRD §10.6).
//
// A thumbnail is a JPEG frame taken ~10% into the video, 480px wide, stored
// at thumbs/<hash>.jpg where <hash> is derived from the media relative path.
// Extraction is async and non-blocking, sharing the ffmpeg work queue and
// concurrency limit (§10.4). While a thumbnail does not exist,
// GET /api/thumbs/* returns 404 and the UI falls back to a deterministic
// gradient - a missing thumbnail is never a visible error (§10.6).

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Router } from 'express';
import { requireSession } from './auth.js';
import { config } from './config.js';
import { resolveReadPath } from './filename.js';
import { hashPath, runQueued, uploadsDir } from './transcode.js';

const execFileP = promisify(execFile);
const thumbsDir = path.join(config.dataDir, 'thumbs');

function thumbFileFor(relPath) {
  return path.join(thumbsDir, `${hashPath(relPath)}.jpg`);
}

const inFlight = new Set();

/**
 * Fire-and-forget: extracts (or refreshes) the thumbnail for a media file.
 * Never throws to the caller. A stale thumbnail (source mtime changed) is
 * detected by callers via getMediaInfo re-analysis, which calls this again.
 */
export async function extractThumbnail(relPath, durationSeconds) {
  if (inFlight.has(relPath)) return;
  inFlight.add(relPath);
  try {
    let abs;
    try {
      ({ abs } = await resolveReadPath(uploadsDir, relPath));
    } catch {
      return;
    }
    const out = thumbFileFor(relPath);
    const seek =
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.max(1, durationSeconds * 0.1)
        : 5;
    const tmpOut = `${out}.${process.pid}.tmp`;

    await runQueued(async () => {
      await fs.mkdir(thumbsDir, { recursive: true });
      try {
        await execFileP(
          'ffmpeg',
          [
            '-nostdin',
            '-ss',
            String(seek),
            '-i',
            abs,
            '-frames:v',
            '1',
            '-vf',
            'scale=480:-2',
            '-q:v',
            '4',
            // Force the muxer: the temp output name ends in .tmp, so ffmpeg
            // cannot infer the format from the extension.
            '-f',
            'image2',
            '-y',
            tmpOut,
          ],
          { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
        );
        await fs.rename(tmpOut, out);
      } catch (err) {
        await fs.rm(tmpOut, { force: true }).catch(() => {});
        console.warn(`[sanem] thumbnail failed for ${relPath}: ${err.message}`);
      }
    });
  } finally {
    inFlight.delete(relPath);
  }
}

/** True when the thumbnail JPEG for this media already exists on disk. */
async function thumbnailExists(relPath) {
  try {
    await fs.access(thumbFileFor(relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a thumbnail exists for a video whose probe is already cached.
 * `analyzeMedia`'s fast path (fresh probe cache) never re-reaches
 * `extractThumbnail`, so a thumbnail whose extraction failed or was
 * interrupted (e.g. a restart mid-queue) would stay missing forever.
 * Callers use this fire-and-forget; it is a cheap no-op once the JPEG is
 * there and never throws.
 */
export async function ensureThumbnail(relPath, durationSeconds) {
  try {
    if (await thumbnailExists(relPath)) return;
    await extractThumbnail(relPath, durationSeconds);
  } catch {
    // never surfaces to the caller (PRD §10.6)
  }
}

/** Removes a thumbnail (source file gone). */
export async function removeThumbnail(relPath) {
  await fs.rm(thumbFileFor(relPath), { force: true }).catch(() => {});
}

export const thumbsRouter = Router();

thumbsRouter.get('/thumbs/*splat', requireSession, async (req, res) => {
  const raw = req.params.splat;
  const relPath = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
  // Validate the requested media path (§9.5) even though we only read the
  // cache: reject traversal before touching the filesystem.
  try {
    await resolveReadPath(uploadsDir, relPath);
  } catch {
    return res.status(404).end();
  }
  const file = thumbFileFor(relPath);
  try {
    await fs.access(file);
  } catch {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=60');
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});
