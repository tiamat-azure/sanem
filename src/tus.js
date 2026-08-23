// tus resumable upload endpoint (@tus/server + @tus/file-store), in-process.
// Mounted at /files. See PRD §6-7 for finalization and cleanup requirements.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { config } from './config.js';
import { resolveFinalPath } from './filename.js';

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

export const tusServer = new Server({
  path: '/files',
  datastore: fileStore,
  relativeLocation: true,
  respectForwardedHeaders: true,
  maxSize: config.maxFileGb * 1024 * 1024 * 1024,
  namingFunction: (req, metadata) => {
    void req;
    void metadata;
    return crypto.randomUUID();
  },
  onUploadFinish: async (req, upload) => {
    void req;
    const rawName = upload.metadata?.filename ?? null;
    const { finalName, finalPath } = resolveFinalPath(uploadsDir, rawName);
    const tmpPath = upload.storage?.path ?? path.join(tmpDir, upload.id);

    await moveToUploads(tmpPath, finalPath);
    await removeSidecar(upload.id);

    console.log(`[sanem] tus: finalized upload "${finalName}" (${upload.size} bytes)`);

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
