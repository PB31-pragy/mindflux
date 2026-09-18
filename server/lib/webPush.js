import webpush from 'web-push';
import { query, ensurePushSubscriptionsTable } from '../db.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY?.trim() || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim() || null;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT?.trim() || 'mailto:support@yaatrabuddy.com';

const isConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (isConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn(
    '[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — background push notifications are disabled until they are configured.',
  );
}

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

export function isPushConfigured() {
  return isConfigured;
}

/**
 * Sends a push message to every subscription (browser/device) the user has
 * registered. Dead subscriptions (uninstalled, permission revoked, etc.)
 * come back as 404/410 from the push service and are cleaned up here.
 */
export async function sendPushToUser(userId, payload) {
  if (!isConfigured || !userId) return;

  await ensurePushSubscriptionsTable();
  const { rows } = await query(
    'SELECT id, endpoint, p256dh, auth FROM public.push_subscriptions WHERE user_id = $1',
    [userId],
  );
  if (rows.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          body,
        );
      } catch (error) {
        const statusCode = error?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription is no longer valid on the push service's end.
          await query('DELETE FROM public.push_subscriptions WHERE id = $1', [row.id]).catch(
            () => {},
          );
        } else {
          console.warn('[push] Failed to send push notification:', error?.message || error);
        }
      }
    }),
  );
}
