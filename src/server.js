// Express bootstrap: route mounting and startup. See PRD §12 for the two
// ordering pitfalls this file is careful about: the tus router must be
// mounted before any body parser, and Express 5's wildcard syntax requires
// a named splat parameter.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { config } from './config.js';
import { authRouter, requireSession } from './auth.js';
import { filesRouter } from './files.js';
import { tusServer, scheduleTusExpirationCleanup } from './tus.js';
import { scheduleTmpCleanup } from './cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

function ensureStorageDirs() {
  fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });
}

ensureStorageDirs();

const app = express();

// Funnel terminates TLS and talks plain HTTP to the container: trust the
// X-Forwarded-Proto header so `Secure` cookies work (PRD §12).
app.set('trust proxy', 1);

app.use(cookieParser(config.sessionSecret));

// tus endpoint: mounted before any body parser, otherwise PATCH requests
// consuming the request stream would break (PRD §12).
app.all(['/files', '/files/*splat'], requireSession, (req, res) => {
  tusServer.handle(req, res);
});

app.use('/api', express.json());
app.use('/api', authRouter);
app.use('/api', filesRouter);

app.use(express.static(publicDir, { index: false }));

const indexTemplate = fs
  .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace('%%MAX_FILE_GB%%', String(config.maxFileGb));

app.get('/', (req, res) => {
  res.type('html').send(indexTemplate);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[sanem] Unhandled error', err);
  res.status(500).json({ error: 'internal_error' });
});

scheduleTmpCleanup(path.join(config.dataDir, 'tmp'), config.tmpTtlHours);
scheduleTusExpirationCleanup();

app.listen(config.port, () => {
  console.log(`[sanem] listening on port ${config.port}, data dir ${config.dataDir}`);
});
