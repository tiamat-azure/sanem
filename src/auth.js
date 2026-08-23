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
