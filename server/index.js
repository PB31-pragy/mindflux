import './env.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import rpcRoutes from './routes/rpc.js';
import adminRoutes from './routes/admin.js';
import dataRoutes from './routes/data.js';
import pushRoutes from './routes/push.js';
import { attachRealtimeServer } from './realtime.js';
import { applySecurityHeaders, createCorsOptions } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;
const HEALTHCHECK_URL = `http://127.0.0.1:${PORT}/health`;

app.disable('x-powered-by');
app.use(applySecurityHeaders);
app.use(cors(createCorsOptions()));
app.options('*', cors(createCorsOptions()));
app.use(express.json({ limit: '1mb' }));

// Static files for uploads (avatars, university-ids)
const uploadsPath = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadsPath, {
  dotfiles: 'ignore',
  fallthrough: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Profile images and IDs are displayed by the Vercel frontend, which is a
    // different origin from the API host. This route intentionally serves
    // public media, so it must opt out of the global same-site-only policy.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

app.use('/auth', authRoutes);
app.use('/upload', uploadRoutes);
app.use('/rpc', rpcRoutes);
// The app is fully free — payment routes have been removed. Joining and
// accepting ride requests are handled directly via /rpc (see routes/rpc.js)
// with no charge, enforced at the database level (see
// scripts/make-app-fully-free.sql).
app.use('/admin', adminRoutes);
app.use('/data', dataRoutes);
app.use('/push', pushRoutes);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

attachRealtimeServer(server);

async function isExistingBackendHealthy() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(HEALTHCHECK_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return payload?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleListenError(error) {
  if (error?.code !== 'EADDRINUSE') {
    console.error('Server failed to start:', error);
    process.exit(1);
    return;
  }

  const alreadyRunning = await isExistingBackendHealthy();
  if (alreadyRunning) {
    console.log(
      `[server] Backend is already running on http://localhost:${PORT}. Reuse that instance or stop it before starting another one.`
    );
    process.exit(0);
    return;
  }

  console.error(
    `[server] Port ${PORT} is already in use by another process. Stop that process or start this backend with a different PORT.`
  );
  process.exit(1);
}

server.on('error', (error) => {
  void handleListenError(error);
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
