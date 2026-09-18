import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import pool, { ensureAuthOtpTables, query } from "../db.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import {Resend} from "resend";
import { getResendApiKey } from "../env.js";
import { createRateLimiter, getJwtSecret, hashOtp } from "../security.js";
import { normalizeMobileNumber, phoneNumberSql } from "../lib/phone.js";

const resendApiKey = getResendApiKey();
// Resend rejects an empty key during module evaluation, so only create the
// client when a key exists. SMTP remains a supported fallback for both OTP
// flows: local development commonly has SMTP configured while production
// commonly uses Resend.
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const resendFrom = process.env.RESEND_FROM?.trim() || null;

// SMTP transporter, built once and reused. It deliberately supports both
// signup and reset codes so the two account flows cannot drift apart.
const gmailUser = process.env.EMAIL_USER?.trim();
const gmailPass = process.env.EMAIL_PASS?.trim();
const gmailTransporter =
  gmailUser && gmailPass
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser, pass: gmailPass },
        // A network/provider problem should fail promptly rather than leave
        // the signup screen spinning for about a minute.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      })
    : null;

if (!gmailTransporter) {
  console.warn(
    "[auth] EMAIL_USER/EMAIL_PASS not set — password-reset emails are disabled until they are configured.",
  );
}
const router = Router();
const SALT_ROUNDS = 10;
const FOUNDER_EMAIL = "campusauto.pb@gmail.com";
const APP_NAME = "2Ride";
const SUPPORT_EMAIL = "support@yaatrabuddy.com";
const JWT_SECRET = getJwtSecret();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PASSWORD_RESET_OTP_EXPIRY_MINUTES = 5;
const EMAIL_VERIFICATION_OTP_EXPIRY_MINUTES = 10;
const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_EMAIL_OTP_ATTEMPTS = 5;
const MAX_PASSWORD_RESET_ATTEMPTS = 5;
const OTP_REGEX = /^\d{6}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function isValidEmail(email) {
  return EMAIL_REGEX.test(normalizeEmail(email));
}

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const signInRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 8 : 30,
  key: (req) => `${req.ip}:signin:${normalizeEmail(req.body?.email) || 'unknown'}`,
  message: 'Too many sign-in attempts. Please wait before trying again.',
});

const signUpRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 6,
  key: (req) => `${req.ip}:signup:${normalizeEmail(req.body?.email) || 'unknown'}`,
  message: 'Too many sign-up attempts. Please wait before trying again.',
});

const otpSendRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  key: (req) => `${req.ip}:email-otp-send:${normalizeEmail(req.body?.email) || 'unknown'}`,
  message: 'Too many OTP requests. Please wait before requesting another code.',
});

const otpVerifyRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  key: (req) => `${req.ip}:email-otp-verify:${normalizeEmail(req.body?.email) || 'unknown'}`,
  message: 'Too many OTP verification attempts. Please wait before trying again.',
});

const passwordResetRequestRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  key: (req) => `${req.ip}:password-reset-request:${normalizeEmail(req.body?.email) || 'unknown'}`,
  message: 'Too many password reset requests. Please wait before trying again.',
});

const passwordResetVerifyRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  key: (req) => `${req.ip}:password-reset-verify:${normalizeEmail(req.body?.email) || 'unknown'}`,
  message: 'Too many password reset attempts. Please wait before trying again.',
});

async function getAuthUserProfile(userId) {
  const result = await query(
    `SELECT
       p.user_id AS id,
       lower(trim(p.email)) AS email,
       p.full_name,
       p.avatar_url,
       p.phone_number,
       COALESCE(p.is_verified, false) AS is_verified,
       COALESCE(p.is_premium, false) AS is_premium,
       p.subscription_expiry
     FROM public.profiles p
     WHERE p.user_id = $1
     LIMIT 1`,
    [userId],
  );

  return result.rows[0] || null;
}

function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

function buildOtpMessages({ otp, purpose, expiryMinutes }) {
  const title = purpose === 'password_reset' ? 'Password Reset Verification' : 'Verify Your Email';
  const action = purpose === 'password_reset'
    ? `reset your ${APP_NAME} password`
    : `finish creating your ${APP_NAME} account`;

  const text = `${title}

Your verification code to ${action} is:

${otp}

This code is valid for ${expiryMinutes} minutes.
Do not share this code with anyone.

If you did not request this, you can safely ignore this message.
Need help? Contact ${SUPPORT_EMAIL}.`;

  const html = `
<div style="margin:0;padding:0;background:#062016;font-family:Arial,Helvetica,sans-serif;color:#f8f3ea;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#0f3425;border:1px solid rgba(246,221,169,0.18);border-radius:16px;padding:32px 28px;">
      <div style="font-size:18px;font-weight:700;color:#f6dda9;margin-bottom:20px;">${APP_NAME}</div>
      <h1 style="font-size:24px;line-height:1.25;margin:0 0 12px;color:#ffffff;">${title}</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 24px;color:#dfd7ca;">
        Use this verification code to ${action}.
      </p>
      <div style="text-align:center;margin:28px 0;">
        <div style="display:inline-block;letter-spacing:8px;font-size:34px;font-weight:800;color:#062016;background:#f6dda9;border-radius:12px;padding:16px 22px;">
          ${otp}
        </div>
      </div>
      <p style="font-size:14px;line-height:1.6;margin:0 0 10px;color:#dfd7ca;">
        This code is valid for <strong style="color:#ffffff;">${expiryMinutes} minutes</strong>.
      </p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 20px;color:#dfd7ca;">
        Do not share this code with anyone. ${APP_NAME} will never ask for your OTP outside the app.
      </p>
      <div style="border-top:1px solid rgba(246,221,169,0.16);padding-top:18px;margin-top:22px;">
        <p style="font-size:13px;line-height:1.6;margin:0;color:#bdb4a6;">
          If you did not request this, you can safely ignore this email.
          For help, contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#f6dda9;text-decoration:none;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>
    </div>
  </div>
</div>`;

  return { text, html, subject: `${APP_NAME} ${title} Code` };
}

async function sendOtpEmail({ email, otp, purpose, expiryMinutes }) {
  const messages = buildOtpMessages({ otp, purpose, expiryMinutes });
  const resendError = 'Could not send the verification email. Please try again in a moment.';

  // A Resend sender must be a domain verified in the Resend dashboard. Do not
  // use onboarding@resend.dev in production: it only delivers to the Resend
  // account owner and is exactly why real users saw the error in the screenshot.
  if (resend && resendFrom) {
    try {
      const result = await resend.emails.send({
        from: resendFrom,
        to: email,
        subject: messages.subject,
        text: messages.text,
        html: messages.html,
      });
      if (!result?.error) return;
      console.error('[email] Resend rejected OTP email:', result.error);
    } catch (error) {
      console.error('[email] Resend failed to send OTP email:', error);
    }
  }

  if (gmailTransporter) {
    try {
      await gmailTransporter.sendMail({
        from: `${APP_NAME} <${gmailUser}>`,
        to: email,
        subject: messages.subject,
        text: messages.text,
        html: messages.html,
      });
      return;
    } catch (error) {
      console.error('[email] SMTP failed to send OTP email:', error);
      throw new Error(resendError);
    }
  }

  if (resend && !resendFrom) {
    console.error('[email] RESEND_API_KEY is set but RESEND_FROM is missing.');
  }
  throw new Error(resendError);
}

// POST /auth/signup - create auth_users + profiles
router.post("/send-email-otp", otpSendRateLimit, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    await ensureAuthOtpTables();
    const emailLower = normalizeEmail(email);
    const recentOtp = await query(
      `SELECT sent_at
       FROM public.email_verification_otps
       WHERE email = $1 AND used = false AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [emailLower],
    );
    const sentAt = recentOtp.rows[0]?.sent_at ? new Date(recentOtp.rows[0].sent_at).getTime() : 0;
    if (sentAt && Date.now() - sentAt < EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) {
      return res.status(429).json({
        error: "Please wait a minute before requesting a new verification code.",
      });
    }

    const otp = generateOTP();
    try {
      await sendOtpEmail({
        email: emailLower,
        otp,
        purpose: 'email_verification',
        expiryMinutes: EMAIL_VERIFICATION_OTP_EXPIRY_MINUTES,
      });
    } catch (sendErr) {
      console.error("[send-email-otp] Email delivery failed:", sendErr);
      return res.status(502).json({
        error:
          "Could not send the verification email. Please try again in a moment.",
      });
    }

    const expiresAt = new Date(
      Date.now() + EMAIL_VERIFICATION_OTP_EXPIRY_MINUTES * 60 * 1000,
    );
    await query(
      'UPDATE public.email_verification_otps SET used = true WHERE email = $1 AND used = false',
      [emailLower],
    );
    await query(
      `INSERT INTO public.email_verification_otps (email, token_hash, expires_at, attempts, used)
       VALUES ($1, $2, $3, 0, false)`,
      [emailLower, hashOtp(otp), expiresAt],
    );

    res.json({ message: "OTP sent to email" });
  } catch (err) {
    console.error("[send-email-otp] Unexpected error:", err);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});
router.post("/verify-email-otp", otpVerifyRateLimit, async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP required" });
    }

    if (!isValidEmail(email) || !OTP_REGEX.test(String(otp))) {
      return res.status(400).json({ error: "Invalid email or verification code" });
    }

    const emailLower = normalizeEmail(email);
    await ensureAuthOtpTables();
    const result = await query(
      `SELECT id, token_hash, expires_at, attempts, used
       FROM public.email_verification_otps
       WHERE email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [emailLower],
    );
    const record = result.rows[0];
    if (!record || record.used) {
      return res.status(400).json({ error: 'No verification code found. Please request a new one.' });
    }
    if (new Date(record.expires_at) <= new Date()) {
      await query('UPDATE public.email_verification_otps SET used = true WHERE id = $1', [record.id]);
      return res.status(400).json({ error: 'Verification code expired. Please request a new one.' });
    }
    if ((record.attempts ?? 0) >= MAX_EMAIL_OTP_ATTEMPTS) {
      await query('UPDATE public.email_verification_otps SET used = true WHERE id = $1', [record.id]);
      return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new code.' });
    }
    if (record.token_hash !== hashOtp(otp)) {
      const attempts = (record.attempts ?? 0) + 1;
      await query('UPDATE public.email_verification_otps SET attempts = $2 WHERE id = $1', [record.id, attempts]);
      return res.status(400).json({
        error: attempts >= MAX_EMAIL_OTP_ATTEMPTS
          ? 'Too many incorrect attempts. Please request a new code.'
          : 'Invalid verification code.',
      });
    }
    await query('UPDATE public.email_verification_otps SET used = true WHERE id = $1', [record.id]);
    const verificationToken = signToken(
      {
        sub: `email-verification:${emailLower}`,
        email: emailLower,
        type: 'email_verification',
      },
      { expiresIn: '15m' },
    );

    return res.json({ message: "Email verified successfully", verification_token: verificationToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});
// POST /auth/signup
router.post("/signup", signUpRateLimit, async (req, res) => {
  try {
    const { email, password, full_name, verification_token } = req.body;
    const rawMobileNumber =
      req.body?.phone_number ??
      req.body?.mobile_number ??
      req.body?.mobileNumber;

    if (!email || !password || !full_name || !verification_token || !rawMobileNumber) {
      return res.status(400).json({ error: "All fields required" });
    }

    const emailLower = normalizeEmail(email);
    const phoneNumber = normalizeMobileNumber(rawMobileNumber);
    if (!isValidEmail(emailLower)) {
      return res.status(400).json({ error: "Please enter a valid email" });
    }
    if (!phoneNumber) {
      return res.status(400).json({ error: "Please enter a valid mobile number" });
    }
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const trimmedFullName = typeof full_name === "string" ? full_name.trim() : "";
    if (trimmedFullName.length < 2 || trimmedFullName.length > 100) {
      return res.status(400).json({ error: "Please enter a valid full name" });
    }
    if (typeof verification_token !== "string" || verification_token.length > 2048) {
      return res.status(400).json({ error: "Email verification required" });
    }

    let decodedVerification;
    try {
      decodedVerification = jwt.verify(
        verification_token,
        JWT_SECRET,
        { algorithms: ['HS256'] },
      );
    } catch {
      return res.status(400).json({ error: "Email verification required" });
    }

    if (
      decodedVerification?.type !== 'email_verification' ||
      normalizeEmail(decodedVerification?.email) !== emailLower ||
      decodedVerification?.sub !== `email-verification:${emailLower}`
    ) {
      return res.status(400).json({ error: "Email verification required" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`signup-email:${emailLower}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`signup-phone:${phoneNumber}`]);

      const existingEmail = await client.query(
        "SELECT id FROM public.auth_users WHERE lower(trim(email)) = $1 LIMIT 1",
        [emailLower],
      );
      const existingPhone = await client.query(
        `SELECT user_id FROM public.profiles WHERE ${phoneNumberSql('phone_number')} = $1 LIMIT 1`,
        [phoneNumber],
      );

      if (existingEmail.rows.length > 0 || existingPhone.rows.length > 0) {
        await client.query('ROLLBACK');
        if (existingEmail.rows.length > 0 && existingPhone.rows.length > 0) {
          return res.status(409).json({ error: "This email and mobile number are already registered. Please sign in." });
        }
        if (existingEmail.rows.length > 0) {
          return res.status(409).json({ error: "An account with this email already exists. Please sign in instead." });
        }
        return res.status(409).json({ error: "This mobile number is already registered. Please sign in instead." });
      }

      await client.query(
        `INSERT INTO public.auth_users (id, email, password_hash, email_confirmed_at)
         VALUES ($1, $2, $3, now())`,
        [id, emailLower, passwordHash],
      );

      await client.query(
        `INSERT INTO public.profiles (user_id, full_name, email, phone_number)
         VALUES ($1, $2, $3, $4)`,
        [id, trimmedFullName, emailLower, phoneNumber],
      );

      await client.query('COMMIT');
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }

    const token = signToken({ sub: id, email: emailLower });

    const profile = await getAuthUserProfile(id);

    res.json({
      user: profile || { id, email: emailLower },
      token,
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});
// POST /auth/signin
router.post("/signin", signInRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const emailLower = normalizeEmail(email);
    const r = await query(
      "SELECT id, lower(trim(email)) AS email, password_hash FROM public.auth_users WHERE lower(trim(email)) = $1 LIMIT 1",
      [emailLower],
    );
    if (r.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const user = r.rows[0];
    // 🔥 ADD THIS HERE
    if (!user.password_hash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    await query(
      `UPDATE public.auth_users
          SET email = $1,
              email_confirmed_at = COALESCE(email_confirmed_at, now())
        WHERE id = $2
          AND (email <> $1 OR email_confirmed_at IS NULL)`,
      [emailLower, user.id],
    );
    const token = signToken({ sub: user.id, email: emailLower });
    const profile = await getAuthUserProfile(user.id);
    return res.json({ user: profile || { id: user.id, email: user.email }, token });
  } catch (err) {
    console.error("Signin error:", err);
    return res.status(500).json({ error: err.message || "Sign in failed" });
  }
});

// POST /auth/request-password-reset
router.post("/request-password-reset", passwordResetRequestRateLimit, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }

    const emailLower = normalizeEmail(email);

    const userResult = await query(
      "SELECT 1 FROM public.auth_users WHERE lower(trim(email)) = $1 LIMIT 1",
      [emailLower],
    );

    if (userResult.rows.length === 0) {
      return res.json({
        success: true,
        message: "Password reset verification code sent",
      });
    }

    const otp = generateOTP();

    // Only proceed to store/return success once the configured provider
    // accepts the email — never report success on a failed send.
    try {
      await sendOtpEmail({
        email: emailLower,
        otp,
        purpose: 'password_reset',
        expiryMinutes: PASSWORD_RESET_OTP_EXPIRY_MINUTES,
      });
    } catch (sendErr) {
      console.error("[request-password-reset] Email delivery failed:", sendErr);
      return res.status(502).json({
        error: "Could not send the verification email. Please try again in a moment.",
      });
    }

    const tokenHash = crypto.createHash("sha256").update(otp).digest("hex");

    const expiresAt = new Date(
      Date.now() + PASSWORD_RESET_OTP_EXPIRY_MINUTES * 60 * 1000,
    );

    await query(
      "UPDATE public.password_reset_tokens SET used = true WHERE email = $1 AND used = false",
      [emailLower],
    );
    // ✅ ONLY INSERT
    await query(
      `INSERT INTO public.password_reset_tokens (email, token_hash, expires_at, used, attempts)
       VALUES ($1, $2, $3, false, 0)`,
      [emailLower, tokenHash, expiresAt],
    );

    return res.json({
      success: true,
      message: "Password reset verification code sent",
    });
  } catch (err) {
    console.error("Request password reset error:", err);
    return res.status(500).json({ error: "Failed to process password reset request" });
  }
});
// ✅ ONLY VERIFY OTP (NO PASSWORD)
router.post("/verify-otp-only", passwordResetVerifyRateLimit, async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP required" });
    }

    if (!isValidEmail(email) || !OTP_REGEX.test(String(otp))) {
      return res.status(400).json({ error: "Invalid email or OTP format" });
    }

    const emailLower = normalizeEmail(email);
    const tokenHash = crypto.createHash("sha256").update(otp).digest("hex");

    const r = await query(
      `SELECT id, attempts, token_hash, expires_at, used 
       FROM public.password_reset_tokens
       WHERE email = $1
       ORDER BY created_at DESC LIMIT 1`,
      [emailLower],
    );

    if (!r.rows || r.rows.length === 0) {
      return res.status(400).json({ error: "No OTP found" });
    }

    const row = r.rows[0];

    if (row.used) {
      return res.status(400).json({ error: "OTP already used" });
    }

    if ((row.attempts ?? 0) >= MAX_PASSWORD_RESET_ATTEMPTS) {
      return res.status(400).json({
        error: "Too many incorrect attempts. Please request a new code.",
      });
    }

    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "OTP expired" });
    }

    if (row.token_hash !== tokenHash) {
      const nextAttempts = (row.attempts ?? 0) + 1;
      await query(
        "UPDATE public.password_reset_tokens SET attempts = $2 WHERE id = $1",
        [row.id, nextAttempts],
      );
      return res.status(400).json({
        error:
          nextAttempts >= MAX_PASSWORD_RESET_ATTEMPTS
            ? "Too many incorrect attempts. Please request a new code."
            : "Invalid OTP",
      });
    }

    // ✅ IMPORTANT: DO NOT mark used yet
    return res.json({ success: true });
  } catch (err) {
    console.error("Verify OTP error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
});
// POST /auth/verify-reset-token
router.post("/verify-reset-token", passwordResetVerifyRateLimit, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res
        .status(400)
        .json({ error: "Email, OTP, and new password are required" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email" });
    }
    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "Invalid OTP format" });
    }
    const emailLower = normalizeEmail(email);
    const tokenHash = crypto.createHash("sha256").update(otp).digest("hex");
    const r = await query(
      `SELECT id, attempts, token_hash, expires_at, used 
   FROM public.password_reset_tokens
   WHERE email = $1
   ORDER BY created_at DESC LIMIT 1`,
      [emailLower],
    );
    if (!r.rows || r.rows.length === 0) {
      return res.status(400).json({
        error: "No OTP found for this email.",
      });
    }
    const row = r.rows[0];
    if (row.used) {
      return res.status(400).json({
        error: "OTP already used",
      });
    }

    // ✅ check expiry
    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({
        error: "OTP expired",
      });
    }

    // ✅ check match
    if ((row.attempts ?? 0) >= MAX_PASSWORD_RESET_ATTEMPTS) {
      return res.status(400).json({
        error: "Too many incorrect attempts. Please request a new code.",
      });
    }
    if (row.token_hash !== tokenHash) {
      const nextAttempts = (row.attempts ?? 0) + 1;
      await query(
        "UPDATE public.password_reset_tokens SET attempts = $2 WHERE id = $1",
        [row.id, nextAttempts],
      );

      return res.status(400).json({
        error:
          nextAttempts >= MAX_PASSWORD_RESET_ATTEMPTS
            ? "Too many incorrect attempts. Please request a new code."
            : "Invalid OTP. Please try again.",
      });
    }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await query(
      "UPDATE public.auth_users SET password_hash = $1 WHERE email = $2",
      [passwordHash, emailLower],
    );
    await query(
      "UPDATE public.password_reset_tokens SET used = true WHERE id = $1",
      [row.id],
    );
    return res.json({
      success: true,
      message:
        "Password has been reset successfully. You can now sign in with your new password.",
    });
  } catch (err) {
    console.error("Verify reset token error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to reset password" });
  }
});
// gift premium 
router.post("/admin/gift-premium", requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "User ID required" });
    }

    const roleRow = await query(
      "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin'",
      [req.user.id],
    );
    if (roleRow.rows.length === 0) {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }

    const update = await query(
      `UPDATE public.profiles
       SET
         is_premium = true,
         subscription_expiry = CASE
           WHEN subscription_expiry IS NOT NULL AND subscription_expiry > now()
             THEN subscription_expiry + INTERVAL '30 days'
           ELSE now() + INTERVAL '30 days'
         END
       WHERE user_id = $1
       RETURNING user_id, is_premium, subscription_expiry`,
      [userId]
    );

    if (update.rows.length === 0) {
      return res.status(404).json({ error: "User profile not found" });
    }

    return res.json({ success: true, profile: update.rows[0] });
  } catch (err) {
    console.error("Gift premium error:", err);
    return res.status(500).json({ error: "Failed to gift premium" });
  }
});
// POST /admin/ensure-admin - grant admin to founder email (requires auth). Uses direct query to bypass RLS for initial grant.
router.post("/admin/ensure-admin", requireAuth, async (req, res) => {
  try {
    const email = (req.user?.email || "").toLowerCase();
    if (email !== FOUNDER_EMAIL) {
      return res.json({ ok: true, isAdmin: false });
    }
    await query(
      `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [req.user.id],
    );
    return res.json({ ok: true, isAdmin: true });
  } catch (err) {
    console.error("Ensure admin error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to assign role" });
  }
});

export default router;
