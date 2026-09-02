// Filename & path sanitization and deduplication (PRD §9).
//
// Both `filename` and the optional `relativePath` come from tus upload
// metadata, i.e. from the client, i.e. untrusted. This is the most
// security-sensitive module: it was rewritten in v3 to accept exactly one
// folder level (a "series"), which widens the attack surface. Skipping any
// step - the path-component split, the per-segment normalization, or the
// final realpath containment assertion (§9.4) - allows writing outside the
// uploads directory (e.g. "../../.ssh/authorized_keys", or a series folder
// that is a symlink pointing elsewhere).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FALLBACK_NAME = 'sans-nom';
const MAX_LENGTH = 200;
// Anything outside {letters, digits, dot, underscore, hyphen, space} -> "_".
const DISALLOWED_CHARS = /[^\p{L}\p{N}._ -]/gu;

function splitSegments(input) {
  // A Windows client sends backslashes; split on both separators (§9.1).
  return input
    .split(/[/\\]/)
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function truncatePreservingExtension(name, maxLength) {
  if (name.length <= maxLength) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  const allowedBaseLength = Math.max(1, maxLength - ext.length);
  return base.slice(0, allowedBaseLength).trimEnd() + ext;
}

// Normalizes one path segment independently (§9.2). Returns null when the
// segment is unusable (empty after cleanup, or hidden i.e. starting with a
// dot - which would be written but then ignored by the listing).
function normalizeSegment(segment, { isFilename }) {
  let s = segment.normalize('NFC').replace(DISALLOWED_CHARS, '_');
  s = s.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  s = isFilename
    ? truncatePreservingExtension(s, MAX_LENGTH)
    : s.slice(0, MAX_LENGTH).trim();
  if (s === '' || s.startsWith('.')) return null;
  return s;
}

/**
 * Splits client-supplied (filename, relativePath) into a sanitized
 * (folder, name) pair. Enforces the one-level-deep rule (§6, §9.1):
 * `a/b/c/d.mkv` becomes `c/d.mkv`. `folder` is null when the file belongs at
 * the root of uploads/ (no folder given, or folder dropped by normalization).
 * `name` is never empty (falls back to "sans-nom").
 */
export function sanitizeUploadPath(filename, relativePath) {
  const source =
    typeof relativePath === 'string' && relativePath.trim() !== ''
      ? relativePath
      : typeof filename === 'string'
        ? filename
        : '';

  const segments = splitSegments(source);
  const nameSegment = segments.length > 0 ? segments[segments.length - 1] : '';
  const folderSegment = segments.length > 1 ? segments[segments.length - 2] : null;

  const name = normalizeSegment(nameSegment, { isFilename: true }) ?? FALLBACK_NAME;
  const folder =
    folderSegment === null
      ? null
      : normalizeSegment(folderSegment, { isFilename: false });

  return { folder, name };
}

/**
 * Returns a filename that does not collide with any existing entry in
 * `directory`, inserting a "-2", "-3", ... suffix before the extension.
 * Collision is always evaluated inside the target directory (§9.3).
 */
export function dedupeFilename(directory, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  let counter = 2;
  while (fs.existsSync(path.join(directory, candidate))) {
    candidate = `${base}-${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

/**
 * Sanitizes, creates the target directory, runs the §9.4 realpath
 * containment assertion, deduplicates, and returns the final destination.
 *
 * Throws `unsafe_upload_path` (the caller must reject the upload) if the real
 * target directory escapes `uploadsDir` or exceeds one folder level. Never
 * attempts to "fix" the path.
 */
export async function resolveFinalPath(uploadsDir, filename, relativePath) {
  const { folder, name } = sanitizeUploadPath(filename, relativePath);

  const uploadsReal = await fsp.realpath(uploadsDir);
  let targetDir = uploadsReal;

  if (folder !== null) {
    const candidateDir = path.join(uploadsReal, folder);
    // recursive: false - never silently create an unintended depth (§6).
    try {
      await fsp.mkdir(candidateDir, { recursive: false });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Resolve the *real* path: a pre-existing symlink in uploads/ pointing
    // outside the volume must be caught here, not by a string comparison.
    targetDir = await fsp.realpath(candidateDir);
  }

  const insideRoot =
    targetDir === uploadsReal || targetDir.startsWith(uploadsReal + path.sep);
  const relDepth =
    targetDir === uploadsReal
      ? 0
      : path.relative(uploadsReal, targetDir).split(path.sep).length;

  if (!insideRoot || relDepth > 1) {
    console.warn(
      '[sanem] SECURITY: rejected upload path escaping uploads/ ' +
        `(filename=${JSON.stringify(filename)}, ` +
        `relativePath=${JSON.stringify(relativePath)}, ` +
        `resolved=${JSON.stringify(targetDir)})`
    );
    throw new Error('unsafe_upload_path');
  }

  const finalName = dedupeFilename(targetDir, name);
  const finalPath = path.join(targetDir, finalName);

  return {
    folder: folder === null ? null : path.basename(targetDir),
    finalName,
    finalDir: targetDir,
    finalPath,
    relativePath: path.relative(uploadsReal, finalPath),
  };
}

/**
 * Reading is a second attack surface (§9.5): media.js, transcode.js and
 * thumbs.js all receive a path supplied by the client in the URL. Each must
 * re-apply the §9.4 containment assertion before opening anything, and the
 * caller must respond 404 (never 403) on failure.
 *
 * `clientPath` is the raw, still-URL-encoded path captured by the route.
 * Decoding happens here, BEFORE the assertion, so `%2e%2e%2f` is seen as
 * `../`. Returns `{ abs, relativePath, stats }` for an existing regular file
 * at most one folder deep inside uploads/. Throws `not_found` otherwise.
 */
export async function resolveReadPath(uploadsDir, clientPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(clientPath ?? ''));
  } catch {
    throw new Error('not_found');
  }

  if (/(^|[/\\])\.\.?([/\\]|$)/.test(decoded)) throw new Error('not_found');

  const segments = decoded.split(/[/\\]/).filter((s) => s !== '');
  if (segments.length === 0 || segments.length > 2) throw new Error('not_found');
  if (segments.some((s) => s.startsWith('.'))) throw new Error('not_found');

  const uploadsReal = await fsp.realpath(uploadsDir);
  const candidate = path.join(uploadsReal, ...segments);

  let parentReal;
  try {
    parentReal = await fsp.realpath(path.dirname(candidate));
  } catch {
    throw new Error('not_found');
  }
  const insideRoot =
    parentReal === uploadsReal || parentReal.startsWith(uploadsReal + path.sep);
  if (!insideRoot) throw new Error('not_found');

  const abs = path.join(parentReal, path.basename(candidate));
  const relativePath = path.relative(uploadsReal, abs);
  if (relativePath.split(path.sep).length > 2) throw new Error('not_found');

  let stats;
  try {
    stats = await fsp.stat(abs);
  } catch {
    throw new Error('not_found');
  }
  if (!stats.isFile()) throw new Error('not_found');

  return { abs, relativePath, stats };
}
