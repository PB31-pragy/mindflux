import { Router } from 'express';
import { withUser } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ✅ RPC name -> parameters
const RPC_PARAMS = {
  get_public_profile: ['_user_id'],
  get_approved_contact_details: ['_target_user_id', '_requesting_user_id'],
  owner_delete_ride: ['_user_id', '_ride_id'],

  // ❌ REMOVED get_user_connections (THIS WAS BREAKING)

  admin_force_cancel_ride: ['_ride_id'],
  admin_get_all_rewards: [],
  admin_mark_reward_delivered: ['_reward_id'],
  admin_gift_reward: ['_target_user_id', '_reward_type', '_reward_name', '_reward_description'],
  admin_toggle_user_rewards: ['_target_user_id', '_enabled'],
  admin_set_reward_free_spin_access: ['_caller_id', '_target_user_id', '_enabled'],
  // Two-arg: server injects authenticated admin as _caller_id (must match 2-param SQL overload)
  admin_gift_premium: ['_caller_id', '_target_user_id'],
  admin_remove_premium: ['_caller_id', '_target_user_id'],

  get_user_group_chats: ['_user_id'],
  pay_accept_request: ['_user_id', '_ride_request_id', '_payment_source', '_razorpay_payment_id'],
  get_connection_for_request: ['_ride_request_id'],
  get_group_chat_members: ['_group_chat_id'],
  get_spin_progress: ['_user_id'],
  get_user_reward_history: ['_user_id'],
  perform_spin: ['_user_id'],
  get_user_rating: ['_user_id'],
  has_rated_user: ['_rater_id', '_rated_id', '_ride_id'],
  create_and_pay_join_request: [
    '_requester_id',
    '_ride_id',
    '_payment_source',
    '_requester_show_profile_photo',
    '_requester_show_mobile_number',
    '_razorpay_payment_id',
  ],
  activate_premium_subscription: ['_user_id', '_razorpay_payment_id', '_razorpay_order_id'],
};

// ✅ Types
const RPC_TYPES = {
  get_public_profile: ['uuid'],
  get_approved_contact_details: ['uuid', 'uuid'],
  owner_delete_ride: ['uuid', 'uuid'],

  // ❌ REMOVED get_user_connections

  admin_force_cancel_ride: ['uuid'],
  admin_mark_reward_delivered: ['uuid'],
  admin_gift_reward: ['uuid', 'text', 'text', 'text'],
  admin_toggle_user_rewards: ['uuid', 'boolean'],
  admin_set_reward_free_spin_access: ['uuid', 'uuid', 'boolean'],
  admin_gift_premium: ['uuid', 'uuid'],
  admin_remove_premium: ['uuid', 'uuid'],

  get_user_group_chats: ['uuid'],
  pay_accept_request: ['uuid', 'uuid', 'text', 'text'],
  get_connection_for_request: ['uuid'],
  get_group_chat_members: ['uuid'],
  get_spin_progress: ['uuid'],
  get_user_reward_history: ['uuid'],
  perform_spin: ['uuid'],
  get_user_rating: ['uuid'],
  has_rated_user: ['uuid', 'uuid', 'uuid'],
  create_and_pay_join_request: ['uuid', 'uuid', 'text', 'boolean', 'boolean', 'text'],
  activate_premium_subscription: ['uuid', 'text', 'text'],
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ✅ Removed get_user_connections from here also
const CURRENT_USER_RPC_FIRST_PARAM = new Set([
  'get_spin_progress',
  'get_user_reward_history',
  'perform_spin',
  'get_user_group_chats',
  'get_user_rating',
]);

// ✅ MAIN ROUTE
router.post('/:name', requireAuth, async (req, res) => {
  try {
    const name = req.params.name;
    const body = req.body || {};

    // Scalar boolean Postgres functions MUST use SELECT fn(...) AS alias — not SELECT * FROM fn(...),
    // and we always send two UUIDs (caller JWT + explicit target).
    if (name === 'admin_remove_premium' || name === 'admin_gift_premium' || name === 'admin_set_reward_free_spin_access') {
      if (!req.user?.id || !UUID_REGEX.test(String(req.user.id))) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const targetId = body._target_user_id;
      if (!targetId || !UUID_REGEX.test(String(targetId))) {
        return res.status(400).json({ error: 'Invalid or missing _target_user_id' });
      }

      const params =
        name === 'admin_set_reward_free_spin_access'
          ? [String(req.user.id), String(targetId), Boolean(body._enabled)]
          : [String(req.user.id), String(targetId)];
      const placeholders =
        name === 'admin_set_reward_free_spin_access'
          ? '$1::uuid, $2::uuid, $3::boolean'
          : '$1::uuid, $2::uuid';
      const sql = `SELECT public.${name}(${placeholders}) AS ${name}`;

      const result = await withUser(req.user.id, async (client) => client.query(sql, params));
      return res.json(result.rows);
    }

    const paramOrder = RPC_PARAMS[name];

    if (!paramOrder) {
      return res.status(404).json({ error: `Unknown RPC: ${name}` });
    }

    let values = paramOrder.map((key) => body[key]);

    // ✅ Auto inject user_id
    if (CURRENT_USER_RPC_FIRST_PARAM.has(name) && paramOrder[0] === '_user_id' && req.user?.id) {
      const v = values[0];
      if (!v || !UUID_REGEX.test(v)) {
        values[0] = req.user.id;
      }
    }

    const types = RPC_TYPES[name];

    // ✅ Validate UUID
    if (types) {
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'uuid') {
          const v = values[i];
          if (!v || !UUID_REGEX.test(v)) {
            return res.status(400).json({
              error: `Invalid or missing UUID for ${paramOrder[i]}`,
            });
          }
        }
      }
    }

    // ✅ Build SQL
    const placeholders = values
      .map((_, i) =>
        types && types[i] ? `$${i + 1}::${types[i]}` : `$${i + 1}`
      )
      .join(', ');

    const sql = `SELECT * FROM public.${name}(${placeholders})`;

    const result = await withUser(req.user.id, async (client) => {
      return client.query(sql, values);
    });

    return res.json(result.rows);

  } catch (err) {
    console.error('RPC error:', err);
    return res.status(500).json({
      error: err.message || 'RPC failed',
    });
  }
});

export default router;
