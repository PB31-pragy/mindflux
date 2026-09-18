import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

try {
  await pool.query(`
    ALTER TABLE public.rides
      ADD COLUMN IF NOT EXISTS start_time time,
      ADD COLUMN IF NOT EXISTS end_time time,
      ADD COLUMN IF NOT EXISTS from_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS to_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  `);
  await pool.query(`
    UPDATE public.rides
    SET
      start_time = COALESCE(start_time, make_time(EXTRACT(HOUR FROM ride_time)::int, 0, 0)),
      end_time = COALESCE(end_time, make_time((EXTRACT(HOUR FROM ride_time)::int + 1) % 24, 0, 0)),
      ride_time = COALESCE(start_time, make_time(EXTRACT(HOUR FROM ride_time)::int, 0, 0))
    WHERE ride_time IS NOT NULL
  `);
  await pool.query(`
    ALTER TABLE public.rides
      ALTER COLUMN start_time SET NOT NULL,
      ALTER COLUMN end_time SET NOT NULL
  `);
  await pool.query(`
    UPDATE public.rides
    SET seats_available = GREATEST(COALESCE(seats_available, 0), 0)
    WHERE seats_available IS NULL OR seats_available < 0
  `);
  await pool.query('ALTER TABLE public.rides DROP CONSTRAINT IF EXISTS rides_seats_available_check');
  await pool.query(`
    ALTER TABLE public.rides
    ADD CONSTRAINT rides_seats_available_check
    CHECK (seats_available >= 0)
  `);
  await pool.query(`
    UPDATE public.rides
    SET status = CASE
      WHEN COALESCE(seats_available, 0) <= 0 THEN 'full'
      ELSE 'active'
    END
    WHERE status IS NULL
       OR (COALESCE(seats_available, 0) <= 0 AND status <> 'full')
       OR (COALESCE(seats_available, 0) > 0 AND status = 'full')
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_rides_from_location_id ON public.rides(from_location_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_rides_to_location_id ON public.rides(to_location_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_rides_status ON public.rides(status)');

  await pool.query(`
    ALTER TABLE public.profiles
      ADD COLUMN IF NOT EXISTS phone_number text,
      ADD COLUMN IF NOT EXISTS avatar_url text,
      ADD COLUMN IF NOT EXISTS university_id_url text,
      ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_blocked boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS verification_submitted_at timestamp with time zone,
      ADD COLUMN IF NOT EXISTS total_connections integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS spin_used boolean DEFAULT null,
      ADD COLUMN IF NOT EXISTS rewards_enabled boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS is_premium boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS subscription_expiry timestamp with time zone,
      ADD COLUMN IF NOT EXISTS free_connections_left integer NOT NULL DEFAULT 5
  `);

  // Ensure every user starts with 5 free connections.
  await pool.query('ALTER TABLE public.profiles ALTER COLUMN free_connections_left SET DEFAULT 5');
  await pool.query('UPDATE public.profiles SET free_connections_left = 5 WHERE free_connections_left = 0');

  await pool.query(`
    ALTER TABLE public.ride_requests
      ADD COLUMN IF NOT EXISTS show_profile_photo boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS show_mobile_number boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS requester_show_profile_photo boolean DEFAULT true,
      ADD COLUMN IF NOT EXISTS requester_show_mobile_number boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS request_payment_status text DEFAULT NULL CHECK (request_payment_status IN ('paid', 'refunded', 'expired')),
      ADD COLUMN IF NOT EXISTS request_payment_id uuid,
      ADD COLUMN IF NOT EXISTS accept_payment_status text DEFAULT NULL CHECK (accept_payment_status IN ('paid')),
      ADD COLUMN IF NOT EXISTS accept_payment_id uuid
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.chat_messages (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      connection_id uuid NOT NULL REFERENCES public.connections(id) ON DELETE CASCADE,
      sender_id uuid NOT NULL,
      message text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      read boolean NOT NULL DEFAULT false
    )
  `);
  await pool.query(`
    ALTER TABLE public.chat_messages
      ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'text',
      ADD COLUMN IF NOT EXISTS media_url text,
      ADD COLUMN IF NOT EXISTS media_mime_type text,
      ADD COLUMN IF NOT EXISTS file_name text,
      ADD COLUMN IF NOT EXISTS file_size integer,
      ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS delivered_at timestamp with time zone NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS read_at timestamp with time zone,
      ADD COLUMN IF NOT EXISTS deleted_for_everyone boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS voice_duration_seconds integer,
      ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_connection ON public.chat_messages(connection_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON public.chat_messages(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_reply_to_id ON public.chat_messages(reply_to_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.chat_blocks (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      blocker_id uuid NOT NULL,
      blocked_id uuid NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT chat_blocks_unique_pair UNIQUE (blocker_id, blocked_id),
      CONSTRAINT chat_blocks_no_self CHECK (blocker_id <> blocked_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocker ON public.chat_blocks(blocker_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocked ON public.chat_blocks(blocked_id)`);

  await pool.query(`
    ALTER TABLE public.notifications
      ADD COLUMN IF NOT EXISTS ride_request_id uuid
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_notifications_ride_request_id ON public.notifications(ride_request_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.group_chats (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
      chat_name text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      expires_at timestamp with time zone NOT NULL,
      status text NOT NULL DEFAULT 'active'
    )
  `);
  await pool.query(`ALTER TABLE public.group_chats ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_group_chats_ride_id_unique ON public.group_chats(ride_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chats_expires_at ON public.group_chats(expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chats_status ON public.group_chats(status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.group_chat_members (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      group_chat_id uuid NOT NULL REFERENCES public.group_chats(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      joined_at timestamp with time zone NOT NULL DEFAULT now(),
      role text NOT NULL DEFAULT 'member'
    )
  `);
  await pool.query(`ALTER TABLE public.group_chat_members ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_group_chat_members_unique ON public.group_chat_members(group_chat_id, user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chat_members_group ON public.group_chat_members(group_chat_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chat_members_user ON public.group_chat_members(user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.group_chat_messages (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      group_chat_id uuid NOT NULL REFERENCES public.group_chats(id) ON DELETE CASCADE,
      sender_id uuid,
      message text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE public.group_chat_messages ALTER COLUMN sender_id DROP NOT NULL`);
  await pool.query(`
    ALTER TABLE public.group_chat_messages
      ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'text',
      ADD COLUMN IF NOT EXISTS media_url text,
      ADD COLUMN IF NOT EXISTS media_mime_type text,
      ADD COLUMN IF NOT EXISTS file_name text,
      ADD COLUMN IF NOT EXISTS file_size integer,
      ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES public.group_chat_messages(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS deleted_for_everyone boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS voice_duration_seconds integer,
      ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS system_event text
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chat_messages_group ON public.group_chat_messages(group_chat_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chat_messages_created_at ON public.group_chat_messages(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chat_messages_reply_to_id ON public.group_chat_messages(reply_to_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.group_chat_reads (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      group_chat_id uuid NOT NULL REFERENCES public.group_chats(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      last_read_at timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT unique_group_chat_read UNIQUE (group_chat_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chat_reads_user ON public.group_chat_reads(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_chat_reads_group ON public.group_chat_reads(group_chat_id)`);

  // Keep notification types aligned with every type the app/backend currently uses.
  await pool.query(`
    UPDATE public.notifications
    SET type = CASE
      WHEN type IN (
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
        'wallet_refunded'
      ) THEN type
      WHEN type IS NULL OR btrim(type) = '' THEN 'info'
      ELSE 'info'
    END
  `);
  await pool.query('ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check');
  await pool.query('ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_valid');
  await pool.query(`
    ALTER TABLE public.notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (
      type = ANY (
        ARRAY[
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
          'wallet_refunded'
        ]
      )
    )
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION public.notify_free_connections_exhausted(_user_id uuid)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
    BEGIN
      INSERT INTO public.notifications (user_id, title, message, type)
      VALUES (
        _user_id,
        'Free rides finished',
        'Your 5 free ride connections are used. Now pay Rs 21 per connection or upgrade to Premium.',
        'info'
      );
    END;
    $function$;
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS public.get_user_group_chats(uuid);
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION public.get_user_group_chats(_user_id uuid)
    RETURNS TABLE(
      id uuid,
      ride_id uuid,
      chat_name text,
      created_at timestamp with time zone,
      expires_at timestamp with time zone,
      is_expired boolean,
      member_count bigint
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
      SELECT
        gc.id,
        gc.ride_id,
        gc.chat_name,
        gc.created_at,
        gc.expires_at,
        gc.expires_at <= now() AS is_expired,
        (
          SELECT COUNT(*)
          FROM public.group_chat_members gcm_count
          WHERE gcm_count.group_chat_id = gc.id
        ) AS member_count
      FROM public.group_chats gc
      WHERE EXISTS (
        SELECT 1
        FROM public.group_chat_members gcm
        WHERE gcm.group_chat_id = gc.id
          AND gcm.user_id = _user_id
      )
        AND current_setting('app.current_user_id', true)::uuid = _user_id
      ORDER BY gc.created_at DESC
    $function$;
  `);

  await pool.query(`
    DROP FUNCTION IF EXISTS public.get_group_chat_members(uuid);
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION public.get_group_chat_members(_group_chat_id uuid)
    RETURNS TABLE(
      user_id uuid,
      full_name text,
      avatar_url text,
      is_verified boolean,
      joined_at timestamp with time zone,
      role text
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
      SELECT
        gcm.user_id,
        p.full_name,
        p.avatar_url,
        p.is_verified,
        gcm.joined_at,
        gcm.role
      FROM public.group_chat_members gcm
      JOIN public.profiles p
        ON p.user_id = gcm.user_id
      WHERE gcm.group_chat_id = _group_chat_id
        AND EXISTS (
          SELECT 1
          FROM public.group_chat_members self_member
          WHERE self_member.group_chat_id = _group_chat_id
            AND self_member.user_id = current_setting('app.current_user_id', true)::uuid
        )
      ORDER BY gcm.joined_at ASC
    $function$;
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION public.create_and_pay_join_request(
      _requester_id uuid,
      _ride_id uuid,
      _payment_source text,
      _requester_show_profile_photo boolean DEFAULT true,
      _requester_show_mobile_number boolean DEFAULT false,
      _razorpay_payment_id text DEFAULT NULL
    )
    RETURNS TABLE(success boolean, error_message text, request_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
    DECLARE
      v_new_request_id uuid;
      v_transaction_id uuid;
      v_ride_owner_id uuid;
      v_is_premium boolean;
      v_is_admin boolean;
      v_free_left integer;
      v_requester_name text;
      v_from_location text;
      v_to_location text;
      v_ride_seats_available integer;
      v_ride_status text;
    BEGIN
      IF NOT public.is_user_verified(_requester_id) THEN
        RETURN QUERY SELECT false, 'Account not verified'::text, NULL::uuid;
        RETURN;
      END IF;

      IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _requester_id AND is_blocked = true) THEN
        RETURN QUERY SELECT false, 'Account is blocked'::text, NULL::uuid;
        RETURN;
      END IF;

      SELECT user_id, from_location, to_location, seats_available, status
        INTO v_ride_owner_id, v_from_location, v_to_location, v_ride_seats_available, v_ride_status
      FROM public.rides
      WHERE id = _ride_id;

      IF v_ride_owner_id IS NULL THEN
        RETURN QUERY SELECT false, 'Ride not found'::text, NULL::uuid;
        RETURN;
      END IF;

      IF v_ride_owner_id = _requester_id THEN
        RETURN QUERY SELECT false, 'Cannot request your own ride'::text, NULL::uuid;
        RETURN;
      END IF;

      IF COALESCE(v_ride_seats_available, 0) <= 0 OR COALESCE(v_ride_status, 'active') = 'full' THEN
        RETURN QUERY SELECT false, 'Ride is already full'::text, NULL::uuid;
        RETURN;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.ride_requests
        WHERE ride_id = _ride_id
          AND requester_id = _requester_id
          AND request_payment_status = 'paid'
          AND status IN ('pending', 'approved')
      ) THEN
        RETURN QUERY SELECT false, 'You already have a pending request for this ride'::text, NULL::uuid;
        RETURN;
      END IF;

      DELETE FROM public.ride_requests
      WHERE ride_id = _ride_id
        AND requester_id = _requester_id
        AND (request_payment_status IS NULL OR request_payment_status != 'paid');

      SELECT public.has_role(_requester_id, 'admin'::public.app_role) INTO v_is_admin;
      SELECT (is_premium = true AND subscription_expiry > now()), free_connections_left
        INTO v_is_premium, v_free_left
      FROM public.profiles
      WHERE user_id = _requester_id;

      IF NOT COALESCE(v_is_admin, false) AND NOT COALESCE(v_is_premium, false) AND COALESCE(v_free_left, 0) <= 0 THEN
        IF _payment_source != 'razorpay' OR _razorpay_payment_id IS NULL THEN
          RETURN QUERY SELECT false, 'Payment required'::text, NULL::uuid;
          RETURN;
        END IF;
      END IF;

      INSERT INTO public.ride_requests (
        ride_id,
        requester_id,
        status,
        requester_show_profile_photo,
        requester_show_mobile_number,
        request_payment_status
      )
      VALUES (
        _ride_id,
        _requester_id,
        'pending',
        _requester_show_profile_photo,
        _requester_show_mobile_number,
        'paid'
      )
      RETURNING id INTO v_new_request_id;

      IF NOT COALESCE(v_is_admin, false) AND NOT COALESCE(v_is_premium, false) THEN
        IF COALESCE(v_free_left, 0) > 0 THEN
          UPDATE public.profiles
          SET free_connections_left = free_connections_left - 1
          WHERE user_id = _requester_id;

          UPDATE public.ride_requests
          SET request_payment_id = NULL
          WHERE id = v_new_request_id;

          IF v_free_left - 1 = 0 THEN
            PERFORM public.notify_free_connections_exhausted(_requester_id);
          END IF;
        ELSE
          INSERT INTO public.wallet_transactions (
            user_id,
            amount,
            transaction_type,
            payment_source,
            razorpay_payment_id,
            related_ride_request_id,
            status,
            description
          )
          VALUES (
            _requester_id,
            -21,
            'join_request',
            _payment_source,
            _razorpay_payment_id,
            v_new_request_id,
            'completed',
            'Payment for join request'
          )
          RETURNING id INTO v_transaction_id;

          UPDATE public.ride_requests
          SET request_payment_id = v_transaction_id
          WHERE id = v_new_request_id;
        END IF;
      ELSE
        UPDATE public.ride_requests
        SET request_payment_id = NULL
        WHERE id = v_new_request_id;
      END IF;

      SELECT full_name INTO v_requester_name
      FROM public.profiles
      WHERE user_id = _requester_id;

      INSERT INTO public.notifications (user_id, title, message, type, ride_id, ride_request_id)
      VALUES (
        v_ride_owner_id,
        'New Ride Request',
        COALESCE(v_requester_name, 'Someone') || ' wants to join your ride from ' || v_from_location || ' to ' || v_to_location,
        'new_request',
        _ride_id,
        v_new_request_id
      );

      RETURN QUERY SELECT true, NULL::text, v_new_request_id;
    END;
    $function$;
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION public.pay_accept_request(
      _user_id uuid,
      _ride_request_id uuid,
      _payment_source text,
      _razorpay_payment_id text DEFAULT NULL
    )
    RETURNS TABLE(success boolean, error_message text)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
    DECLARE
      v_transaction_id uuid;
      v_ride_owner_id uuid;
      v_ride_id uuid;
      v_requester_id uuid;
      v_is_premium boolean;
      v_is_admin boolean;
      v_free_left integer;
      v_seats_available integer;
      v_ride_start_datetime timestamp with time zone;
      v_ride_end_datetime timestamp with time zone;
      v_connection_id uuid;
      v_group_chat_id uuid;
      v_from_location text;
      v_to_location text;
      v_chat_name text;
      v_notification_message text := 'Your ride has been confirmed! You can now chat with your travel partner for the next 24 hours.';
      v_requester_name text;
    BEGIN
      SELECT
        r.user_id,
        rr.ride_id,
        rr.requester_id,
        r.seats_available,
        r.from_location,
        r.to_location,
        (r.ride_date || ' ' || COALESCE(r.start_time, r.ride_time))::timestamp with time zone,
        (
          r.ride_date::timestamp
          + COALESCE(r.end_time, (COALESCE(r.start_time, r.ride_time) + interval '1 hour')::time)
        )::timestamp with time zone
        INTO
          v_ride_owner_id,
          v_ride_id,
          v_requester_id,
          v_seats_available,
          v_from_location,
          v_to_location,
          v_ride_start_datetime,
          v_ride_end_datetime
      FROM public.ride_requests rr
      JOIN public.rides r ON r.id = rr.ride_id
      WHERE rr.id = _ride_request_id;

      IF v_ride_owner_id IS NULL OR v_ride_owner_id != _user_id THEN
        RETURN QUERY SELECT false, 'You are not the ride owner'::text;
        RETURN;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM public.ride_requests
        WHERE id = _ride_request_id
          AND request_payment_status = 'paid'
      ) THEN
        RETURN QUERY SELECT false, 'Requester has not paid yet'::text;
        RETURN;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.ride_requests
        WHERE id = _ride_request_id
          AND accept_payment_status = 'paid'
      ) THEN
        RETURN QUERY SELECT false, 'Already accepted and paid'::text;
        RETURN;
      END IF;

      IF COALESCE(v_seats_available, 0) <= 0 THEN
        RETURN QUERY SELECT false, 'Ride is already full'::text;
        RETURN;
      END IF;

      SELECT public.has_role(_user_id, 'admin'::public.app_role) INTO v_is_admin;
      SELECT (is_premium = true AND subscription_expiry > now()), free_connections_left
        INTO v_is_premium, v_free_left
      FROM public.profiles
      WHERE user_id = _user_id;

      IF COALESCE(v_is_admin, false) OR COALESCE(v_is_premium, false) THEN
        UPDATE public.ride_requests
        SET accept_payment_status = 'paid', status = 'approved'
        WHERE id = _ride_request_id;
      ELSIF COALESCE(v_free_left, 0) > 0 THEN
        UPDATE public.profiles
        SET free_connections_left = free_connections_left - 1
        WHERE user_id = _user_id;

        UPDATE public.ride_requests
        SET accept_payment_status = 'paid', status = 'approved'
        WHERE id = _ride_request_id;

        IF v_free_left - 1 = 0 THEN
          PERFORM public.notify_free_connections_exhausted(_user_id);
        END IF;
      ELSE
        IF _payment_source != 'razorpay' OR _razorpay_payment_id IS NULL THEN
          RETURN QUERY SELECT false, 'Payment required'::text;
          RETURN;
        END IF;

        INSERT INTO public.wallet_transactions (
          user_id,
          amount,
          transaction_type,
          payment_source,
          razorpay_payment_id,
          related_ride_request_id,
          status,
          description
        )
        VALUES (
          _user_id,
          -21,
          'accept_request',
          _payment_source,
          _razorpay_payment_id,
          _ride_request_id,
          'completed',
          'Payment for accepting request'
        )
        RETURNING id INTO v_transaction_id;

        UPDATE public.ride_requests
        SET accept_payment_status = 'paid', accept_payment_id = v_transaction_id, status = 'approved'
        WHERE id = _ride_request_id;
      END IF;

      UPDATE public.rides
      SET
        seats_available = GREATEST(COALESCE(seats_available, 0) - 1, 0),
        status = CASE
          WHEN GREATEST(COALESCE(seats_available, 0) - 1, 0) <= 0 THEN 'full'
          ELSE 'active'
        END
      WHERE id = v_ride_id;

      IF COALESCE(v_seats_available, 1) > 1
         AND to_regclass('public.group_chats') IS NOT NULL
         AND to_regclass('public.group_chat_members') IS NOT NULL THEN
        v_chat_name := 'From ' || COALESCE(v_from_location, 'Unknown') || ' to ' || COALESCE(v_to_location, 'Unknown');
        SELECT full_name INTO v_requester_name
        FROM public.profiles
        WHERE user_id = v_requester_id;

        INSERT INTO public.group_chats (ride_id, chat_name, expires_at)
        VALUES (v_ride_id, v_chat_name, COALESCE(v_ride_end_datetime, now() + interval '24 hours'))
        ON CONFLICT (ride_id) DO UPDATE
        SET chat_name = EXCLUDED.chat_name,
            expires_at = EXCLUDED.expires_at,
            status = 'active'
        RETURNING id INTO v_group_chat_id;

        INSERT INTO public.group_chat_members (group_chat_id, user_id, role)
        VALUES
          (v_group_chat_id, v_ride_owner_id, 'admin'),
          (v_group_chat_id, v_requester_id, 'member')
        ON CONFLICT (group_chat_id, user_id) DO NOTHING;

        INSERT INTO public.group_chat_reads (group_chat_id, user_id, last_read_at)
        VALUES
          (v_group_chat_id, v_ride_owner_id, now()),
          (v_group_chat_id, v_requester_id, now())
        ON CONFLICT (group_chat_id, user_id) DO NOTHING;

        INSERT INTO public.group_chat_messages (
          group_chat_id,
          sender_id,
          message,
          message_type,
          system_event,
          metadata
        )
        SELECT
          v_group_chat_id,
          NULL,
          COALESCE(v_requester_name, 'A rider') || ' joined the group',
          'system',
          'member_joined',
          jsonb_build_object('joined_user_id', v_requester_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.group_chat_messages existing
          WHERE existing.group_chat_id = v_group_chat_id
            AND existing.system_event = 'member_joined'
            AND COALESCE(existing.metadata ->> 'joined_user_id', '') = v_requester_id::text
        );
      END IF;

      INSERT INTO public.connections (user1_id, user2_id, ride_id, ride_request_id, expires_at, status)
      VALUES (
        v_ride_owner_id,
        v_requester_id,
        v_ride_id,
        _ride_request_id,
        COALESCE(v_ride_end_datetime, now() + interval '24 hours'),
        'active'
      )
      ON CONFLICT (ride_request_id) DO UPDATE
      SET user1_id = EXCLUDED.user1_id,
          user2_id = EXCLUDED.user2_id,
          ride_id = EXCLUDED.ride_id,
          expires_at = EXCLUDED.expires_at,
          status = 'active'
      RETURNING id INTO v_connection_id;

      INSERT INTO public.notifications (user_id, title, message, type, ride_id, ride_request_id)
      SELECT n.user_id, n.title, n.message, n.type, n.ride_id, n.ride_request_id
      FROM (
        VALUES
          (
            v_ride_owner_id,
            'Ride Confirmed!',
            v_notification_message,
            'success',
            v_ride_id,
            _ride_request_id
          ),
          (
            v_requester_id,
            'Ride Confirmed!',
            v_notification_message,
            'success',
            v_ride_id,
            _ride_request_id
          )
      ) AS n(user_id, title, message, type, ride_id, ride_request_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.notifications existing
        WHERE existing.user_id = n.user_id
          AND existing.ride_id = n.ride_id
          AND COALESCE(existing.ride_request_id, '00000000-0000-0000-0000-000000000000'::uuid) =
              COALESCE(n.ride_request_id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND existing.type = n.type
          AND existing.title = n.title
          AND existing.created_at > now() - interval '10 minutes'
      );

      RETURN QUERY SELECT true, NULL::text;
    END;
    $function$;
  `);

  const result = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'rides'
       AND column_name IN ('from_location_id', 'to_location_id', 'status', 'transport_mode')
     ORDER BY column_name
  `);

  const profileResult = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'profiles'
       AND column_name IN ('avatar_url', 'free_connections_left', 'is_premium', 'is_verified', 'phone_number', 'subscription_expiry')
     ORDER BY column_name
  `);

  const requestResult = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'ride_requests'
       AND column_name IN (
         'show_profile_photo',
         'show_mobile_number',
         'requester_show_profile_photo',
         'requester_show_mobile_number',
         'request_payment_status',
         'request_payment_id',
         'accept_payment_status',
         'accept_payment_id'
       )
     ORDER BY column_name
  `);

  const groupChatTablesResult = await pool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('group_chats', 'group_chat_members', 'group_chat_messages')
     ORDER BY table_name
  `);

  const chatBlocksResult = await pool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'chat_blocks'
  `);

  const notificationTypeResult = await pool.query(`
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.notifications'::regclass
       AND conname = 'notifications_type_check'
  `);

  const notificationValuesResult = await pool.query(`
    SELECT array_agg(DISTINCT type ORDER BY type) AS types
      FROM public.notifications
  `);

  console.log(`Ride columns ready: ${result.rows.map((row) => row.column_name).join(', ')}`);
  console.log(`Profile columns ready: ${profileResult.rows.map((row) => row.column_name).join(', ')}`);
  console.log(`Ride request columns ready: ${requestResult.rows.map((row) => row.column_name).join(', ')}`);
  console.log(`Group chat tables ready: ${groupChatTablesResult.rows.map((row) => row.table_name).join(', ')}`);
  console.log(`Chat blocks ready: ${chatBlocksResult.rows.length > 0 ? 'chat_blocks' : 'missing'}`);
  console.log(`Notification constraint ready: ${notificationTypeResult.rows.length > 0 ? 'notifications_type_check' : 'missing'}`);
  console.log(`Notification types present: ${(notificationValuesResult.rows[0]?.types || []).join(', ')}`);
} finally {
  await pool.end();
}
