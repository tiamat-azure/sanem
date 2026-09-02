// GET /api/files: tree listing (one folder level deep) of finalized uploads,
// enriched with media metadata from the ffprobe cache (PRD §8).
//
// Sort order is locale-aware AND numeric (Intl.Collator, numeric: true) so
// S01E09 sorts before S01E10. This order IS the episode playback order
// (§10.7): do not change it without measuring the effect on chaining.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { requireSession } from './auth.js';
import { config } from './config.js';
import { getMediaInfo, analyzeMedia, looksLikeVideo } from './transcode.js';

export const filesRouter = Router();

const uploadsDir = path.join(config.dataDir, 'uploads');
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

async function listDir(dir, prefix) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }

  for (const entry of entries) {
    // Hidden files/dirs are ignored (§8); tmp/, thumbs/, transcode/ live
    // outside uploads/ so they never appear here.
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (prefix) continue; // exactly one folder level (§6)
      out.push(...(await listDir(abs, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;

    const stats = await fs.stat(abs);
    const info = getMediaInfo(rel, stats.mtimeMs, stats.size);
    if (!info.ready) analyzeMedia(rel); // lazily (re)analyze on first sight

    out.push({
      path: rel,
      dir: prefix || null,
      name: entry.name,
      size: stats.size,
      uploadedAt: stats.mtime.toISOString(),
      kind: info.ready ? info.kind : looksLikeVideo(rel) ? 'video' : 'other',
      duration: info.ready ? info.duration ?? null : null,
      playback: info.ready ? info.playback : 'none',
      heavy: info.ready ? Boolean(info.heavy) : false,
      ready: Boolean(info.ready),
    });
  }
  return out;
}

filesRouter.get('/files', requireSession, async (req, res) => {
  const files = await listDir(uploadsDir, '');
  files.sort((a, b) => collator.compare(a.path, b.path));
  res.json(files);
});
