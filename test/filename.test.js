import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  sanitizeUploadPath,
  dedupeFilename,
  resolveFinalPath,
} from '../src/filename.js';

async function makeUploads() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sanem-fn-'));
  const uploads = path.join(root, 'uploads');
  await fsp.mkdir(uploads);
  return { root, uploads };
}

// --- sanitizeUploadPath: splitting & normalization (§9.1, §9.2) ---

test('strips traversal segments, keeps the basename', () => {
  assert.deepEqual(sanitizeUploadPath('../../etc/passwd', undefined), {
    folder: 'etc',
    name: 'passwd',
  });
  assert.deepEqual(sanitizeUploadPath('/etc/passwd', undefined), {
    folder: 'etc',
    name: 'passwd',
  });
});

test('handles windows separators', () => {
  assert.deepEqual(
    sanitizeUploadPath('C:\\Anime\\evil.exe', undefined),
    { folder: 'Anime', name: 'evil.exe' }
  );
});

test('replaces unsafe characters, normalizes unicode (NFC), collapses spaces', () => {
  const { name } = sanitizeUploadPath('résumé  finâl!.txt', undefined);
  assert.equal(name, 'résumé finâl_.txt');
});

test('falls back to "sans-nom" on empty / missing / reserved names', () => {
  assert.equal(sanitizeUploadPath('', undefined).name, 'sans-nom');
  assert.equal(sanitizeUploadPath(undefined, undefined).name, 'sans-nom');
  assert.equal(sanitizeUploadPath(null, null).name, 'sans-nom');
  assert.equal(sanitizeUploadPath('.', undefined).name, 'sans-nom');
  assert.equal(sanitizeUploadPath('..', undefined).name, 'sans-nom');
});

test('a filename starting with a dot is rejected -> "sans-nom"', () => {
  assert.equal(sanitizeUploadPath('.bashrc', undefined).name, 'sans-nom');
});

test('truncates long names to 200 chars, preserving the extension', () => {
  const { name } = sanitizeUploadPath(`${'a'.repeat(250)}.mkv`, undefined);
  assert.ok(name.length <= 200);
  assert.ok(name.endsWith('.mkv'));
});

test('relativePath takes precedence over filename', () => {
  assert.deepEqual(sanitizeUploadPath('d.mkv', 'Frieren/d.mkv'), {
    folder: 'Frieren',
    name: 'd.mkv',
  });
});

// --- Mandatory v3 additions (§12) ---

test('§12.1 - "../../.ssh/authorized_keys" lands in uploads/ and nowhere else', async () => {
  const { root, uploads } = await makeUploads();
  try {
    const res = await resolveFinalPath(
      uploads,
      'authorized_keys',
      '../../.ssh/authorized_keys'
    );
    assert.equal(res.folder, null); // ".ssh" dropped (hidden segment)
    assert.equal(res.finalName, 'authorized_keys');
    assert.ok(res.finalPath.startsWith(path.resolve(uploads) + path.sep));
    await fsp.writeFile(res.finalPath, 'x');
    // Nothing created outside uploads/.
    const rootEntries = await fsp.readdir(root);
    assert.deepEqual(rootEntries.sort(), ['uploads']);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('§12.2 - "a/b/c/d.mkv" flattens to c/d.mkv, never a deep tree', async () => {
  const { root, uploads } = await makeUploads();
  try {
    assert.deepEqual(sanitizeUploadPath('d.mkv', 'a/b/c/d.mkv'), {
      folder: 'c',
      name: 'd.mkv',
    });
    const res = await resolveFinalPath(uploads, 'd.mkv', 'a/b/c/d.mkv');
    assert.equal(res.relativePath, path.join('c', 'd.mkv'));
    assert.equal(res.folder, 'c');
    assert.ok(!fs.existsSync(path.join(uploads, 'a')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('§12.3 - a series folder that is a symlink outside uploads/ is rejected', async () => {
  const { root, uploads } = await makeUploads();
  const outside = path.join(root, 'outside');
  await fsp.mkdir(outside);
  await fsp.symlink(outside, path.join(uploads, 'evil'), 'dir');
  try {
    await assert.rejects(
      () => resolveFinalPath(uploads, 'pwned.mkv', 'evil/pwned.mkv'),
      /unsafe_upload_path/
    );
    // The symlink attack wrote nothing outside uploads/.
    assert.deepEqual(await fsp.readdir(outside), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('§12.4 - dedup is per-folder: same name in two series coexist without a suffix', async () => {
  const { root, uploads } = await makeUploads();
  try {
    const a = await resolveFinalPath(uploads, 'S01E01.mkv', 'Frieren/S01E01.mkv');
    await fsp.writeFile(a.finalPath, 'a');
    const b = await resolveFinalPath(uploads, 'S01E01.mkv', 'Vanuatu/S01E01.mkv');
    await fsp.writeFile(b.finalPath, 'b');
    assert.equal(a.finalName, 'S01E01.mkv');
    assert.equal(b.finalName, 'S01E01.mkv');

    // Second file into the *same* folder gets the suffix.
    const c = await resolveFinalPath(uploads, 'S01E01.mkv', 'Frieren/S01E01.mkv');
    assert.equal(c.finalName, 'S01E01-2.mkv');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('dedupeFilename inserts -2, -3 before the extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanem-dedupe-'));
  try {
    fs.writeFileSync(path.join(dir, 'video.mp4'), '');
    fs.writeFileSync(path.join(dir, 'video-2.mp4'), '');
    assert.equal(dedupeFilename(dir, 'video.mp4'), 'video-3.mp4');
    assert.equal(dedupeFilename(dir, 'other.mp4'), 'other.mp4');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
