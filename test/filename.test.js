import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sanitizeFilename, dedupeFilename, resolveFinalPath } from '../src/filename.js';

test('rejects path traversal segments', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('../../.ssh/authorized_keys'), 'authorized_keys');
});

test('rejects absolute posix paths', () => {
  assert.equal(sanitizeFilename('/etc/passwd'), 'passwd');
});

test('rejects windows-style separators', () => {
  assert.equal(sanitizeFilename('C:\\Windows\\System32\\evil.exe'), 'evil.exe');
});

test('sanitizes unicode and unsafe characters', () => {
  assert.equal(sanitizeFilename('résumé finâl!.txt'), 'résumé finâl_.txt');
  assert.equal(sanitizeFilename('a/b?c*d.mp4'), 'b_c_d.mp4');
});

test('falls back on empty or missing names', () => {
  assert.equal(sanitizeFilename(''), 'sans-nom');
  assert.equal(sanitizeFilename(undefined), 'sans-nom');
  assert.equal(sanitizeFilename(null), 'sans-nom');
});

test('rejects reserved names "." and ".."', () => {
  assert.equal(sanitizeFilename('.'), 'sans-nom');
  assert.equal(sanitizeFilename('..'), 'sans-nom');
});

test('truncates long names while preserving the extension', () => {
  const longName = `${'a'.repeat(250)}.mp4`;
  const result = sanitizeFilename(longName);
  assert.ok(result.length <= 200);
  assert.ok(result.endsWith('.mp4'));
});

test('deduplicates on collision with -2, -3 suffixes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanem-filename-'));
  try {
    fs.writeFileSync(path.join(dir, 'video.mp4'), '');
    fs.writeFileSync(path.join(dir, 'video-2.mp4'), '');

    const first = dedupeFilename(dir, 'video.mp4');
    assert.equal(first, 'video-3.mp4');

    const fresh = dedupeFilename(dir, 'other.mp4');
    assert.equal(fresh, 'other.mp4');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveFinalPath stays inside the uploads directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanem-filename-'));
  try {
    const { finalName, finalPath } = resolveFinalPath(dir, '../../evil.txt');
    assert.equal(finalName, 'evil.txt');
    assert.ok(finalPath.startsWith(path.resolve(dir) + path.sep));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
