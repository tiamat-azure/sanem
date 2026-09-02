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
import { Router } from 'express';
import { requireSession } from './auth.js';
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

// --- on-demand segmented HLS (§10.3) ---
//
// The playlist is computed up-front from ffprobe data (no encoding). Each
// segment is produced on its first request and cached under
// transcode/<hash>/. Seeking therefore costs one segment, not the whole
// file. Playlist type is VOD and ends with #EXT-X-ENDLIST so the player
// knows the full duration from the first request.

const TARGET_SEGMENT_SECONDS = 6;

// relativePath -> epoch ms of the last playlist/segment access. Segments of a
// media read within the last minute are never purged (§7.2).
const lastPlayed = new Map();
export function markPlayed(relPath) {
  lastPlayed.set(relPath, Date.now());
}
export function playedWithin(relPath, ms) {
  const t = lastPlayed.get(relPath);
  return t !== undefined && Date.now() - t < ms;
}

async function keyframeTimes(abs) {
  try {
    const { stdout } = await execFileP(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-skip_frame', 'nokey',
        '-show_entries', 'frame=pts_time',
        '-of', 'csv=print_section=0',
        abs,
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    const times = stdout
      .split('\n')
      .map((l) => Number.parseFloat(l))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (times.length === 0 || times[0] > 0.001) times.unshift(0);
    return times;
  } catch (err) {
    console.warn(`[sanem] keyframe probe failed for ${path.basename(abs)}: ${err.message}`);
    return [0];
  }
}

// Builds the segment plan: [{ start, dur }]. Lanes 1-2 (copied video) must
// cut on real keyframes; lane 3 (re-encode) forces regular 6s segments.
async function buildPlan(abs, info) {
  const duration = info.duration || 0;
  if (!duration) return [];

  if (info.lane === 3) {
    const plan = [];
    for (let start = 0; start < duration; start += TARGET_SEGMENT_SECONDS) {
      plan.push({ start, dur: Math.min(TARGET_SEGMENT_SECONDS, duration - start) });
    }
    return plan;
  }

  const kf = await runQueued(() => keyframeTimes(abs));
  const plan = [];
  let segStart = 0;
  for (const t of kf) {
    if (t > segStart && t - segStart >= TARGET_SEGMENT_SECONDS - 0.001) {
      plan.push({ start: segStart, dur: t - segStart });
      segStart = t;
    }
  }
  if (segStart < duration) plan.push({ start: segStart, dur: duration - segStart });
  return plan;
}

async function loadOrBuildPlan(relPath, abs, info) {
  const dir = cacheDirFor(relPath);
  const planFile = path.join(dir, 'plan.json');
  try {
    const raw = JSON.parse(await fs.readFile(planFile, 'utf8'));
    if (raw.mtimeMs === info.mtimeMs) return raw.plan;
  } catch {
    // rebuild
  }
  const plan = await buildPlan(abs, info);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(planFile, JSON.stringify({ mtimeMs: info.mtimeMs, plan }));
  return plan;
}

function playlistText(plan) {
  const target = Math.ceil(Math.max(1, ...plan.map((s) => s.dur)));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  plan.forEach((seg, i) => {
    lines.push(`#EXTINF:${seg.dur.toFixed(3)},`);
    lines.push(`seg-${i}.ts`);
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function segmentArgs(abs, info, seg, tmpOut) {
  const common = ['-nostdin', '-y', '-ss', String(seg.start), '-i', abs, '-t', String(seg.dur)];
  if (info.lane === 3) {
    return [
      ...common,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', config.x264Preset, '-pix_fmt', 'yuv420p',
      '-force_key_frames', 'expr:gte(t,0)',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-output_ts_offset', String(seg.start),
      '-avoid_negative_ts', 'make_zero',
      '-muxdelay', '0', '-muxpreload', '0',
      '-f', 'mpegts', tmpOut,
    ];
  }
  // Lanes 1-2: copy video; lane 2 also transcodes non-AAC audio to AAC.
  const audio =
    info.lane === 2
      ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']
      : ['-c:a', 'copy'];
  return [
    ...common,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy',
    ...audio,
    '-output_ts_offset', String(seg.start),
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', tmpOut,
  ];
}

async function ensureSegment(relPath, abs, info, plan, index, signal) {
  const dir = cacheDirFor(relPath);
  const out = path.join(dir, `seg-${index}.ts`);
  try {
    await fs.access(out);
    markPlayed(relPath);
    return out;
  } catch {
    // needs generation
  }

  await runQueued(async () => {
    if (signal?.aborted) throw new Error('client_disconnected');
    // Re-check: a concurrent request may have produced it while we queued.
    try {
      await fs.access(out);
      return;
    } catch {
      // still missing
    }
    await fs.mkdir(dir, { recursive: true });
    const tmpOut = path.join(dir, `seg-${index}.${process.pid}.${Date.now()}.tmp`);
    try {
      await execFileP('ffmpeg', segmentArgs(abs, info, plan[index], tmpOut), {
        signal,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      });
      // Atomic publish: a partial segment is never served from cache (§10.4).
      await fs.rename(tmpOut, out);
    } catch (err) {
      await fs.rm(tmpOut, { force: true }).catch(() => {});
      const tail = String(err.stderr ?? err.message ?? '').slice(-800);
      console.warn(`[sanem] ffmpeg segment ${index} failed for ${relPath}: ${tail}`);
      throw err;
    }
  });

  markPlayed(relPath);
  return out;
}

async function resolveHlsMedia(splat) {
  const parts = (Array.isArray(splat) ? splat.join('/') : String(splat ?? '')).split('/');
  const resource = parts.pop() ?? '';
  const relRequest = parts.join('/');
  const { abs, relativePath, stats } = await resolveReadPath(uploadsDir, relRequest);
  const info = getMediaInfo(relativePath, stats.mtimeMs, stats.size);
  return { abs, relativePath, stats, info: { ...info, mtimeMs: stats.mtimeMs }, resource };
}

export const hlsRouter = Router();

hlsRouter.get('/hls/*splat', requireSession, async (req, res) => {
  let media;
  try {
    media = await resolveHlsMedia(req.params.splat);
  } catch {
    return res.status(404).end();
  }
  const { abs, relativePath, info, resource } = media;

  if (!info.ready) {
    // ffprobe has not classified it yet; trigger and let the client retry.
    analyzeMedia(relativePath);
    return res.status(503).set('Retry-After', '2').end();
  }
  if (info.playback !== 'hls') return res.status(404).end();

  let plan;
  try {
    plan = await loadOrBuildPlan(relativePath, abs, info);
  } catch {
    return res.status(500).end();
  }
  if (plan.length === 0) return res.status(404).end();

  if (resource === 'index.m3u8') {
    markPlayed(relativePath);
    res.type('application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'private, max-age=30');
    return res.send(playlistText(plan));
  }

  const match = /^seg-(\d+)\.ts$/.exec(resource);
  if (!match) return res.status(404).end();
  const index = Number.parseInt(match[1], 10);
  if (!Number.isInteger(index) || index < 0 || index >= plan.length) {
    return res.status(404).end();
  }

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const segPath = await ensureSegment(relativePath, abs, info, plan, index, ac.signal);
    if (res.writableEnded || ac.signal.aborted) return undefined;
    res.type('video/mp2t');
    res.set('Cache-Control', 'private, max-age=86400');
    return res.sendFile(segPath);
  } catch {
    if (!res.headersSent) return res.status(ac.signal.aborted ? 499 : 500).end();
    return undefined;
  }
});

/**
 * transcode/ cache purge (§7.2): drops the whole segment set of any media
 * whose source vanished from uploads/ or whose mtime changed, then enforces
 * the LRU size cap. Never touches a media read within the last minute.
 */
export async function purgeTranscodeCache() {
  let hashes;
  try {
    hashes = await fs.readdir(transcodeDir);
  } catch {
    return;
  }

  const entries = [];
  for (const h of hashes) {
    const dir = path.join(transcodeDir, h);
    let probe;
    try {
      probe = JSON.parse(await fs.readFile(path.join(dir, 'probe.json'), 'utf8'));
    } catch {
      continue;
    }
    const rel = probe.relativePath;
    let stale = false;
    try {
      const { stats } = await resolveReadPath(uploadsDir, rel);
      if (stats.mtimeMs !== probe.mtimeMs || stats.size !== probe.size) stale = true;
    } catch {
      stale = true; // source gone
    }

    if (stale && !playedWithin(rel, 60_000)) {
      await fs.rm(dir, { recursive: true, force: true });
      memoryCache.delete(rel);
      console.log(`[sanem] transcode purge: dropped stale cache for "${rel}"`);
      continue;
    }

    // Collect segment files for the LRU pass.
    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.ts')) continue;
      try {
        const st = await fs.stat(path.join(dir, f));
        entries.push({ rel, file: path.join(dir, f), size: st.size, atimeMs: st.atimeMs });
      } catch {
        // ignore
      }
    }
  }

  const cap = config.transcodeCacheGb * 1024 * 1024 * 1024;
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= cap) return;

  entries.sort((a, b) => a.atimeMs - b.atimeMs); // least recently read first
  for (const e of entries) {
    if (total <= cap) break;
    if (playedWithin(e.rel, 60_000)) continue;
    await fs.rm(e.file, { force: true });
    total -= e.size;
    console.log(`[sanem] transcode purge: LRU-evicted ${path.basename(e.file)} (${e.rel})`);
  }
}

export { transcodeDir, uploadsDir };
