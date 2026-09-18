import { query } from '../db.js';
import { emitUserEvent } from '../realtime.js';
import { sendPushToUser } from './webPush.js';

// Valid notification types allowed by database constraint
const VALID_TYPES = new Set([
  'info',
  'success',
  'warning',
  'error',
  'request',
  'approved',
  'declined',
  'new_request',
  'ride_declined',
  'ride_accepted',
  'payment_success',
  'payment_confirmed',
  'wallet_refunded',
]);

/**
 * Creates and stores a notification in the database with deduplication and realtime event emission.
 * @param {Object} params
 * @param {string} params.userId - Recipient user UUID
 * @param {string} params.title - Notification title
 * @param {string} params.message - Notification body message
 * @param {string} [params.type='info'] - Notification type
 * @param {string|null} [params.rideId=null] - Optional associated ride UUID
 * @param {string|null} [params.rideRequestId=null] - Optional associated ride request UUID
 * @param {import('pg').PoolClient} [params.client] - Optional transaction client
 * @param {boolean} [params.emit=true] - Set false when the caller emits after its transaction commits
 * @returns {Promise<Object>} The newly created notification row
 */
export async function createNotification({
  userId,
  title,
  message,
  type = 'info',
  rideId = null,
  rideRequestId = null,
  client = null,
  emit = true,
}) {
  if (!userId) {
    throw new Error('userId is required to create a notification');
  }

  const cleanTitle = String(title || '').trim();
  const cleanMessage = String(message || '').trim();
  let cleanType = String(type || 'info').toLowerCase().trim();

  if (!VALID_TYPES.has(cleanType)) {
    if (cleanType.includes('block') || cleanType === 'danger') {
      cleanType = 'error';
    } else if (cleanType.includes('unblock') || cleanType.includes('verify')) {
      cleanType = 'success';
    } else if (cleanType.includes('reject') || cleanType === 'warn') {
      cleanType = 'warning';
    } else {
      cleanType = 'info';
    }
  }

  // Deduplication check: prevent duplicate notifications within 15 seconds
  const execute = client ? client.query.bind(client) : query;
  const existingRecent = await execute(
    `SELECT id, user_id, title, message, type, read, created_at
       FROM public.notifications
      WHERE user_id = $1
        AND title = $2
        AND message = $3
        AND created_at >= (now() - INTERVAL '15 seconds')
      LIMIT 1`,
    [userId, cleanTitle, cleanMessage]
  ).catch((err) => {
    console.warn('[notifications] deduplication check failed:', err);
    return { rows: [] };
  });

  if (existingRecent.rows.length > 0) {
    return existingRecent.rows[0];
  }

  const result = await execute(
    `INSERT INTO public.notifications (user_id, title, message, type, ride_id, ride_request_id, read, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, now())
     RETURNING *`,
    [userId, cleanTitle, cleanMessage, cleanType, rideId || null, rideRequestId || null]
  );

  const row = result.rows[0];

  // Broadcast realtime socket notification event to the specific recipient room
  if (emit) {
    try {
      emitUserEvent(userId, 'notification:new', row);
    } catch (emitErr) {
      console.warn('[notifications] socket emit failed:', emitErr);
    }

    // Web Push reaches the user even if no tab is open at all (backgrounded
    // or fully closed browser). Never let a push failure break the caller's
    // request — the notification row above is already saved regardless.
    sendPushToUser(userId, {
      title: cleanTitle,
      body: cleanMessage,
      path: `/notification/${row.id}`,
      tag: `app-notification-${row.id}`,
    }).catch((pushErr) => {
      console.warn('[notifications] push send failed:', pushErr);
    });
  }

  return row;
}
