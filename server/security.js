import './env.js';
import crypto from 'crypto';

let warnedOnDevSecret = false;

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Production frontend. Hardcoded as a safety net so CORS doesn't silently
  // block the live site if ALLOWED_ORIGINS is ever missing on the backend
  // host — this was one cause of OTP requests failing only in production.
  // Additional/custom domains can still be added via the ALLOWED_ORIGINS
  // env var (comma-separated) without touching this file.
  'https://yaatrabuddy.vercel.app',
  'https://2ride.netlify.app',
];
const isProduction = process.env.NODE_ENV === 'production';

function normalizeList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getAllowedOrigins() {
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...normalizeList(process.env.ALLOWED_ORIGINS),
  ]);
}

function isPrivateIpv4Host(hostname) {
  const parts = String(hostname || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function isLocalDevelopmentOrigin(origin) {
  if (isProduction || !origin) return false;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') {
      return true;
    }

    return isPrivateIpv4Host(hostname);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  return getAllowedOrigins().has(origin) || isLocalDevelopmentOrigin(origin);
}

export function createCorsOptions() {
  return {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}

export function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
}

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!secret) {
    if (isProduction) {
      throw new Error('JWT_SECRET is required in production');
    }
    if (!warnedOnDevSecret) {
      warnedOnDevSecret = true;
      console.warn('[security] JWT_SECRET is not set; using the development fallback secret.');
    }
    return 'dev-secret-change-in-production';
  }

  if (secret.length < 32 && isProduction) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }

  return secret;
}

export function hashOtp(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function createRateLimiter({
  windowMs,
  max,
  key = (req) => req.ip || 'unknown',
  message = 'Too many requests, please try again later.',
} = {}) {
  const store = new Map();
  const safeWindowMs = Number(windowMs) > 0 ? Number(windowMs) : 60 * 1000;
  const safeMax = Number(max) > 0 ? Number(max) : 60;
  let lastSweepAt = 0;

  function sweepExpiredBuckets(now) {
    if (now - lastSweepAt < safeWindowMs && store.size < safeMax * 4) {
      return;
    }

    for (const [bucketKey, entry] of store.entries()) {
      if (!entry || entry.resetAt <= now) {
        store.delete(bucketKey);
      }
    }

    lastSweepAt = now;
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    sweepExpiredBuckets(now);
    const bucketKey = key(req);
    const entry = store.get(bucketKey);
    const setHeaders = (count, resetAt) => {
      const remaining = Math.max(0, safeMax - count);
      res.setHeader('X-RateLimit-Limit', String(safeMax));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    };

    if (!entry || entry.resetAt <= now) {
      const nextEntry = { count: 1, resetAt: now + safeWindowMs };
      store.set(bucketKey, nextEntry);
      setHeaders(nextEntry.count, nextEntry.resetAt);
      return next();
    }

    entry.count += 1;
    store.set(bucketKey, entry);
    setHeaders(entry.count, entry.resetAt);

    if (entry.count > safeMax) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: message });
    }

    return next();
  };
}
