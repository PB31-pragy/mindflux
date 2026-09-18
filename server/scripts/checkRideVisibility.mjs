import 'dotenv/config';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

try {
  const counts = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE ride_date >= CURRENT_DATE)::int AS upcoming,
      count(*) FILTER (WHERE ride_date >= CURRENT_DATE AND coalesce(status, 'active') = 'active')::int AS active_upcoming
    FROM public.rides
  `);

  const latest = await pool.query(`
    SELECT id, user_id, from_location, to_location, ride_date, ride_time, seats_available, transport_mode, status, created_at
      FROM public.rides
     ORDER BY created_at DESC
     LIMIT 5
  `);

  const currentDate = await pool.query('SELECT CURRENT_DATE::text AS today');
  const newestRide = latest.rows[0];
  const apiChecks = [];
  let profileSummary = null;
  let notificationConstraintCheck = null;

  if (newestRide) {
    const user = await pool.query('SELECT id, email FROM public.auth_users WHERE id = $1', [newestRide.user_id]);
    const authUser = user.rows[0];

    if (authUser) {
      const profile = await pool.query(
        'SELECT free_connections_left, is_premium, subscription_expiry FROM public.profiles WHERE user_id = $1',
        [authUser.id]
      );
      profileSummary = profile.rows[0] || null;

      const token = jwt.sign(
        { sub: authUser.id, email: authUser.email },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '10m' }
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO public.notifications (user_id, title, message, type, ride_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [authUser.id, 'Constraint smoke', 'Rollback-only validation', 'new_request', newestRide.id]
        );
        notificationConstraintCheck = { ok: true, type: 'new_request' };
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK');
        notificationConstraintCheck = { ok: false, type: 'new_request', error: error.message };
      } finally {
        client.release();
      }

      const authHeaders = { Authorization: `Bearer ${token}` };
      const baseUrl = process.env.VITE_API_URL || 'http://127.0.0.1:3000';
      const ridesUrl = `${baseUrl.replace(/\/$/, '')}/data/rides?ride_date_gte=${currentDate.rows[0].today}`;
      const ridesResponse = await fetch(ridesUrl, { headers: authHeaders });
      const ridesText = await ridesResponse.text();
      const rides = ridesResponse.ok ? JSON.parse(ridesText) : [];
      apiChecks.push({ path: '/data/rides', ok: ridesResponse.ok, status: ridesResponse.status, count: Array.isArray(rides) ? rides.length : null, body: ridesResponse.ok ? undefined : ridesText });

      if (Array.isArray(rides) && rides.length > 0) {
        const userIds = [...new Set(rides.map((ride) => ride.user_id))].join(',');
        const profilesResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/data/profiles?ids=${encodeURIComponent(userIds)}`, { headers: authHeaders });
        const profilesText = await profilesResponse.text();
        apiChecks.push({ path: '/data/profiles', ok: profilesResponse.ok, status: profilesResponse.status, body: profilesResponse.ok ? undefined : profilesText });

        const requestsResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/data/ride_requests?requester_id=${authUser.id}`, { headers: authHeaders });
        const requestsText = await requestsResponse.text();
        apiChecks.push({ path: '/data/ride_requests', ok: requestsResponse.ok, status: requestsResponse.status, body: requestsResponse.ok ? undefined : requestsText });

        const connectionsResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/data/connections`, { headers: authHeaders });
        const connectionsText = await connectionsResponse.text();
        const connections = connectionsResponse.ok ? JSON.parse(connectionsText) : [];
        apiChecks.push({
          path: '/data/connections',
          ok: connectionsResponse.ok,
          status: connectionsResponse.status,
          count: Array.isArray(connections) ? connections.length : null,
          body: connectionsResponse.ok ? undefined : connectionsText,
        });

        const joinRpcResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/rpc/create_and_pay_join_request`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _requester_id: authUser.id,
            _ride_id: newestRide.id,
            _payment_source: 'free_connection',
            _requester_show_profile_photo: true,
            _requester_show_mobile_number: false,
            _razorpay_payment_id: null,
          }),
        });
        const joinRpcText = await joinRpcResponse.text();
        apiChecks.push({
          path: '/rpc/create_and_pay_join_request',
          ok: joinRpcResponse.ok,
          status: joinRpcResponse.status,
          body: joinRpcText,
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        counts: counts.rows[0],
        currentDate: currentDate.rows[0].today,
        latest: latest.rows,
        profileSummary,
        notificationConstraintCheck,
        apiChecks,
      },
      null,
      2
    )
  );
} finally {
  await pool.end();
}
