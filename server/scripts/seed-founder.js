/**
 * One-time seed: create or reset founder admin account.
 * Run from server directory:
 *   FOUNDER_SEED_PASSWORD='YourPassword' node scripts/seed-founder.js
 * Optional: FOUNDER_SEED_EMAIL (default: campusauto.pb@gmail.com)
 *
 * Requires DATABASE_URL in server/.env
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { query } from '../db.js';

const SALT_ROUNDS = 10;
const EMAIL = (process.env.FOUNDER_SEED_EMAIL || 'campusauto.pb@gmail.com').toLowerCase().trim();

async function seed() {
  const password = process.env.FOUNDER_SEED_PASSWORD;
  if (!password || password.length < 6) {
    console.error('Set FOUNDER_SEED_PASSWORD (min 6 chars) and run from server directory.');
    process.exit(1);
  }

  const existing = await query('SELECT id FROM public.auth_users WHERE email = $1', [EMAIL]);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await query('UPDATE public.auth_users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
    await query(
      `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [id]
    );
    console.log('Founder account updated:', EMAIL, '(password reset, admin role ensured)');
  } else {
    const id = crypto.randomUUID();
    await query('BEGIN');
    try {
      await query(
        `INSERT INTO public.auth_users (id, email, password_hash, email_confirmed_at)
         VALUES ($1, $2, $3, now())`,
        [id, EMAIL, passwordHash]
      );
      await query(
        `INSERT INTO public.profiles (user_id, full_name, email)
         VALUES ($1, $2, $3)`,
        [id, 'Founder', EMAIL]
      );
      await query(
        `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`,
        [id]
      );
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
    console.log('Founder account created:', EMAIL, '| user_id:', id);
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
