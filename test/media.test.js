// Integration tests for the media routes (PRD §8, §12).
//  1. Range: bytes=100-199 -> 206 + correct Content-Range + exactly 100 bytes.
//  2. a path containing ../ (encoded or not) -> 404.
//  3. a request without a session cookie -> 401 on the four media routes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const PASSWORD = 'integration-test-password';
const SESSION_SECRET = 'integration-test-session-secret-at-least-32-chars';

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
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

async function startServer(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sanem-media-'));
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);
  return { baseUrl, dataDir };
}

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 204);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

test('Range request returns 206 with the exact requested bytes', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const cookie = await login(baseUrl);

  const body = crypto.randomBytes(4096);
  await fs.writeFile(path.join(dataDir, 'uploads', 'clip.mp4'), body);

  const res = await fetch(`${baseUrl}/api/media/clip.mp4`, {
    headers: { Cookie: cookie, Range: 'bytes=100-199' },
  });

  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${body.length}`);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.deepEqual(buf, body.subarray(100, 200));
});

test('a traversal path (raw or percent-encoded) returns 404', async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  const cookie = await login(baseUrl);
  await fs.writeFile(path.join(dataDir, 'uploads', 'clip.mp4'), 'data');

  for (const p of [
    '/api/media/../../../etc/passwd',
    '/api/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/api/download/..%2f..%2fetc%2fpasswd',
    '/api/media/sub/%2e%2e/%2e%2e/etc/passwd',
  ]) {
    const res = await fetch(`${baseUrl}${p}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404, `expected 404 for ${p}, got ${res.status}`);
  }
});

test('the four media routes require a session cookie (401)', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const p of [
    '/api/media/clip.mp4',
    '/api/hls/clip.mp4/index.m3u8',
    '/api/thumbs/clip.mp4',
    '/api/download/clip.mp4',
  ]) {
    const res = await fetch(`${baseUrl}${p}`);
    assert.equal(res.status, 401, `expected 401 for ${p}, got ${res.status}`);
  }
});
