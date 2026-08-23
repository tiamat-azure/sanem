// Integration test for the core non-negotiable requirement (PRD §11):
// an interrupted tus upload resumes from its last offset, not from zero.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as tus from 'tus-js-client';

const PASSWORD = 'integration-test-password';
const SESSION_SECRET = 'integration-test-session-secret-at-least-32-chars';
const FILE_SIZE = 50 * 1024 * 1024; // ~50 MB, per PRD §11
const CHUNK_SIZE = 10 * 1024 * 1024; // 5 chunks total; interrupt after 2

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/session`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 204);
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.length > 0, 'expected a session cookie');
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

test('resumes an interrupted upload without restarting from zero', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sanem-resume-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = path.join(import.meta.dirname, '..', 'src', 'server.js');

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      SANEM_PASSWORD: PASSWORD,
      SANEM_SESSION_SECRET: SESSION_SECRET,
      SANEM_PORT: String(port),
      SANEM_DATA_DIR: dataDir,
      SANEM_TMP_TTL_HOURS: '48',
      SANEM_MAX_FILE_GB: '20',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);
  const cookie = await login(baseUrl);

  const fileBuffer = crypto.randomBytes(FILE_SIZE);
  const expectedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // --- First attempt: upload two chunks, then abort without terminating,
  // simulating a network cut. ---
  let chunksCompleted = 0;
  let uploadUrl = null;
  let interruptedOffset = 0;

  await new Promise((resolve, reject) => {
    const upload = new tus.Upload(fileBuffer, {
      endpoint: `${baseUrl}/files`,
      chunkSize: CHUNK_SIZE,
      headers: { Cookie: cookie },
      metadata: { filename: 'test-resume.bin' },
      onError: reject,
      onChunkComplete: (_chunkSize, bytesAccepted) => {
        chunksCompleted += 1;
        interruptedOffset = bytesAccepted;
        if (chunksCompleted === 2) {
          uploadUrl = upload.url;
          upload.abort(false).then(resolve, reject);
        }
      },
      onSuccess: () => reject(new Error('Upload should not have completed before interruption')),
    });
    upload.start();
  });

  assert.ok(interruptedOffset > 0, 'expected some bytes to have been accepted before abort');
  assert.ok(interruptedOffset < FILE_SIZE, 'interruption must happen before completion');
  assert.ok(uploadUrl, 'expected an upload URL to have been assigned');

  // --- Resume: reconnect to the same upload URL and verify the server
  // reports (and continues from) the offset reached before interruption,
  // not from zero. ---
  const headRes = await fetch(uploadUrl, {
    method: 'HEAD',
    headers: { Cookie: cookie, 'Tus-Resumable': '1.0.0' },
  });
  const offsetBeforeResume = Number(headRes.headers.get('Upload-Offset'));
  assert.equal(offsetBeforeResume, interruptedOffset, 'server must report the pre-abort offset');
  assert.notEqual(offsetBeforeResume, 0, 'offset must not have reset to zero');

  let firstResumedChunkOffset = null;
  await new Promise((resolve, reject) => {
    const resumedUpload = new tus.Upload(fileBuffer, {
      endpoint: `${baseUrl}/files`,
      uploadUrl,
      chunkSize: CHUNK_SIZE,
      headers: { Cookie: cookie },
      onError: reject,
      onChunkComplete: (_chunkSize, bytesAccepted) => {
        if (firstResumedChunkOffset === null) {
          firstResumedChunkOffset = bytesAccepted;
        }
      },
      onSuccess: resolve,
    });
    resumedUpload.start();
  });

  assert.equal(
    firstResumedChunkOffset,
    interruptedOffset + CHUNK_SIZE,
    'resumed upload must continue from the interrupted offset, not from zero'
  );

  // --- Verify the finalized artifact and tmp/ cleanliness. ---
  const uploadsDir = path.join(dataDir, 'uploads');
  const tmpDir = path.join(dataDir, 'tmp');

  const uploadedFiles = await fs.readdir(uploadsDir);
  assert.equal(uploadedFiles.length, 1);
  assert.equal(uploadedFiles[0], 'test-resume.bin');

  const finalBuffer = await fs.readFile(path.join(uploadsDir, uploadedFiles[0]));
  const finalHash = crypto.createHash('sha256').update(finalBuffer).digest('hex');
  assert.equal(finalHash, expectedHash, 'final file must be byte-identical to the source');

  const tmpEntries = await fs.readdir(tmpDir);
  assert.deepEqual(tmpEntries, [], 'tmp/ must be empty after a successful upload');
});
