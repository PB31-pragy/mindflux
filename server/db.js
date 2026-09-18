import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Email-verification codes used to live in an in-memory Map. That meant a
// code disappeared whenever the server restarted and could be unavailable if
// a load balancer sent the verification request to another instance. Keep the
// small, server-only store in Postgres instead. `IF NOT EXISTS` makes this
// safe for existing deployments and removes a manual migration prerequisite.
let authOtpTablesReady;
export function ensureAuthOtpTables() {
  if (!authOtpTablesReady) {
    authOtpTablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.email_verification_otps (
          id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
          email TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          used BOOLEAN NOT NULL DEFAULT false,
          sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
      `);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_email_verification_otps_email_created ON public.email_verification_otps (email, created_at DESC)',
      );
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_email_verification_otps_expires ON public.email_verification_otps (expires_at)',
      );
    })();
  }

  return authOtpTablesReady;
}

// Web Push subscriptions (one row per browser/device a user has enabled
// notifications on). `IF NOT EXISTS` keeps this safe to run on every boot,
// matching the pattern used for the OTP tables above.
let pushSubscriptionsTableReady;
export function ensurePushSubscriptionsTable() {
  if (!pushSubscriptionsTableReady) {
    pushSubscriptionsTableReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.push_subscriptions (
          id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
          user_id UUID NOT NULL,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        )
      `);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON public.push_subscriptions (user_id)',
      );
    })();
  }

  return pushSubscriptionsTableReady;
}

// UUID format (no single quotes allowed - safe to interpolate)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run a function with app.current_user_id set for RLS.
 * SET LOCAL does not accept $1 parameters in PostgreSQL, so we set the value safely.
 * @param {string} userId - UUID of the current user (from JWT)
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    if (!userId || !UUID_REGEX.test(String(userId))) {
      throw new Error('Invalid user id for RLS');
    }
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_user_id = '${userId}'`);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

/**
 * Run a system-level operation atomically. Use this for admin mutations that
 * must write both domain data and a notification together.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Run query without setting user (for auth routes that need to look up by email, etc.)
 */
export function query(text, params) {
  return pool.query(text, params);
}

export default pool;
