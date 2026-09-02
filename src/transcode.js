// Media analysis and on-demand transcoding (PRD §10).
//
// `ffprobe`/`ffmpeg` are system binaries (Docker image, PRD §14), invoked via
// execFile with an argument array - NEVER through a shell, since the input
// path derives from client-supplied metadata (PRD §10.4).
//
// This module owns:
//  - the ffprobe compatibility matrix and its cache (§10.2, §8 `ready`);
//  - the bounded ffmpeg/ffprobe work queue (§10.4);
//  - on-demand segmented HLS playlists and segments (§10.3) - added in step 6.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { resolveReadPath } from './filename.js';

const execFileP = promisify(execFile);

const uploadsDir = path.join(config.dataDir, 'uploads');
const transcodeDir = path.join(config.dataDir, 'transcode');

// --- bounded ffmpeg/ffprobe work queue (§10.4) ---

let active = 0;
const pending = [];

function pump() {
  while (active < config.ffmpegConcurrency && pending.length > 0) {
    const { task, resolve, reject } = pending.shift();
    active += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

export function runQueued(task) {
  return new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    pump();
  });
}

// --- media info cache (§10.2) ---

const memoryCache = new Map(); // relativePath -> { mtimeMs, size, info }
const inFlight = new Set();

export function hashPath(relPath) {
  return crypto.createHash('sha256').update(relPath).digest('hex');
}

function cacheDirFor(relPath) {
  return path.join(transcodeDir, hashPath(relPath));
}

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ts',
  '.m2ts', '.wmv', '.flv', '.mpg', '.mpeg', '.ogv',
]);

export function looksLikeVideo(relPath) {
  return VIDEO_EXT.has(path.extname(relPath).toLowerCase());
}

// PRD §10.2 compatibility matrix.
function classify(probe) {
  const streams = probe.streams ?? [];
  const video = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
  );
  const audio = streams.find((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');

  if (!video) return { kind: 'other', playback: 'none', duration: null };

  const container = String(probe.format?.format_name ?? '');
  const vcodec = String(video.codec_name ?? '');
  const acodec = String(audio?.codec_name ?? '');
  const height = Number(video.height) || null;
  const width = Number(video.width) || null;
  const duration =
    Number(probe.format?.duration) || Number(video.duration) || null;

  let lane;
  if (vcodec === 'h264' && acodec === 'aac' && /mp4|m4a|mov/.test(container)) lane = 0;
  else if (vcodec === 'h264' && acodec === 'aac') lane = 1;
  else if (vcodec === 'h264') lane = 2;
  else lane = 3;

  return {
    kind: 'video',
    playback: lane === 0 ? 'direct' : 'hls',
    lane,
    duration,
    width,
    height,
    vcodec,
    acodec: acodec || null,
    container,
    // §10.5 - path 3 above 1080p: playable but slow, UI must warn.
    heavy: lane === 3 && height !== null && height > 1080,
    internalSubtitles: subs.length,
  };
}

async function readDiskCache(relPath) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(cacheDirFor(relPath), 'probe.json'), 'utf8')
    );
  } catch {
    return null;
  }
}

async function writeDiskCache(relPath, entry) {
  const dir = cacheDirFor(relPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'probe.json'),
    JSON.stringify({ relativePath: relPath, ...entry }, null, 2)
  );
}

async function ffprobe(abs) {
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    return JSON.parse(stdout);
  } catch (err) {
    // Missing binary, unreadable file, or non-media content: a normal outcome
    // (§10.2, §12) - the file stays downloadable but unplayable.
    console.warn(`[sanem] ffprobe failed for ${path.basename(abs)}: ${err.message}`);
    return null;
  }
}

/**
 * Synchronously returns cached media info for a finalized upload, or
 * `{ ready: false }` when ffprobe has not analyzed it yet, or the cache is
 * stale (source mtime/size changed). The UI shows "analyse en cours" and
 * blocks playback while `ready` is false (§8).
 */
export function getMediaInfo(relPath, mtimeMs, size) {
  const cached = memoryCache.get(relPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return { ready: true, ...cached.info };
  }
  return { ready: false };
}

/** Warms the in-memory cache from disk so a restart avoids a full re-probe. */
export async function warmMediaCache() {
  let hashes;
  try {
    hashes = await fs.readdir(transcodeDir);
  } catch {
    return;
  }
  for (const h of hashes) {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(transcodeDir, h, 'probe.json'), 'utf8')
      );
      if (raw.relativePath) {
        memoryCache.set(raw.relativePath, {
          mtimeMs: raw.mtimeMs,
          size: raw.size,
          info: raw.info,
        });
      }
    } catch {
      // ignore unreadable cache entries
    }
  }
}

const UNPLAYABLE = { kind: 'other', playback: 'none', duration: null };

/**
 * Analyzes a finalized upload: ffprobe through the work queue, caches the
 * compatibility-matrix result, then extracts a thumbnail. Safe to call
 * fire-and-forget; never throws to the caller.
 */
export async function analyzeMedia(relPath) {
  if (inFlight.has(relPath)) return;
  inFlight.add(relPath);
  try {
    let abs;
    let stats;
    try {
      ({ abs, stats } = await resolveReadPath(uploadsDir, relPath));
    } catch {
      return; // file gone or path no longer valid
    }

    const disk = await readDiskCache(relPath);
    if (disk && disk.mtimeMs === stats.mtimeMs && disk.size === stats.size) {
      memoryCache.set(relPath, {
        mtimeMs: disk.mtimeMs,
        size: disk.size,
        info: disk.info,
      });
      return;
    }

    let info;
    if (!looksLikeVideo(relPath)) {
      info = UNPLAYABLE;
    } else {
      const probe = await runQueued(() => ffprobe(abs));
      info = probe ? classify(probe) : UNPLAYABLE;
    }

    const entry = { mtimeMs: stats.mtimeMs, size: stats.size, info };
    memoryCache.set(relPath, entry);
    await writeDiskCache(relPath, entry).catch((err) =>
      console.warn(`[sanem] failed to cache probe for ${relPath}: ${err.message}`)
    );

    if (info.kind === 'video') {
      try {
        const { extractThumbnail } = await import('./thumbs.js');
        extractThumbnail(relPath, info.duration);
      } catch {
        // thumbs.js not present yet (added in step 6)
      }
    }
  } finally {
    inFlight.delete(relPath);
  }
}

export { transcodeDir, uploadsDir };
