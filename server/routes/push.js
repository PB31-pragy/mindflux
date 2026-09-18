import { Router } from 'express';
import { query, ensurePushSubscriptionsTable } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getVapidPublicKey, isPushConfigured } from '../lib/webPush.js';

const router = Router();

// GET /push/vapid-public-key - public, the frontend needs this before it can
// call pushManager.subscribe().
router.get('/vapid-public-key', (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: 'Push notifications are not configured on the server' });
  }
  res.json({ publicKey: getVapidPublicKey() });
});

// POST /push/subscribe - store (or refresh) a browser's push subscription
// for the current user. One row per unique endpoint, so re-subscribing the
// same browser/device just updates its keys instead of duplicating.
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }

    await ensurePushSubscriptionsTable();
    await query(
      `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint)
       DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
      [req.user.id, endpoint, keys.p256dh, keys.auth],
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[push] subscribe error:', err);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

// POST /push/unsubscribe - drop a subscription, e.g. on logout or when the
// browser reports the subscription is no longer valid.
router.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }

    await ensurePushSubscriptionsTable();
    await query(
      'DELETE FROM public.push_subscriptions WHERE endpoint = $1 AND user_id = $2',
      [endpoint, req.user.id],
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

export default router;
