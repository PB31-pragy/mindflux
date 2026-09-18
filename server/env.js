import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Always resolve the environment file relative to the server package, rather
// than the shell's current directory. This makes `npm run dev` and production
// process managers load the same configuration.
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(serverDirectory, '.env') });

export function getResendApiKey() {
  const key = process.env.RESEND_API_KEY?.trim();
  return key || null;
}

function normalizedHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

// Upload URLs must point to the API host, not the Vite frontend. Prefer an
// explicit production setting, but derive the current host for local use and
// for hosts which provide the public request host behind a reverse proxy.
export function getPublicApiUrl(req) {
  const configured = normalizedHttpUrl(
    process.env.API_PUBLIC_URL || process.env.API_URL,
  );
  if (configured) return configured;

  const host = req?.get?.('host');
  if (!host || /[\s/\\]/.test(host)) return null;

  const forwardedProtocol = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
    ? forwardedProtocol
    : req.protocol || 'http';
  return `${protocol}://${host}`;
}
