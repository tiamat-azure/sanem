// Safety-net sweep of tmp/: removes orphaned upload files (and their .json
// sidecars) whose mtime exceeds the configured TTL. Covers cases the tus
// expiration extension does not (crash mid-write, corrupted sidecar, files
// written outside the protocol). See PRD §7.

import fs from 'node:fs/promises';
import path from 'node:path';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export async function sweepTmpDir(tmpDir, ttlHours) {
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  let entries;

  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  let removedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.json')) continue;

    const filePath = path.join(tmpDir, entry.name);
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      continue;
    }

    const ageMs = now - stats.mtimeMs;
    if (ageMs <= ttlMs) continue;

    const sidecarPath = `${filePath}.json`;
    await fs.rm(filePath, { force: true });
    await fs.rm(sidecarPath, { force: true });

    removedCount += 1;
    console.log(
      `[sanem] cleanup: removed orphaned upload "${entry.name}" ` +
        `(${formatSize(stats.size)}, age ${(ageMs / 3_600_000).toFixed(1)}h)`
    );
  }

  return removedCount;
}

export function scheduleTmpCleanup(tmpDir, ttlHours) {
  const runSweep = () => {
    sweepTmpDir(tmpDir, ttlHours).catch((error) => {
      console.error('[sanem] cleanup: sweep failed', error);
    });
  };

  runSweep();
  const timer = setInterval(runSweep, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
