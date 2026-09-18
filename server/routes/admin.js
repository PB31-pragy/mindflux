import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, withTransaction } from '../db.js';
import { getPublicApiUrl } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { createNotification } from '../lib/notifications.js';
import { emitUserEvent } from '../realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
const FOUNDER_EMAIL = 'campusauto.pb@gmail.com';

async function isAdminUser(userId) {
  const roleRow = await query(
    "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin'",
    [userId]
  );
  return roleRow.rows.length > 0;
}

async function ensureAdmin(req, res) {
  const isAdmin = await isAdminUser(req.user.id);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden: admin only' });
    return false;
  }
  return true;
}

async function setAccountBlockState(userId, isBlocked) {
  // Only a transition creates a notification. Repeating the same admin action
  // is idempotent and cannot fill the recipient's inbox with duplicates.
  const result = await withTransaction(async (client) => {
    const update = await client.query(
      `UPDATE public.profiles
         SET is_blocked = $2
       WHERE user_id = $1
         AND is_blocked IS DISTINCT FROM $2
       RETURNING user_id, full_name, email, is_blocked`,
      [userId, isBlocked]
    );

    if (update.rows.length === 0) {
      const existing = await client.query(
        'SELECT user_id, full_name, email, is_blocked FROM public.profiles WHERE user_id = $1',
        [userId]
      );
      return { profile: existing.rows[0] || null, notification: null, stateChanged: false };
    }

    const profile = update.rows[0];
    const notification = await createNotification({
      userId: profile.user_id,
      title: isBlocked ? 'Account blocked' : 'Account restored',
      message: isBlocked
        ? 'Your 2Ride account has been blocked by an administrator. Please contact support if you believe this was a mistake.'
        : 'Your 2Ride account has been unblocked by an administrator. You can now post and join rides.',
      type: isBlocked ? 'error' : 'success',
      client,
      emit: false,
    });

    return { profile, notification, stateChanged: true };
  });

  if (result.notification) {
    emitUserEvent(result.profile.user_id, 'notification:new', result.notification);
  }
  return result;
}


// POST /admin/block-user - Admin blocks or unblocks user account and sends notification
router.post('/block-user', requireAuth, async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res))) {
      return;
    }

    const userId = req.body?.user_id || req.body?.userId;
    const isBlocked = Boolean(req.body?.is_blocked ?? req.body?.block ?? true);

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const result = await setAccountBlockState(userId, isBlocked);
    if (!result.profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    return res.json({
      success: true,
      user_id: userId,
      is_blocked: result.profile.is_blocked,
      notification: result.notification,
    });
  } catch (err) {
    console.error('admin block-user error:', err);
    return res.status(500).json({ error: err.message || 'Failed to update user block status' });
  }
});

router.post('/users/:userId/block', requireAuth, async (req, res) => {
  req.body = { ...req.body, user_id: req.params.userId };
  const userId = req.params.userId;
  const isBlocked = Boolean(req.body?.is_blocked ?? req.body?.block ?? true);

  if (!(await ensureAdmin(req, res))) {
    return;
  }

  const result = await setAccountBlockState(userId, isBlocked);
  if (!result.profile) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  return res.json({
    success: true,
    user_id: userId,
    is_blocked: result.profile.is_blocked,
    notification: result.notification,
  });
});

// POST /admin/verify-user - Admin approves or revokes user verification
router.post('/verify-user', requireAuth, async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res))) {
      return;
    }

    const userId = req.body?.user_id || req.body?.userId;
    const isVerified = Boolean(req.body?.is_verified ?? req.body?.verify ?? true);

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const update = await query(
      `UPDATE public.profiles
       SET is_verified = $2
       WHERE user_id = $1
       RETURNING user_id, full_name, email, is_verified`,
      [userId, isVerified]
    );

    if (update.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    let notification = null;
    try {
      if (isVerified) {
        notification = await createNotification({
          userId,
          title: 'Account Verified!',
          message: 'Congratulations! Your account has been verified. You now have full access to 2Ride.',
          type: 'success',
        });
      } else {
        notification = await createNotification({
          userId,
          title: 'Verification Revoked',
          message: 'Your verified rider status has been revoked by an administrator.',
          type: 'warning',
        });
      }
    } catch (notifErr) {
      console.error('Failed to create verify notification:', notifErr);
    }

    return res.json({
      success: true,
      user_id: userId,
      is_verified: isVerified,
      notification,
    });
  } catch (err) {
    console.error('admin verify-user error:', err);
    return res.status(500).json({ error: err.message || 'Failed to update user verification' });
  }
});

// POST /admin/reject-verification - Admin rejects a user ID verification
router.post('/reject-verification', requireAuth, async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res))) {
      return;
    }

    const userId = req.body?.user_id || req.body?.userId;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const update = await query(
      `UPDATE public.profiles
       SET university_id_url = null,
           verification_submitted_at = null,
           is_verified = false
       WHERE user_id = $1
       RETURNING user_id, full_name, email`,
      [userId]
    );

    if (update.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    let notification = null;
    try {
      notification = await createNotification({
        userId,
        title: 'ID Verification Rejected',
        message: 'Your university ID verification was rejected. Please upload a clear, valid university ID to verify your account.',
        type: 'warning',
      });
    } catch (notifErr) {
      console.error('Failed to create rejection notification:', notifErr);
    }

    return res.json({
      success: true,
      user_id: userId,
      notification,
    });
  } catch (err) {
    console.error('admin reject-verification error:', err);
    return res.status(500).json({ error: err.message || 'Failed to reject verification' });
  }
});

// GET /admin/signed-id-url?path=userId/filename - admin or owner can get URL for university ID file
router.get('/signed-id-url', requireAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'File path is required' });
    }
    const match = filePath.match(/^([a-f0-9-]{36})\/[^/]+$/i);
    if (!match) {
      return res.status(400).json({ error: 'Invalid file path format' });
    }
    const fileOwnerId = match[1];
    const requesterId = req.user.id;
    const isAdmin = await isAdminUser(requesterId);
    const isOwner = requesterId === fileOwnerId;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const baseUrl = getPublicApiUrl(req);
    if (!baseUrl) {
      return res.status(500).json({ error: 'Public API URL is not configured' });
    }
    const url = `${baseUrl.replace(/\/$/, '')}/uploads/university-ids/${filePath}`;
    return res.json({ signedUrl: url });
  } catch (err) {
    console.error('Signed ID URL error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate URL' });
  }
});

// GET /admin/chats - admin overview of direct and group chats
router.get('/chats', requireAuth, async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res))) {
      return;
    }

    const [directChatsResult, groupChatsResult] = await Promise.all([
      query(
        `SELECT
           c.id,
           c.ride_id,
           c.ride_request_id,
           c.created_at,
           c.expires_at,
           CASE WHEN c.expires_at <= now() THEN 'expired' ELSE c.status END AS status,
           r.from_location,
           r.to_location,
           r.ride_date,
           r.ride_time,
           r.status AS ride_status,
           p1.user_id AS user1_id,
           COALESCE(p1.full_name, 'Unknown user') AS user1_name,
           p1.avatar_url AS user1_avatar_url,
           COALESCE(p1.is_verified, false) AS user1_is_verified,
           p2.user_id AS user2_id,
           COALESCE(p2.full_name, 'Unknown user') AS user2_name,
           p2.avatar_url AS user2_avatar_url,
           COALESCE(p2.is_verified, false) AS user2_is_verified,
           latest.id AS latest_message_id,
           latest.sender_id AS latest_sender_id,
           latest.message AS latest_message,
           latest.message_type AS latest_message_type,
           latest.media_url AS latest_media_url,
           latest.deleted_for_everyone AS latest_deleted_for_everyone,
           latest.created_at AS latest_message_created_at,
           counts.message_count
         FROM public.connections c
         LEFT JOIN public.rides r ON r.id = c.ride_id
         LEFT JOIN public.profiles p1 ON p1.user_id = c.user1_id
         LEFT JOIN public.profiles p2 ON p2.user_id = c.user2_id
         LEFT JOIN LATERAL (
           SELECT
             cm.id,
             cm.sender_id,
             cm.message,
             cm.message_type,
             cm.media_url,
             cm.deleted_for_everyone,
             cm.created_at
           FROM public.chat_messages cm
           WHERE cm.connection_id = c.id
           ORDER BY cm.created_at DESC
           LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS message_count
           FROM public.chat_messages cm
           WHERE cm.connection_id = c.id
         ) counts ON true
         ORDER BY COALESCE(latest.created_at, c.created_at) DESC, c.created_at DESC`
      ),
      query(
        `SELECT
           gc.id,
           gc.chat_name,
           gc.ride_id,
           gc.created_at,
           gc.expires_at,
           CASE WHEN gc.expires_at <= now() THEN 'expired' ELSE gc.status END AS status,
           r.from_location,
           r.to_location,
           r.ride_date,
           r.ride_time,
           r.status AS ride_status,
           latest.id AS latest_message_id,
           latest.sender_id AS latest_sender_id,
           latest.message AS latest_message,
           latest.message_type AS latest_message_type,
           latest.media_url AS latest_media_url,
           latest.deleted_for_everyone AS latest_deleted_for_everyone,
           latest.system_event AS latest_system_event,
           latest.created_at AS latest_message_created_at,
           counts.message_count,
           members.member_count,
           members.participants
         FROM public.group_chats gc
         LEFT JOIN public.rides r ON r.id = gc.ride_id
         LEFT JOIN LATERAL (
           SELECT
             gcm.id,
             gcm.sender_id,
             gcm.message,
             gcm.message_type,
             gcm.media_url,
             gcm.deleted_for_everyone,
             gcm.system_event,
             gcm.created_at
           FROM public.group_chat_messages gcm
           WHERE gcm.group_chat_id = gc.id
           ORDER BY gcm.created_at DESC
           LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS message_count
           FROM public.group_chat_messages gcm
           WHERE gcm.group_chat_id = gc.id
         ) counts ON true
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*)::int AS member_count,
             COALESCE(
               json_agg(
                 json_build_object(
                   'user_id', p.user_id,
                   'full_name', COALESCE(p.full_name, 'Unknown user'),
                   'avatar_url', p.avatar_url,
                   'is_verified', COALESCE(p.is_verified, false),
                   'role', gcm.role
                 )
                 ORDER BY CASE WHEN gcm.role = 'admin' THEN 0 ELSE 1 END, COALESCE(p.full_name, 'Unknown user')
               ),
               '[]'::json
             ) AS participants
           FROM public.group_chat_members gcm
           LEFT JOIN public.profiles p ON p.user_id = gcm.user_id
           WHERE gcm.group_chat_id = gc.id
         ) members ON true
         ORDER BY COALESCE(latest.created_at, gc.created_at) DESC, gc.created_at DESC`
      ),
    ]);

    const directChats = directChatsResult.rows.map((row) => ({
      id: row.id,
      chat_type: 'direct',
      created_at: row.created_at,
      expires_at: row.expires_at,
      status: row.status,
      ride_id: row.ride_id,
      ride_request_id: row.ride_request_id,
      ride: row.ride_id
        ? {
            from_location: row.from_location,
            to_location: row.to_location,
            ride_date: row.ride_date,
            ride_time: row.ride_time,
            status: row.ride_status,
          }
        : null,
      participants: [
        {
          user_id: row.user1_id,
          full_name: row.user1_name,
          avatar_url: row.user1_avatar_url,
          is_verified: row.user1_is_verified,
          role: null,
        },
        {
          user_id: row.user2_id,
          full_name: row.user2_name,
          avatar_url: row.user2_avatar_url,
          is_verified: row.user2_is_verified,
          role: null,
        },
      ],
      member_count: 2,
      message_count: row.message_count || 0,
      latest_message: row.latest_message_id
        ? {
            id: row.latest_message_id,
            sender_id: row.latest_sender_id,
            message: row.latest_message,
            message_type: row.latest_message_type,
            media_url: row.latest_media_url,
            deleted_for_everyone: row.latest_deleted_for_everyone,
            created_at: row.latest_message_created_at,
            system_event: null,
          }
        : null,
    }));

    const groupChats = groupChatsResult.rows.map((row) => ({
      id: row.id,
      chat_type: 'group',
      chat_name: row.chat_name,
      created_at: row.created_at,
      expires_at: row.expires_at,
      status: row.status,
      ride_id: row.ride_id,
      ride_request_id: null,
      ride: row.ride_id
        ? {
            from_location: row.from_location,
            to_location: row.to_location,
            ride_date: row.ride_date,
            ride_time: row.ride_time,
            status: row.ride_status,
          }
        : null,
      participants: Array.isArray(row.participants) ? row.participants : [],
      member_count: row.member_count || 0,
      message_count: row.message_count || 0,
      latest_message: row.latest_message_id
        ? {
            id: row.latest_message_id,
            sender_id: row.latest_sender_id,
            message: row.latest_message,
            message_type: row.latest_message_type,
            media_url: row.latest_media_url,
            deleted_for_everyone: row.latest_deleted_for_everyone,
            created_at: row.latest_message_created_at,
            system_event: row.latest_system_event,
          }
        : null,
    }));

    return res.json({
      items: [...directChats, ...groupChats].sort((a, b) => {
        const aTime = new Date(a.latest_message?.created_at || a.created_at).getTime();
        const bTime = new Date(b.latest_message?.created_at || b.created_at).getTime();
        return bTime - aTime;
      }),
    });
  } catch (err) {
    console.error('admin chats error:', err);
    return res.status(500).json({ error: err.message || 'Failed to load chats' });
  }
});

// GET /admin/chats/direct/:id/messages - admin view direct chat transcript
router.get('/chats/direct/:id/messages', requireAuth, async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res))) {
      return;
    }

    const connectionId = req.params.id;
    const result = await query(
      `SELECT
         cm.id,
         cm.connection_id,
         cm.sender_id,
         COALESCE(p.full_name, 'System') AS sender_name,
         p.avatar_url AS sender_avatar_url,
         cm.message,
         cm.message_type,
         cm.media_url,
         cm.file_name,
         cm.voice_duration_seconds,
         cm.created_at,
         cm.read,
         cm.read_at,
         cm.deleted_for_everyone
       FROM public.chat_messages cm
       LEFT JOIN public.profiles p ON p.user_id = cm.sender_id
       WHERE cm.connection_id = $1
       ORDER BY cm.created_at ASC`,
      [connectionId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('admin direct chat messages error:', err);
    return res.status(500).json({ error: err.message || 'Failed to load direct chat messages' });
  }
});

// GET /admin/chats/group/:id/messages - admin view group chat transcript
router.get('/chats/group/:id/messages', requireAuth, async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res))) {
      return;
    }

    const groupChatId = req.params.id;
    const result = await query(
      `SELECT
         gcm.id,
         gcm.group_chat_id,
         gcm.sender_id,
         COALESCE(p.full_name, 'System') AS sender_name,
         p.avatar_url AS sender_avatar_url,
         gcm.message,
         gcm.message_type,
         gcm.media_url,
         gcm.file_name,
         gcm.voice_duration_seconds,
         gcm.system_event,
         gcm.created_at,
         gcm.deleted_for_everyone
       FROM public.group_chat_messages gcm
       LEFT JOIN public.profiles p ON p.user_id = gcm.sender_id
       WHERE gcm.group_chat_id = $1
       ORDER BY gcm.created_at ASC`,
      [groupChatId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('admin group chat messages error:', err);
    return res.status(500).json({ error: err.message || 'Failed to load group chat messages' });
  }
});

export default router;
