import { Router } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { withUser } from '../db.js';
import { getPublicApiUrl } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
const uploadDir = path.join(__dirname, '../uploads');
const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'audio/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};
const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const UNIVERSITY_ID_MIME_TYPES = [...AVATAR_MIME_TYPES, 'application/pdf'];
const CHAT_MEDIA_MIME_TYPES = [
  ...AVATAR_MIME_TYPES,
  'video/mp4',
  'video/webm',
  'audio/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
];

function makeStorage(subDir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const userId = req.user?.id || 'anon';
      const dir = path.join(uploadDir, subDir, userId);
      try {
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err, null);
      }
    },
    filename: (req, file, cb) => {
      const ext = MIME_EXTENSIONS[file.mimetype] || '.bin';
      cb(null, `${Date.now()}${ext}`);
    },
  });
}

function fileFilterFor(allowedMimeTypes) {
  return (req, file, cb) => {
    const mimeType = file.mimetype || '';
    if (!allowedMimeTypes.includes(mimeType)) {
      return cb(new Error('Unsupported file type'));
    }
    return cb(null, true);
  };
}

function sanitizeOriginalName(fileName) {
  const safeName = path.basename(String(fileName || 'upload'));
  return safeName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
}

function runSingleUpload(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function getUploadErrorDetails(err, fallbackMessage = 'Upload failed') {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 400, message: 'File is too large' };
    }
    return { status: 400, message: err.message || fallbackMessage };
  }

  if (err instanceof Error) {
    if (err.message === 'Unsupported file type') {
      return { status: 400, message: err.message };
    }
    return { status: 500, message: err.message || fallbackMessage };
  }

  return { status: 500, message: fallbackMessage };
}

const uploadAvatar = multer({
  storage: makeStorage('avatars'),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: fileFilterFor(AVATAR_MIME_TYPES),
});
const uploadUniversityId = multer({
  storage: makeStorage('university-ids'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilterFor(UNIVERSITY_ID_MIME_TYPES),
});
const uploadChatMedia = multer({
  storage: makeStorage('chat-media'),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: fileFilterFor(CHAT_MEDIA_MIME_TYPES),
});
const uploadAvatarSingle = uploadAvatar.single('file');
const uploadUniversityIdSingle = uploadUniversityId.single('file');
const uploadChatMediaSingle = uploadChatMedia.single('file');
const uploadRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  key: (req) => `${req.user?.id || req.ip}:upload`,
  message: 'Too many uploads, please wait a few minutes and try again.',
});

try {
  fs.mkdirSync(uploadDir, { recursive: true });
  [
    path.join(uploadDir, 'avatars'),
    path.join(uploadDir, 'university-ids'),
    path.join(uploadDir, 'chat-media'),
  ].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
} catch (error) {
  console.error('Upload dir creation failed:', error);
}

router.post('/avatar', requireAuth, uploadRateLimit, async (req, res) => {
  try {
    await runSingleUpload(uploadAvatarSingle, req, res);
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const baseUrl = getPublicApiUrl(req);
    if (!baseUrl) {
      return res.status(500).json({ error: 'Public API URL is not configured' });
    }
    const relativePath = `uploads/avatars/${req.user.id}/${req.file.filename}`;
    const url = `${baseUrl.replace(/\/$/, '')}/${relativePath}`;
    await withUser(req.user.id, (client) =>
      client.query('UPDATE public.profiles SET avatar_url = $1 WHERE user_id = $2', [url, req.user.id]),
    );
    return res.json({ url });
  } catch (err) {
    console.error('Upload avatar error:', err);
    const { status, message } = getUploadErrorDetails(err);
    return res.status(status).json({ error: message });
  }
});

router.post('/university-id', requireAuth, uploadRateLimit, async (req, res) => {
  try {
    await runSingleUpload(uploadUniversityIdSingle, req, res);
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const baseUrl = getPublicApiUrl(req);
    if (!baseUrl) {
      return res.status(500).json({ error: 'Public API URL is not configured' });
    }
    const relativePath = `uploads/university-ids/${req.user.id}/${req.file.filename}`;
    const url = `${baseUrl.replace(/\/$/, '')}/${relativePath}`;
    await withUser(req.user.id, (client) =>
      client.query(
        'UPDATE public.profiles SET university_id_url = $1, verification_submitted_at = now() WHERE user_id = $2',
        [url, req.user.id],
      ),
    );
    return res.json({ url });
  } catch (err) {
    console.error('Upload university-id error:', err);
    const { status, message } = getUploadErrorDetails(err);
    return res.status(status).json({ error: message });
  }
});

router.post('/chat-media', requireAuth, uploadRateLimit, async (req, res) => {
  try {
    await runSingleUpload(uploadChatMediaSingle, req, res);
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const mimeType = req.file.mimetype || 'application/octet-stream';
    if (!CHAT_MEDIA_MIME_TYPES.includes(mimeType)) {
      return res.status(400).json({ error: 'Only image, video, and audio files are allowed' });
    }

    const baseUrl = getPublicApiUrl(req);
    if (!baseUrl) {
      return res.status(500).json({ error: 'Public API URL is not configured' });
    }
    const relativePath = `uploads/chat-media/${req.user.id}/${req.file.filename}`;
    const url = `${baseUrl.replace(/\/$/, '')}/${relativePath}`;

    return res.json({
      url,
      mimeType,
      fileName: sanitizeOriginalName(req.file.originalname),
      fileSize: req.file.size,
    });
  } catch (err) {
    console.error('Upload chat-media error:', err);
    const { status, message } = getUploadErrorDetails(err);
    return res.status(status).json({ error: message });
  }
});

export default router;
