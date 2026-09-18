import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../security.js';

const JWT_SECRET = getJwtSecret();

/**
 * Optional auth: sets req.user if valid Bearer token, else req.user = null.
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: decoded.sub, email: decoded.email };
    next();
  } catch {
    req.user = null;
    next();
  }
}

/**
 * Required auth: 401 if no valid Bearer token.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: decoded.sub, email: decoded.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

export function signToken(payload, options = {}) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', ...options });
}
