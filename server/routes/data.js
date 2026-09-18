import { Router } from 'express';
import { withUser, query } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { emitChatEvent, emitGroupEvent, emitUserEvent, getOnlineState } from '../realtime.js';
import { normalizeRideSlot } from '../lib/rideTime.js';
import { normalizeMobileNumber, phoneNumberSql } from '../lib/phone.js';
import { createNotification } from '../lib/notifications.js';

const router = Router();
const FOUNDER_EMAIL = 'campusauto.pb@gmail.com';
let rideColumnsAvailable = null;
let profileColumnsAvailable = null;

// Helper: run with user context and return rows or single row
async function runWithUser(userId, fn) {
  return withUser(userId, fn);
}

async function isAdminUser(userId, email) {
  if ((email || '').toLowerCase() === FOUNDER_EMAIL) {
    await query(
      `INSERT INTO public.user_roles (user_id, role)
       VALUES ($1, 'admin')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId]
    ).catch((error) => {
      console.warn('Failed to ensure founder admin role:', error);
    });
    return true;
  }

  const roleRow = await query(
    "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin'",
    [userId]
  );
  return roleRow.rows.length > 0;
}

async function getRideColumns(client) {
  if (rideColumnsAvailable !== null) return rideColumnsAvailable;

  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'rides'`
  );

  rideColumnsAvailable = new Set(result.rows.map((row) => row.column_name));
  return rideColumnsAvailable;
}

async function getProfileColumns(client) {
  if (profileColumnsAvailable !== null) return profileColumnsAvailable;

  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'profiles'`
  );

  profileColumnsAvailable = new Set(result.rows.map((row) => row.column_name));
  return profileColumnsAvailable;
}

function profileSelectExpression(columns, columnName, fallbackSql) {
  return columns.has(columnName) ? columnName : `${fallbackSql} AS ${columnName}`;
}

function adminProfileSelectFields(columns) {
  return [
    profileSelectExpression(columns, 'id', 'user_id'),
    'user_id',
    'full_name',
    'email',
    profileSelectExpression(columns, 'phone_number', 'NULL::text'),
    profileSelectExpression(columns, 'avatar_url', 'NULL::text'),
    profileSelectExpression(columns, 'university_id_url', 'NULL::text'),
    profileSelectExpression(columns, 'is_verified', 'false'),
    profileSelectExpression(columns, 'is_blocked', 'false'),
    profileSelectExpression(columns, 'created_at', 'now()'),
    profileSelectExpression(columns, 'verification_submitted_at', 'NULL::timestamp with time zone'),
    profileSelectExpression(columns, 'is_premium', 'false'),
    profileSelectExpression(columns, 'subscription_expiry', 'NULL::timestamp with time zone'),
    profileSelectExpression(columns, 'free_connections_left', '0'),
    profileSelectExpression(columns, 'total_connections', '0'),
    profileSelectExpression(columns, 'rewards_enabled', 'false'),
    profileSelectExpression(columns, 'reward_free_spin_access', 'false'),
    profileSelectExpression(columns, 'reward_status', 'NULL::text'),
  ];
}

function normalizeReactions(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toggleReaction(reactions, emoji, userId) {
  const current = normalizeReactions(reactions).map((entry) => ({
    emoji: entry?.emoji,
    user_ids: Array.isArray(entry?.user_ids) ? [...new Set(entry.user_ids)] : [],
  }));

  const next = [];
  let handled = false;

  for (const reaction of current) {
    if (reaction.emoji !== emoji) {
      if (reaction.user_ids.length > 0) next.push(reaction);
      continue;
    }

    handled = true;
    const hasUser = reaction.user_ids.includes(userId);
    const userIds = hasUser
      ? reaction.user_ids.filter((id) => id !== userId)
      : [...reaction.user_ids, userId];

    if (userIds.length > 0) {
      next.push({ emoji, user_ids: userIds });
    }
  }

  if (!handled) {
    next.push({ emoji, user_ids: [userId] });
  }

  return next;
}

async function getDirectChatBlockState(client, userId, partnerId) {
  if (!userId || !partnerId) {
    return {
      blocked_by_me: false,
      blocked_by_partner: false,
      chat_blocked: false,
    };
  }

  const result = await client.query(
    `SELECT
       EXISTS (
         SELECT 1
           FROM public.chat_blocks
          WHERE blocker_id = $1
            AND blocked_id = $2
       ) AS blocked_by_me,
       EXISTS (
         SELECT 1
           FROM public.chat_blocks
          WHERE blocker_id = $2
            AND blocked_id = $1
       ) AS blocked_by_partner`,
    [userId, partnerId]
  );

  const row = result.rows[0] || {};
  return {
    blocked_by_me: Boolean(row.blocked_by_me),
    blocked_by_partner: Boolean(row.blocked_by_partner),
    chat_blocked: Boolean(row.blocked_by_me || row.blocked_by_partner),
  };
}

// GET /data/profiles/me
router.get('/profiles/me', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.profiles WHERE user_id = $1', [req.user.id])
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/profiles/me
router.patch('/profiles/me', requireAuth, async (req, res) => {
  try {
    // Account state is administrator-owned. Keeping it out of the self-service
    // profile route prevents a user from verifying, blocking, or upgrading themself.
    const allowed = ['full_name', 'phone_number', 'avatar_url', 'university_id_url', 'verification_submitted_at', 'spin_used', 'rewards_enabled'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields to update' });
    const hasPhoneNumber = setKeys.includes('phone_number');
    const normalizedPhoneNumber = hasPhoneNumber ? normalizeMobileNumber(body.phone_number) : null;

    if (hasPhoneNumber && !normalizedPhoneNumber) {
      return res.status(400).json({ error: 'Please enter a valid mobile number' });
    }

    const normalizedBody = { ...body };
    if (hasPhoneNumber) {
      normalizedBody.phone_number = normalizedPhoneNumber;
    }

    const r = await runWithUser(req.user.id, async (client) => {
      if (hasPhoneNumber) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`profile-phone:${normalizedPhoneNumber}`]);

        const duplicatePhone = await client.query(
          `SELECT user_id
             FROM public.profiles
            WHERE ${phoneNumberSql('phone_number')} = $1
              AND user_id <> $2
            LIMIT 1`,
          [normalizedPhoneNumber, req.user.id]
        );

        if (duplicatePhone.rows.length > 0) {
          const error = new Error('This mobile number is already registered. Please sign in instead.');
          error.statusCode = 409;
          throw error;
        }
      }

      const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const values = [req.user.id, ...setKeys.map((k) => normalizedBody[k])];
      await client.query(`UPDATE public.profiles SET ${setClause} WHERE user_id = $1`, values);
      return client.query('SELECT * FROM public.profiles WHERE user_id = $1', [req.user.id]);
    });
    return res.json(r.rows[0] || null);
  } catch (err) {
    console.error(err);
    const statusCode = err?.statusCode || err?.status || 500;
    return res.status(statusCode).json({ error: err.message });
  }
});

// GET /data/profiles/:user_id - single profile by user_id (RLS applies)
router.get('/profiles/:user_id', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.profiles WHERE user_id = $1', [req.params.user_id])
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/profiles/:user_id - update any profile (admin or self; RLS applies)
router.patch('/profiles/:user_id', requireAuth, async (req, res) => {
  try {
    const allowed = ['full_name', 'phone_number', 'avatar_url', 'university_id_url', 'verification_submitted_at', 'is_verified', 'is_blocked', 'spin_used', 'rewards_enabled', 'is_premium', 'subscription_expiry'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields to update' });
    const isSelf = req.params.user_id === req.user.id;
    const requesterIsAdmin = await isAdminUser(req.user.id, req.user.email);
    const adminOnlyFields = new Set(['is_verified', 'is_blocked', 'is_premium', 'subscription_expiry']);

    if (!isSelf && !requesterIsAdmin) {
      return res.status(403).json({ error: 'Forbidden: you can only update your own profile' });
    }
    if (!requesterIsAdmin && setKeys.some((key) => adminOnlyFields.has(key))) {
      return res.status(403).json({ error: 'Forbidden: account status can only be changed by an administrator' });
    }
    const hasPhoneNumber = setKeys.includes('phone_number');
    const normalizedPhoneNumber = hasPhoneNumber ? normalizeMobileNumber(body.phone_number) : null;

    if (hasPhoneNumber && !normalizedPhoneNumber) {
      return res.status(400).json({ error: 'Please enter a valid mobile number' });
    }

    const normalizedBody = { ...body };
    if (hasPhoneNumber) {
      normalizedBody.phone_number = normalizedPhoneNumber;
    }

    const operation = await runWithUser(req.user.id, async (client) => {
      if (hasPhoneNumber) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`profile-phone:${normalizedPhoneNumber}`]);

        const duplicatePhone = await client.query(
          `SELECT user_id
             FROM public.profiles
            WHERE ${phoneNumberSql('phone_number')} = $1
              AND user_id <> $2
            LIMIT 1`,
          [normalizedPhoneNumber, req.params.user_id]
        );

        if (duplicatePhone.rows.length > 0) {
          const error = new Error('This mobile number is already registered. Please sign in instead.');
          error.statusCode = 409;
          throw error;
        }
      }

      const previous = await client.query(
        'SELECT user_id, is_blocked, is_verified FROM public.profiles WHERE user_id = $1 FOR UPDATE',
        [req.params.user_id]
      );
      if (previous.rows.length === 0) return { profile: null, notification: null };

      const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const values = [req.params.user_id, ...setKeys.map((k) => normalizedBody[k])];
      const updated = await client.query(`UPDATE public.profiles SET ${setClause} WHERE user_id = $1 RETURNING *`, values);
      const updatedProfile = updated.rows[0];
      const wasBlocked = Boolean(previous.rows[0].is_blocked);
      const isBlocked = Boolean(updatedProfile.is_blocked);
      const wasVerified = Boolean(previous.rows[0].is_verified);
      const isVerified = Boolean(updatedProfile.is_verified);
      let notification = null;

      // The profile mutation and its notification share one database transaction.
      // We emit only after the transaction commits, so clients never receive a
      // notification whose database row is not yet visible.
      if (setKeys.includes('is_blocked') && wasBlocked !== isBlocked) {
        notification = await createNotification({
          userId: updatedProfile.user_id,
          title: isBlocked ? 'Account blocked' : 'Account restored',
          message: isBlocked
            ? 'Your 2Ride account has been blocked by an administrator. Please contact support if you believe this was a mistake.'
            : 'Your 2Ride account has been unblocked by an administrator. You can now post and join rides.',
          type: isBlocked ? 'error' : 'success',
          client,
          emit: false,
        });
      } else if (setKeys.includes('is_verified') && !wasVerified && isVerified) {
        notification = await createNotification({
          userId: updatedProfile.user_id,
          title: 'Account Verified!',
          message: 'Congratulations! Your account has been verified. You now have full access to 2Ride.',
          type: 'success',
          client,
          emit: false,
        });
      }

      return { profile: updatedProfile, notification };
    });
    if (!operation.profile) return res.status(404).json({ error: 'Not found' });

    if (operation.notification) {
      emitUserEvent(operation.profile.user_id, 'notification:new', operation.notification);
    }

    return res.json(operation.profile);
  } catch (err) {
    console.error(err);
    const statusCode = err?.statusCode || err?.status || 500;
    return res.status(statusCode).json({ error: err.message });
  }
});

// GET /data/profiles - list all (admin) or ?ids=uuid1,uuid2 for filter
router.get('/profiles', requireAuth, async (req, res) => {
  try {
    const ids = req.query.ids ? req.query.ids.split(',').filter(Boolean) : null;
    const requesterIsAdmin = await isAdminUser(req.user.id, req.user.email);
    const r = await runWithUser(req.user.id, async (client) => {
      const columns = await getProfileColumns(client);

      if (ids && ids.length > 0) {
        const selectFields = requesterIsAdmin
          ? adminProfileSelectFields(columns)
          : [
              'user_id',
              'full_name',
              'email',
              profileSelectExpression(columns, 'avatar_url', 'NULL::text'),
              profileSelectExpression(columns, 'is_verified', 'false'),
              profileSelectExpression(columns, 'is_premium', 'false'),
              profileSelectExpression(columns, 'subscription_expiry', 'NULL::timestamp with time zone'),
              profileSelectExpression(columns, 'free_connections_left', '0'),
            ];

        return client.query(
          `SELECT ${selectFields.join(', ')} FROM public.profiles WHERE user_id = ANY($1::uuid[])`,
          [ids]
        );
      }

      if (requesterIsAdmin) {
        const orderBy = columns.has('created_at') ? 'created_at DESC' : 'full_name ASC';
        return client.query(`SELECT ${adminProfileSelectFields(columns).join(', ')} FROM public.profiles ORDER BY ${orderBy}`);
      }

      return client.query('SELECT * FROM public.profiles ORDER BY created_at DESC');
    });
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/presence?ids=uuid1,uuid2
router.get('/presence', requireAuth, async (req, res) => {
  try {
    const ids = req.query.ids ? req.query.ids.split(',').filter(Boolean) : [];
    return res.json(ids.map((userId) => getOnlineState(userId)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});
// GET /data/rides - list with optional filters (from_ilike, to_ilike for partial match)
router.get('/rides', requireAuth, async (req, res) => {
  try {
    const { user_id, from_location, to_location, from_ilike, to_ilike, ride_date, ride_date_gte, id, start_time, end_time } = req.query;
    const includeFull = req.query.include_full === 'true' || !!user_id || !!id;
    const r = await runWithUser(req.user.id, async (client) => {
      const columns = await getRideColumns(client);
      const rideStartExpr = columns.has('start_time')
        ? 'COALESCE(start_time, ride_time)'
        : 'ride_time';
      const rideEndExpr = columns.has('end_time')
        ? "COALESCE(end_time, (COALESCE(start_time, ride_time) + interval '1 hour')::time)"
        : "(ride_time + interval '1 hour')::time";

      let sql = 'SELECT * FROM public.rides WHERE 1=1';
      const values = [];
      let i = 1;
      if (user_id) { sql += ` AND user_id = $${i++}`; values.push(user_id); }
      if (from_location) { sql += ` AND from_location = $${i++}`; values.push(from_location); }
      if (to_location) { sql += ` AND to_location = $${i++}`; values.push(to_location); }
      if (from_ilike) { sql += ` AND from_location ILIKE $${i++}`; values.push(`%${from_ilike}%`); }
      if (to_ilike) { sql += ` AND to_location ILIKE $${i++}`; values.push(`%${to_ilike}%`); }
      if (ride_date) {
        sql += ` AND ride_date = $${i++}`;
        values.push(ride_date);
      } else if (ride_date_gte) {
        sql += ` AND ride_date >= $${i++}`;
        values.push(ride_date_gte);
      }
      if (id) { sql += ` AND id = $${i++}`; values.push(id); }
      if (start_time && end_time) {
        sql += ` AND ${rideStartExpr} < $${i++}::time`;
        values.push(end_time);
        sql += ` AND ${rideEndExpr} > $${i++}::time`;
        values.push(start_time);
      }
      if (!includeFull) {
        sql += ` AND COALESCE(seats_available, 0) > 0`;
        sql += ` AND COALESCE(status, 'active') != 'full'`;
      }
      sql += ` ORDER BY ride_date ASC, ${rideStartExpr} ASC, created_at DESC`;
      return client.query(sql, values);
    });
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/rides
router.post('/rides', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const { from_location, to_location, from_location_id, to_location_id, ride_date, ride_time, start_time, end_time, seats_available, transport_mode } = b;
    const normalizedSlot = normalizeRideSlot({ startTime: start_time, endTime: end_time, rideTime: ride_time });
    if (!from_location || !to_location || !ride_date || seats_available == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!normalizedSlot.ok) {
      return res.status(400).json({ error: normalizedSlot.error });
    }
    const seatCount = Number(seats_available);
    if (!Number.isInteger(seatCount) || seatCount < 1) {
      return res.status(400).json({ error: 'Seats available must be at least 1.' });
    }
    const r = await runWithUser(req.user.id, async (client) => {
      const columns = await getRideColumns(client);
      const fields = ['user_id', 'from_location', 'to_location', 'ride_date', 'ride_time', 'seats_available'];
      const values = [req.user.id, from_location, to_location, ride_date, normalizedSlot.rideTime, seatCount];

      if (columns.has('from_location_id')) {
        fields.push('from_location_id');
        values.push(from_location_id || null);
      }
      if (columns.has('to_location_id')) {
        fields.push('to_location_id');
        values.push(to_location_id || null);
      }
      if (columns.has('transport_mode')) {
        fields.push('transport_mode');
        values.push(transport_mode || 'car');
      }
      if (columns.has('start_time')) {
        fields.push('start_time');
        values.push(normalizedSlot.startTime);
      }
      if (columns.has('end_time')) {
        fields.push('end_time');
        values.push(normalizedSlot.endTime);
      }

      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      return client.query(`INSERT INTO public.rides (${fields.join(', ')}) VALUES (${placeholders}) RETURNING *`, values);
    });
    const ride = r.rows[0];
    if (ride && !('transport_mode' in ride)) ride.transport_mode = transport_mode || 'car';
    return res.status(201).json(ride);
  } catch (err) {
    console.error(err);
    if (err.code === '42501' || /row-level security/i.test(err.message || '')) {
      return res.status(403).json({ error: 'Your account must be verified and unblocked before posting a ride.' });
    }
    if (/ride date must be today or in the future/i.test(err.message || '')) {
      return res.status(400).json({ error: 'Ride date must be today or in the future.' });
    }
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/rides/:id
router.patch('/rides/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['from_location', 'to_location', 'ride_date', 'ride_time', 'start_time', 'end_time', 'seats_available', 'transport_mode'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields' });
    if (setKeys.includes('seats_available')) {
      const seatCount = Number(body.seats_available);
      if (!Number.isInteger(seatCount) || seatCount < 1) {
        return res.status(400).json({ error: 'Seats available must be at least 1.' });
      }
      body.seats_available = seatCount;
    }
    const normalizedSlot = setKeys.some((key) => ['ride_time', 'start_time', 'end_time'].includes(key))
      ? normalizeRideSlot({
          startTime: body.start_time,
          endTime: body.end_time,
          rideTime: body.ride_time,
        })
      : { ok: true };
    if (!normalizedSlot.ok) {
      return res.status(400).json({ error: normalizedSlot.error });
    }

    if (normalizedSlot.startTime) {
      body.ride_time = normalizedSlot.rideTime;
      body.start_time = normalizedSlot.startTime;
      body.end_time = normalizedSlot.endTime;
    }

    const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [req.params.id, ...setKeys.map((k) => body[k])];
    const r = await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.rides SET ${setClause} WHERE id = $1 RETURNING *`, values)
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/notifications - current user's notifications
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'SELECT * FROM public.notifications WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.id]
      )
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/notifications
router.post('/notifications', requireAuth, async (req, res) => {
  try {
    const { user_id, title, message, type, ride_id, ride_request_id } = req.body || {};
    const targetUserId = user_id || req.user.id;

    // Security check: Only admins can send notifications to arbitrary users.
    // Non-admins can only send notifications to themselves or participants in their rides/requests.
    if (targetUserId !== req.user.id) {
      const isAdmin = await isAdminUser(req.user.id, req.user.email);
      if (!isAdmin) {
        let isAuthorized = false;
        if (ride_id) {
          const rideRow = await query(
            'SELECT 1 FROM public.rides WHERE id = $1 AND user_id = $2',
            [ride_id, req.user.id]
          );
          if (rideRow.rows.length > 0) isAuthorized = true;
        }
        if (!isAuthorized && ride_request_id) {
          const reqRow = await query(
            `SELECT 1 FROM public.ride_requests
             WHERE id = $1
               AND (requester_id = $2 OR ride_id IN (SELECT id FROM public.rides WHERE user_id = $2))`,
            [ride_request_id, req.user.id]
          );
          if (reqRow.rows.length > 0) isAuthorized = true;
        }
        if (!isAuthorized) {
          return res.status(403).json({ error: 'Forbidden: Cannot send notifications to other users' });
        }
      }
    }

    const row = await createNotification({
      userId: targetUserId,
      title: title || '',
      message: message || '',
      type: type || 'info',
      rideId: ride_id || null,
      rideRequestId: ride_request_id || null,
    });

    return res.status(201).json(row);
  } catch (err) {
    console.error('Failed to create notification:', err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/notifications/:id
router.patch('/notifications/:id', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'UPDATE public.notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *',
        [req.params.id, req.user.id]
      )
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    try {
      emitUserEvent(req.user.id, 'notification:read', { id: req.params.id });
    } catch {}
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/notifications/read-all - mark all current user notifications as read
router.patch('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await runWithUser(req.user.id, (client) =>
      client.query('UPDATE public.notifications SET read = true WHERE user_id = $1 AND read = false', [req.user.id])
    );
    try {
      emitUserEvent(req.user.id, 'notification:read-all', {});
    } catch {}
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/ride_requests
router.get('/ride_requests', requireAuth, async (req, res) => {
  try {
    const { ride_id, requester_id } = req.query;
    let sql = 'SELECT * FROM public.ride_requests WHERE 1=1';
    const values = [];
    let i = 1;
    if (ride_id) { sql += ` AND ride_id = $${i++}`; values.push(ride_id); }
    if (requester_id) { sql += ` AND requester_id = $${i++}`; values.push(requester_id); }
    sql += ' ORDER BY created_at DESC';
    const r = await runWithUser(req.user.id, (client) => client.query(sql, values));
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/ride_requests
router.post('/ride_requests', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `INSERT INTO public.ride_requests (ride_id, requester_id, status, show_profile_photo, show_mobile_number,
         requester_show_profile_photo, requester_show_mobile_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          b.ride_id,
          req.user.id,
          b.status || 'pending',
          b.show_profile_photo ?? false,
          b.show_mobile_number ?? false,
          b.requester_show_profile_photo ?? true,
          b.requester_show_mobile_number ?? false,
        ]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/ride_requests/:id
router.patch('/ride_requests/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['status', 'request_payment_status', 'accept_payment_status', 'show_profile_photo', 'show_mobile_number', 'requester_show_profile_photo', 'requester_show_mobile_number'];
    const body = req.body || {};
    const setKeys = Object.keys(body).filter((k) => allowed.includes(k));
    if (setKeys.length === 0) return res.status(400).json({ error: 'No allowed fields' });
    const setClause = setKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [req.params.id, ...setKeys.map((k) => body[k])];
    const r = await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.ride_requests SET ${setClause} WHERE id = $1 RETURNING *`, values)
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/connections - current user's connections
router.get('/connections', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `SELECT
           c.id,
           c.user1_id,
           c.user2_id,
           CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END AS partner_id,
           c.ride_id,
           c.ride_request_id,
           c.created_at,
           c.expires_at,
           CASE WHEN c.expires_at <= now() THEN 'expired' ELSE c.status END AS status,
           c.expires_at <= now() AS is_expired,
           c.expires_at - now() AS time_remaining,
           EXISTS (
             SELECT 1
               FROM public.chat_blocks cb
              WHERE cb.blocker_id = $1
                AND cb.blocked_id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END
           ) AS blocked_by_me,
           EXISTS (
             SELECT 1
               FROM public.chat_blocks cb
              WHERE cb.blocker_id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END
                AND cb.blocked_id = $1
           ) AS blocked_by_partner
         FROM public.connections c
         WHERE c.user1_id = $1 OR c.user2_id = $1
         ORDER BY c.created_at DESC`,
        [req.user.id]
      )
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/chat_previews - current user's direct chat preview data in one request
router.get('/chat_previews', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `SELECT
           c.id,
           c.user1_id,
           c.user2_id,
           CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END AS partner_id,
           c.ride_id,
           c.ride_request_id,
           c.created_at,
           c.expires_at,
           CASE WHEN c.expires_at <= now() THEN 'expired' ELSE c.status END AS status,
           c.expires_at <= now() AS is_expired,
           c.expires_at - now() AS time_remaining,
           EXISTS (
             SELECT 1
               FROM public.chat_blocks cb
              WHERE cb.blocker_id = $1
                AND cb.blocked_id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END
           ) AS blocked_by_me,
           EXISTS (
             SELECT 1
               FROM public.chat_blocks cb
              WHERE cb.blocker_id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END
                AND cb.blocked_id = $1
           ) AS blocked_by_partner,
           p.full_name AS partner_full_name,
           p.avatar_url AS partner_avatar_url,
           COALESCE(p.is_verified, false) AS partner_is_verified,
           COALESCE(p.is_premium, false) AS partner_is_premium,
           p.subscription_expiry AS partner_subscription_expiry,
           r.from_location,
           r.to_location,
           r.ride_date,
           lm.message AS last_message,
           lm.message_type AS last_message_type,
           lm.sender_id AS last_message_sender_id,
           lm.created_at AS last_message_time,
           COALESCE(lm.read, false) AS last_message_read,
           COALESCE(lm.deleted_for_everyone, false) AS last_message_deleted_for_everyone,
           COALESCE(uc.unread_count, 0) AS unread_count
         FROM public.connections c
         LEFT JOIN public.profiles p
           ON p.user_id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END
         LEFT JOIN public.rides r
           ON r.id = c.ride_id
         LEFT JOIN LATERAL (
           SELECT
             message,
             message_type,
             sender_id,
             created_at,
             read,
             deleted_for_everyone
           FROM public.chat_messages
           WHERE connection_id = c.id
           ORDER BY created_at DESC
           LIMIT 1
         ) lm ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS unread_count
           FROM public.chat_messages
           WHERE connection_id = c.id
             AND sender_id <> $1
             AND read = false
         ) uc ON true
         WHERE c.user1_id = $1 OR c.user2_id = $1
         ORDER BY c.created_at DESC`,
        [req.user.id]
      )
    );

    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/chat_blocks/status?partner_id=
router.get('/chat_blocks/status', requireAuth, async (req, res) => {
  try {
    const partnerId = String(req.query.partner_id || '').trim();
    if (!partnerId) {
      return res.status(400).json({ error: 'partner_id required' });
    }

    const state = await runWithUser(req.user.id, (client) =>
      getDirectChatBlockState(client, req.user.id, partnerId)
    );

    return res.json(state);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/chat_blocks
router.post('/chat_blocks', requireAuth, async (req, res) => {
  try {
    const blockedUserId = String(req.body?.blocked_user_id || '').trim();
    if (!blockedUserId) {
      return res.status(400).json({ error: 'blocked_user_id required' });
    }
    if (blockedUserId === req.user.id) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }

    const payload = await runWithUser(req.user.id, async (client) => {
      await client.query(
        `INSERT INTO public.chat_blocks (blocker_id, blocked_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [req.user.id, blockedUserId]
      );

      return getDirectChatBlockState(client, req.user.id, blockedUserId);
    });

    emitUserEvent(req.user.id, 'chat:preview:refresh', { partnerId: blockedUserId });
    emitUserEvent(blockedUserId, 'chat:preview:refresh', { partnerId: req.user.id });
    return res.status(201).json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /data/chat_blocks/:blockedUserId
router.delete('/chat_blocks/:blockedUserId', requireAuth, async (req, res) => {
  try {
    const blockedUserId = String(req.params.blockedUserId || '').trim();
    if (!blockedUserId) {
      return res.status(400).json({ error: 'blocked user id required' });
    }

    const payload = await runWithUser(req.user.id, async (client) => {
      await client.query(
        `DELETE FROM public.chat_blocks
          WHERE blocker_id = $1
            AND blocked_id = $2`,
        [req.user.id, blockedUserId]
      );

      return getDirectChatBlockState(client, req.user.id, blockedUserId);
    });

    emitUserEvent(req.user.id, 'chat:preview:refresh', { partnerId: blockedUserId });
    emitUserEvent(blockedUserId, 'chat:preview:refresh', { partnerId: req.user.id });
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/connections
router.post('/connections', requireAuth, async (req, res) => {
  try {
    const { ride_id, ride_request_id, user1_id, user2_id } = req.body || {};
    if (!ride_id || !ride_request_id || !user1_id || !user2_id) {
      return res.status(400).json({ error: 'ride_id, ride_request_id, user1_id, user2_id required' });
    }
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `INSERT INTO public.connections (ride_id, ride_request_id, user1_id, user2_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [ride_id, ride_request_id, user1_id, user2_id]
      )
    );
    emitUserEvent(user1_id, 'chat:preview:refresh', { connectionId: r.rows[0]?.id || null });
    emitUserEvent(user2_id, 'chat:preview:refresh', { connectionId: r.rows[0]?.id || null });
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/chat_messages?connection_id=
router.get('/chat_messages', requireAuth, async (req, res) => {
  try {
    const { connection_id, before } = req.query;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10) || 30, 1), 100);
    if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `SELECT *
           FROM (
             SELECT *
               FROM public.chat_messages
              WHERE connection_id = $1
                AND ($2::timestamp with time zone IS NULL OR created_at < $2::timestamp with time zone)
              ORDER BY created_at DESC
              LIMIT $3
           ) messages
          ORDER BY created_at ASC`,
        [connection_id, before || null, limit]
      )
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/chat_messages
router.post('/chat_messages', requireAuth, async (req, res) => {
  try {
    const {
      connection_id,
      message,
      message_type = 'text',
      media_url = null,
      media_mime_type = null,
      file_name = null,
      file_size = null,
      reply_to_id = null,
      voice_duration_seconds = null,
      metadata = {},
    } = req.body || {};

    if (!connection_id) {
      return res.status(400).json({ error: 'connection_id required' });
    }
    if ((message == null || message === '') && !media_url) {
      return res.status(400).json({ error: 'message or media required' });
    }

    const payload = await runWithUser(req.user.id, async (client) => {
      const connectionResult = await client.query(
        'SELECT id, user1_id, user2_id FROM public.connections WHERE id = $1',
        [connection_id]
      );
      if (connectionResult.rows.length === 0) {
        throw new Error('Connection not found');
      }

      const connection = connectionResult.rows[0];
      const partnerId = connection.user1_id === req.user.id ? connection.user2_id : connection.user1_id;
      const blockState = await getDirectChatBlockState(client, req.user.id, partnerId);
      if (blockState.chat_blocked) {
        throw new Error(
          blockState.blocked_by_me
            ? 'You blocked this rider. Unblock them to send messages again.'
            : 'This rider has blocked chat. You cannot send messages here.'
        );
      }

      const messageResult = await client.query(
        `INSERT INTO public.chat_messages (
           connection_id,
           sender_id,
           message,
           message_type,
           media_url,
           media_mime_type,
           file_name,
           file_size,
           reply_to_id,
           voice_duration_seconds,
           metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING *`,
        [
          connection_id,
          req.user.id,
          message || '',
          message_type,
          media_url,
          media_mime_type,
          file_name,
          file_size,
          reply_to_id,
          voice_duration_seconds,
          JSON.stringify(metadata || {}),
        ]
      );

      return {
        message: messageResult.rows[0],
        connection,
      };
    });

    emitChatEvent(connection_id, 'chat:message:new', payload.message);
    emitUserEvent(payload.connection.user1_id, 'chat:preview:refresh', { connectionId: connection_id });
    emitUserEvent(payload.connection.user2_id, 'chat:preview:refresh', { connectionId: connection_id });

    return res.status(201).json(payload.message);
  } catch (err) {
    console.error(err);
    return res
      .status(/blocked chat|blocked this rider/i.test(err.message || '') ? 403 : 500)
      .json({ error: err.message });
  }
});

// PATCH /data/chat_messages/:id (e.g. mark read)
router.patch('/chat_messages/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const payload = await runWithUser(req.user.id, async (client) => {
      const currentResult = await client.query(
        'SELECT * FROM public.chat_messages WHERE id = $1',
        [req.params.id]
      );
      if (currentResult.rows.length === 0) {
        return null;
      }

      const current = currentResult.rows[0];
      let updated;

      if (body.read === true) {
        updated = await client.query(
          `UPDATE public.chat_messages
              SET read = true,
                  read_at = COALESCE(read_at, now())
            WHERE id = $1
            RETURNING *`,
          [req.params.id]
        );
      } else if (typeof body.reaction === 'string' && body.reaction.trim()) {
        const nextReactions = toggleReaction(current.reactions, body.reaction.trim(), req.user.id);
        updated = await client.query(
          'UPDATE public.chat_messages SET reactions = $2::jsonb WHERE id = $1 RETURNING *',
          [req.params.id, JSON.stringify(nextReactions)]
        );
      } else if (body.deleted_for_everyone === true) {
        if (current.sender_id !== req.user.id) {
          throw new Error('Only the sender can delete this message for everyone');
        }
        updated = await client.query(
          `UPDATE public.chat_messages
              SET deleted_for_everyone = true,
                  message = 'This message was deleted',
                  media_url = NULL,
                  media_mime_type = NULL,
                  file_name = NULL,
                  file_size = NULL,
                  metadata = '{}'::jsonb
            WHERE id = $1
            RETURNING *`,
          [req.params.id]
        );
      } else {
        throw new Error('No allowed fields');
      }

      const connectionResult = await client.query(
        'SELECT id, user1_id, user2_id FROM public.connections WHERE id = $1',
        [updated.rows[0].connection_id]
      );

      return {
        message: updated.rows[0],
        connection: connectionResult.rows[0],
      };
    });

    if (!payload) return res.status(404).json({ error: 'Not found' });

    const eventName =
      body.read === true
        ? 'chat:message:read'
        : typeof body.reaction === 'string'
          ? 'chat:message:reaction'
          : 'chat:message:updated';

    emitChatEvent(payload.message.connection_id, eventName, payload.message);
    emitUserEvent(payload.connection.user1_id, 'chat:preview:refresh', { connectionId: payload.message.connection_id });
    emitUserEvent(payload.connection.user2_id, 'chat:preview:refresh', { connectionId: payload.message.connection_id });

    return res.json(payload.message);
  } catch (err) {
    console.error(err);
    return res.status(/not found/i.test(err.message || '') ? 404 : 500).json({ error: err.message });
  }
});

// GET /data/user_roles - list (own or all if admin)
router.get('/user_roles', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.user_roles WHERE user_id = $1', [req.user.id])
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/user_reports (admin list - RLS will filter)
router.get('/user_reports', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.user_reports ORDER BY created_at DESC')
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/user_reports
router.post('/user_reports', requireAuth, async (req, res) => {
  try {
    const { reported_user_id, ride_id, reason, description } = req.body || {};
    if (!reported_user_id || !ride_id || !reason) {
      return res.status(400).json({ error: 'reported_user_id, ride_id, reason required' });
    }
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.user_reports (reporter_id, reported_user_id, ride_id, reason, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [req.user.id, reported_user_id, ride_id, reason, description || null]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/user_reports/:id (e.g. status update for admin)
router.patch('/user_reports/:id', requireAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'UPDATE public.user_reports SET status = $1 WHERE id = $2 RETURNING *',
        [status, req.params.id]
      )
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/locations
router.get('/locations', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.locations ORDER BY category, display_order, name')
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/locations/:id
router.patch('/locations/:id', requireAuth, async (req, res) => {
  try {
    const { active, name, category, city, display_order } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (typeof active === 'boolean') { updates.push(`active = $${i++}`); values.push(active); }
    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
    if (category !== undefined) { updates.push(`category = $${i++}`); values.push(category); }
    if (city !== undefined) { updates.push(`city = $${i++}`); values.push(city); }
    if (display_order !== undefined) { updates.push(`display_order = $${i++}`); values.push(display_order); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    const r = await runWithUser(req.user.id, (client) =>
      client.query(`UPDATE public.locations SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values)
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/locations
router.post('/locations', requireAuth, async (req, res) => {
  try {
    const { name, category, city, display_order, active } = req.body || {};
    if (!name || !category) return res.status(400).json({ error: 'name and category required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.locations (name, category, city, display_order, active) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [name, category, city || 'Vadodara', display_order != null ? display_order : 0, active !== false]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/ratings - get for a user or ride
router.get('/ratings', requireAuth, async (req, res) => {
  try {
    const { rated_user_id, ride_id } = req.query;
    let sql = 'SELECT * FROM public.ratings WHERE 1=1';
    const values = [];
    let i = 1;
    if (rated_user_id) { sql += ` AND rated_user_id = $${i++}`; values.push(rated_user_id); }
    if (ride_id) { sql += ` AND ride_id = $${i++}`; values.push(ride_id); }
    const r = await runWithUser(req.user.id, (client) => client.query(sql, values));
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/ratings
router.post('/ratings', requireAuth, async (req, res) => {
  try {
    const { rated_user_id, ride_id, rating, comment } = req.body || {};
    if (!rated_user_id || !ride_id || rating == null) {
      return res.status(400).json({ error: 'rated_user_id, ride_id, rating required' });
    }
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        'INSERT INTO public.ratings (rater_user_id, rated_user_id, ride_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [req.user.id, rated_user_id, ride_id, rating, comment || null]
      )
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/reward_history - for current user
router.get('/reward_history', requireAuth, async (req, res) => {
  try {
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.reward_history WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id])
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/group_chat_messages?group_chat_id=
router.get('/group_chat_messages', requireAuth, async (req, res) => {
  try {
    const { group_chat_id, before } = req.query;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10) || 30, 1), 100);
    if (!group_chat_id) return res.status(400).json({ error: 'group_chat_id required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query(
        `SELECT *
           FROM (
             SELECT *
               FROM public.group_chat_messages
              WHERE group_chat_id = $1
                AND ($2::timestamp with time zone IS NULL OR created_at < $2::timestamp with time zone)
              ORDER BY created_at DESC
              LIMIT $3
           ) messages
          ORDER BY created_at ASC`,
        [group_chat_id, before || null, limit]
      )
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /data/group_chat_messages
router.post('/group_chat_messages', requireAuth, async (req, res) => {
  try {
    const {
      group_chat_id,
      message,
      message_type = 'text',
      media_url = null,
      media_mime_type = null,
      file_name = null,
      file_size = null,
      reply_to_id = null,
      voice_duration_seconds = null,
      metadata = {},
      system_event = null,
    } = req.body || {};

    if (!group_chat_id) {
      return res.status(400).json({ error: 'group_chat_id required' });
    }
    if ((message == null || message === '') && !media_url && !system_event) {
      return res.status(400).json({ error: 'message or media required' });
    }

    const payload = await runWithUser(req.user.id, async (client) => {
      const membersResult = await client.query(
        'SELECT user_id FROM public.group_chat_members WHERE group_chat_id = $1',
        [group_chat_id]
      );

      if (membersResult.rows.length === 0) {
        throw new Error('Group chat not found');
      }

      const messageResult = await client.query(
        `INSERT INTO public.group_chat_messages (
           group_chat_id,
           sender_id,
           message,
           message_type,
           media_url,
           media_mime_type,
           file_name,
           file_size,
           reply_to_id,
           voice_duration_seconds,
           metadata,
           system_event
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING *`,
        [
          group_chat_id,
          req.user.id,
          message || '',
          message_type,
          media_url,
          media_mime_type,
          file_name,
          file_size,
          reply_to_id,
          voice_duration_seconds,
          JSON.stringify(metadata || {}),
          system_event,
        ]
      );

      return {
        message: messageResult.rows[0],
        memberIds: membersResult.rows.map((row) => row.user_id),
      };
    });

    emitGroupEvent(group_chat_id, 'group:message:new', payload.message);
    payload.memberIds.forEach((memberId) => {
      emitUserEvent(memberId, 'group:preview:refresh', { groupId: group_chat_id });
    });

    return res.status(201).json(payload.message);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/group_chat_messages/:id
router.patch('/group_chat_messages/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const payload = await runWithUser(req.user.id, async (client) => {
      const currentResult = await client.query(
        'SELECT * FROM public.group_chat_messages WHERE id = $1',
        [req.params.id]
      );
      if (currentResult.rows.length === 0) {
        return null;
      }

      const current = currentResult.rows[0];
      let updated;

      if (typeof body.reaction === 'string' && body.reaction.trim()) {
        const nextReactions = toggleReaction(current.reactions, body.reaction.trim(), req.user.id);
        updated = await client.query(
          'UPDATE public.group_chat_messages SET reactions = $2::jsonb WHERE id = $1 RETURNING *',
          [req.params.id, JSON.stringify(nextReactions)]
        );
      } else if (body.deleted_for_everyone === true) {
        if (current.sender_id !== req.user.id) {
          throw new Error('Only the sender can delete this message for everyone');
        }
        updated = await client.query(
          `UPDATE public.group_chat_messages
              SET deleted_for_everyone = true,
                  message = 'This message was deleted',
                  media_url = NULL,
                  media_mime_type = NULL,
                  file_name = NULL,
                  file_size = NULL,
                  metadata = '{}'::jsonb
            WHERE id = $1
            RETURNING *`,
          [req.params.id]
        );
      } else {
        throw new Error('No allowed fields');
      }

      const membersResult = await client.query(
        'SELECT user_id FROM public.group_chat_members WHERE group_chat_id = $1',
        [updated.rows[0].group_chat_id]
      );

      return {
        message: updated.rows[0],
        memberIds: membersResult.rows.map((row) => row.user_id),
      };
    });

    if (!payload) return res.status(404).json({ error: 'Not found' });

    const eventName =
      typeof body.reaction === 'string' ? 'group:message:reaction' : 'group:message:updated';

    emitGroupEvent(payload.message.group_chat_id, eventName, payload.message);
    payload.memberIds.forEach((memberId) => {
      emitUserEvent(memberId, 'group:preview:refresh', { groupId: payload.message.group_chat_id });
    });

    return res.json(payload.message);
  } catch (err) {
    console.error(err);
    return res.status(/not found/i.test(err.message || '') ? 404 : 500).json({ error: err.message });
  }
});

// GET /data/group_chat_reads?group_chat_id=
router.get('/group_chat_reads', requireAuth, async (req, res) => {
  try {
    const { group_chat_id } = req.query;
    let sql = 'SELECT * FROM public.group_chat_reads WHERE user_id = $1';
    const values = [req.user.id];
    if (group_chat_id) {
      sql += ' AND group_chat_id = $2';
      values.push(group_chat_id);
    }
    const r = await runWithUser(req.user.id, (client) => client.query(sql, values));
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /data/group_chat_reads/:group_chat_id
router.patch('/group_chat_reads/:group_chat_id', requireAuth, async (req, res) => {
  try {
    const readAt = req.body?.last_read_at || new Date().toISOString();
    const payload = await runWithUser(req.user.id, async (client) => {
      const row = await client.query(
        `INSERT INTO public.group_chat_reads (group_chat_id, user_id, last_read_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_chat_id, user_id)
         DO UPDATE SET last_read_at = EXCLUDED.last_read_at
         RETURNING *`,
        [req.params.group_chat_id, req.user.id, readAt]
      );
      const membersResult = await client.query(
        'SELECT user_id FROM public.group_chat_members WHERE group_chat_id = $1',
        [req.params.group_chat_id]
      );
      return {
        read: row.rows[0],
        memberIds: membersResult.rows.map((member) => member.user_id),
      };
    });

    emitGroupEvent(req.params.group_chat_id, 'group:read', payload.read);
    payload.memberIds.forEach((memberId) => {
      emitUserEvent(memberId, 'group:preview:refresh', { groupId: req.params.group_chat_id });
    });

    return res.json(payload.read);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /data/group_chats - list for user (via RPC get_user_group_chats is used in app)
// GET /data/group_chat_members?group_chat_id=
router.get('/group_chat_members', requireAuth, async (req, res) => {
  try {
    const { group_chat_id } = req.query;
    if (!group_chat_id) return res.status(400).json({ error: 'group_chat_id required' });
    const r = await runWithUser(req.user.id, (client) =>
      client.query('SELECT * FROM public.group_chat_members WHERE group_chat_id = $1 ORDER BY joined_at ASC', [group_chat_id])
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
