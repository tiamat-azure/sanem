// Filename sanitization and deduplication (PRD §9).
//
// The filename comes from tus upload metadata, i.e. from the client, i.e.
// untrusted. Every step below is required: skipping the path-traversal
// removal or the final containment assertion allows writing arbitrary files
// on the host (e.g. via "../../.ssh/authorized_keys").

import fs from 'node:fs';
import path from 'node:path';

const FALLBACK_NAME = 'sans-nom';
const MAX_LENGTH = 200;
const ALLOWED_CHARS = /[^\p{L}\p{N}. _-]/gu;

function stripPathComponents(name) {
  // Handle both POSIX and Windows separators regardless of host OS.
  const normalized = name.replace(/\\/g, '/');
  return path.posix.basename(normalized);
}

function sanitizeCharacters(name) {
  return name.normalize('NFC').replace(ALLOWED_CHARS, '_');
}

function truncatePreservingExtension(name, maxLength) {
  if (name.length <= maxLength) {
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  const allowedBaseLength = Math.max(1, maxLength - ext.length);
  return base.slice(0, allowedBaseLength) + ext;
}

function isReservedName(name) {
  return name === '' || name === '.' || name === '..';
}

export function sanitizeFilename(rawName) {
  let name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name === '') {
    name = FALLBACK_NAME;
  }

  name = stripPathComponents(name);
  name = sanitizeCharacters(name);
  name = truncatePreservingExtension(name, MAX_LENGTH);

  if (isReservedName(name)) {
    name = FALLBACK_NAME;
  }

  return name;
}

/**
 * Returns a filename that does not collide with any existing entry in
 * `directory`, inserting a "-2", "-3", ... suffix before the extension.
 */
export function dedupeFilename(directory, sanitizedName) {
  let candidate = sanitizedName;
  let counter = 2;

  while (fs.existsSync(path.join(directory, candidate))) {
    const ext = path.extname(sanitizedName);
    const base = sanitizedName.slice(0, sanitizedName.length - ext.length);
    candidate = `${base}-${counter}${ext}`;
    counter += 1;
  }

  return candidate;
}

/**
 * Sanitizes, deduplicates, and resolves the final destination path for an
 * uploaded file. Throws if the resolved path escapes `uploadsDir` (should be
 * unreachable given the sanitization above, but is asserted defensively).
 */
export function resolveFinalPath(uploadsDir, rawName) {
  const sanitized = sanitizeFilename(rawName);
  const deduped = dedupeFilename(uploadsDir, sanitized);
  const resolvedRoot = path.resolve(uploadsDir) + path.sep;
  const resolvedPath = path.resolve(uploadsDir, deduped);

  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error(`Rejected unsafe upload filename: ${JSON.stringify(rawName)}`);
  }

  return { finalName: deduped, finalPath: resolvedPath };
}
