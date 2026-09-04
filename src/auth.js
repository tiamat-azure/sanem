// Session authentication: shared password, signed cookie, rate limiting.

import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';

const COOKIE_NAME = 'sanem_session';
const SESSION_VALUE = 'authenticated';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

function passwordMatches(candidate) {
  const candidateDigest = sha256(String(candidate ?? ''));
  const expectedDigest = sha256(config.password);
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

// Global failure cap across all IPs: the service has a single legitimate
// user at a time, so this never hampers normal usage while neutralizing
// distributed bruteforce (PRD §8).
let globalFailures = 0;
let globalFailuresWindowStart = Date.now();
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_FAILURE_CAP = 50;

function registerGlobalFailure() {
  const now = Date.now();
  if (now - globalFailuresWindowStart > GLOBAL_WINDOW_MS) {
    globalFailures = 0;
    globalFailuresWindowStart = now;
  }
  globalFailures += 1;
}

function globalFailureCapExceeded() {
  const now = Date.now();
  if (now - globalFailuresWindowStart > GLOBAL_WINDOW_MS) {
    globalFailures = 0;
    globalFailuresWindowStart = now;
    return false;
  }
  return globalFailures >= GLOBAL_FAILURE_CAP;
}

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

export function requireSession(req, res, next) {
  if (req.signedCookies && req.signedCookies[COOKIE_NAME] === SESSION_VALUE) {
    return next();
  }
  return res.status(401).json({ error: 'unauthenticated' });
}

export function isAuthenticated(req) {
  return Boolean(req.signedCookies && req.signedCookies[COOKIE_NAME] === SESSION_VALUE);
}

// Cast-only PRD §8 exception: Chromecast-class Remote Playback cannot send
// the HttpOnly sanem_session cookie. Short-lived HMAC-SHA256 query tokens
// (exp + sig) authorize GET /api/media and GET /api/hls for one media path.
// Minting still requires a logged-in session. Cookie-gated URLs remain the
// on-device path. This is not a public catalog.
//
// TTL T3: when probe duration is known,
//   min(12h, max(6h, duration + 2h));
// when unknown, 6h. Absolute ceiling is 12h (never longer).
// Signed with SANEM_SESSION_SECRET (same secret as cookies, distinct
// message prefix so tokens are not interchangeable).
export const CAST_TTL_MARGIN_SEC = 2 * 60 * 60;
export const CAST_TTL_DEFAULT_SEC = 6 * 60 * 60;
export const CAST_TTL_MAX_SEC = 12 * 60 * 60;
const CAST_MSG_PREFIX = 'sanem-cast-v1';

function canonicalMediaPath(mediaPath) {
  return String(mediaPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/g, '');
}

export function castTtlSeconds(durationSec) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return CAST_TTL_DEFAULT_SEC;
  return Math.min(CAST_TTL_MAX_SEC, Math.max(CAST_TTL_DEFAULT_SEC, Math.ceil(d) + CAST_TTL_MARGIN_SEC));
}

function hmacCast(kind, mediaPath, exp, secret = config.sessionSecret) {
  const msg = `${CAST_MSG_PREFIX}\n${kind}\n${canonicalMediaPath(mediaPath)}\n${exp}`;
  return crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('base64url');
}

export function mintCastToken({ kind, mediaPath, durationSec, nowSec = Math.floor(Date.now() / 1000) }) {
  if (kind !== 'media' && kind !== 'hls') throw new Error('invalid_kind');
  const exp = nowSec + castTtlSeconds(durationSec);
  return { exp, sig: hmacCast(kind, mediaPath, exp) };
}

export function verifyCastToken({
  kind,
  mediaPath,
  exp,
  sig,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  if (kind !== 'media' && kind !== 'hls') return false;
  const expNum = Number.parseInt(String(exp ?? ''), 10);
  if (!Number.isFinite(expNum) || expNum <= nowSec) return false;
  if (typeof sig !== 'string' || sig.length < 16) return false;
  const expected = hmacCast(kind, mediaPath, expNum);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function signedCastPath(kind, mediaPath, { exp, sig }) {
  const encoded = canonicalMediaPath(mediaPath)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const q = `exp=${exp}&sig=${encodeURIComponent(sig)}`;
  if (kind === 'hls') return `/api/hls/${encoded}/index.m3u8?${q}`;
  return `/api/media/${encoded}?${q}`;
}

function queryOne(value) {
  return typeof value === 'string' ? value : '';
}

// Cookie session wins. Otherwise a valid, unexpired exp+sig for this
// kind+path is accepted (cast fling). Invalid/expired signatures -> 401.
export function requireSessionOrCastSig(getKindAndPath) {
  return (req, res, next) => {
    if (isAuthenticated(req)) return next();
    let parsed;
    try {
      parsed = getKindAndPath(req);
    } catch {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const kind = parsed?.kind;
    const mediaPath = parsed?.mediaPath;
    const exp = queryOne(req.query?.exp);
    const sig = queryOne(req.query?.sig);
    if (verifyCastToken({ kind, mediaPath, exp, sig })) {
      req.castQuery = { exp, sig };
      return next();
    }
    return res.status(401).json({ error: 'unauthenticated' });
  };
}

function setSessionCookie(res) {
  res.cookie(COOKIE_NAME, SESSION_VALUE, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    signed: true,
    maxAge: THIRTY_DAYS_MS,
  });
}

export const authRouter = Router();

authRouter.get('/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

authRouter.post('/login', loginRateLimiter, (req, res) => {
  if (globalFailureCapExceeded()) {
    console.warn(
      `[sanem] Login blocked: global failure cap reached (${GLOBAL_FAILURE_CAP}/hour).`
    );
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const { password } = req.body ?? {};
  if (typeof password === 'string' && passwordMatches(password)) {
    setSessionCookie(res);
    return res.status(204).end();
  }

  registerGlobalFailure();
  const ip = req.ip;
  console.warn(`[sanem] Failed login attempt at ${new Date().toISOString()} from ${ip}`);
  return res.status(401).json({ error: 'invalid_password' });
});

authRouter.post('/logout', requireSession, (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.status(204).end();
});
