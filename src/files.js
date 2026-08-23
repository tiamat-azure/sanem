// GET /api/files: lists finalized uploads.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { requireSession } from './auth.js';
import { config } from './config.js';

export const filesRouter = Router();

filesRouter.get('/files', requireSession, async (req, res) => {
  const uploadsDir = path.join(config.dataDir, 'uploads');
  let entries;

  try {
    entries = await fs.readdir(uploadsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.json([]);
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const filePath = path.join(uploadsDir, entry.name);
    const stats = await fs.stat(filePath);
    files.push({
      name: entry.name,
      size: stats.size,
      uploadedAt: stats.mtime.toISOString(),
    });
  }

  files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(files);
});
