// tus resumable upload endpoint (@tus/server + @tus/file-store), in-process.
// Mounted at /files. See PRD §6-7 for finalization and cleanup requirements.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { config } from './config.js';
import { resolveFinalPath } from './filename.js';
import { analyzeMedia } from './transcode.js';

const uploadsDir = path.join(config.dataDir, 'uploads');
const tmpDir = path.join(config.dataDir, 'tmp');

const fileStore = new FileStore({
  directory: tmpDir,
  expirationPeriodInMilliseconds: config.tmpTtlHours * 60 * 60 * 1000,
});

async function moveToUploads(tmpPath, finalPath) {
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    // tmp/ and uploads/ are expected to be on the same filesystem (PRD §6),
    // but fall back to copy+unlink defensively.
    await fs.copyFile(tmpPath, finalPath);
    await fs.unlink(tmpPath);
  }
}

async function removeSidecar(id) {
  await fs.rm(path.join(tmpDir, `${id}.json`), { force: true });
}

// §6.5 - verify no residue carrying <id> remains in tmp/, and log it.
async function sweepResidue(id) {
  const entries = await fs.readdir(tmpDir).catch(() => []);
  const leftover = entries.filter((name) => name.startsWith(id));
  if (leftover.length > 0) {
    console.warn(`[sanem] tus: removing ${leftover.length} tmp residue for ${id}`);
    await Promise.all(
      leftover.map((name) => fs.rm(path.join(tmpDir, name), { force: true }))
    );
  }
}

export const tusServer = new Server({
  path: '/files',
  datastore: fileStore,
  relativeLocation: true,
  respectForwardedHeaders: true,
  maxSize: config.maxFileGb * 1024 * 1024 * 1024,
  namingFunction: () => crypto.randomUUID(),
  onUploadFinish: async (req, upload) => {
    void req;
    const filename = upload.metadata?.filename ?? null;
    const relativePath = upload.metadata?.relativePath ?? null;
    const tmpPath = upload.storage?.path ?? path.join(tmpDir, upload.id);

    let dest;
    try {
      dest = await resolveFinalPath(uploadsDir, filename, relativePath);
    } catch (err) {
      console.warn(`[sanem] tus: rejected upload ${upload.id}: ${err.message}`);
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      await removeSidecar(upload.id).catch(() => {});
      const rejection = new Error('unsafe_upload_path');
      rejection.status_code = 400;
      rejection.body = 'Upload rejected: unsafe path.';
      throw rejection;
    }

    await moveToUploads(tmpPath, dest.finalPath);
    await removeSidecar(upload.id);
    await sweepResidue(upload.id);

    console.log(
      `[sanem] tus: finalized "${dest.relativePath}" (${upload.size} bytes)`
    );

    // §6.6 - trigger media analysis (ffprobe + thumbnail) without blocking
    // the tus response. Fire-and-forget: errors are handled inside.
    analyzeMedia(dest.relativePath);

    return {};
  },
});

export function scheduleTusExpirationCleanup() {
  const runCleanup = () => {
    tusServer.cleanUpExpiredUploads().catch((error) => {
      console.error('[sanem] tus: expired-upload cleanup failed', error);
    });
  };

  runCleanup();
  const timer = setInterval(runCleanup, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
