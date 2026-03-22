const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createUser, createUserFromStrava, getUserByEmail, getUserById, getUserByStravaId, deleteUser, upsertUser } = require('../db/users');
const { upsertStravaConnection, getConnectionByStravaId, getConnectionByUserId, updateTokens } = require('../db/stravaConnections');
const { processStravaActivity } = require('../lib/stravaProcessor');
const { supabase } = require('../db/client');
const { getAllCities, getCityById } = require('../db/cities');

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/strava/callback';
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || 'zamindar-dev-secret-change-in-prod';
const JWT_EXPIRY = '30d';

// ─── JWT HELPERS ─────────────────────────────────────────────────────────────

function signToken(user) {
    return jwt.sign(
      { userId: user.id, email: user.email, displayName: user.display_name },
          JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
        );
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(userId, token, deviceInfo) {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('sessions').insert({
          user_id: userId,
          token_hash: hashToken(token),
          device_info: deviceInfo || 'unknown',
          expires_at: expiresAt,
    });
}

async function invalidateSession(tokenHash) {
    await supabase.from('sessions').delete().eq('token_hash', tokenHash);
}

async function isSessionValid(tokenHash) {
    const { data } = await supabase
      .from('sessions')
      .select('id')
      .eq('token_hash', tokenHash)
      .gt('expires_at', new Date().toISOString())
      .single();
    return !!data;
}

// ─── STRAVA TOKEN HELPERS ────────────────────────────────────────────────────

async function exchangeCodeForTokens(code) {
    const res = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
                  client_id: STRAVA_CLIENT_ID,
                  client_secret: STRAVA_CLIENT_SECRET,
                  code,
                  grant_type: 'authorization_code',
          }),
    });
    if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Strava token exchange failed (${res.status}): ${errBody}`);
    }
    return res.json();
}

async function refreshAccessToken(refreshToken) {
    const res = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
                  client_id: STRAVA_CLIENT_ID,
                  client_secret: STRAVA_CLIENT_SECRET,
                  refresh_token: refreshToken,
                  grant_type: 'refresh_token',
          }),
    });
    if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Strava token refresh failed (${res.status}): ${errBody}`);
    }
    return res.json();
}

// Get a valid Strava token — looks up strava_connections table now
async function getValidToken(user) {
    // Look up the Strava connection for this user
  const connection = await getConnectionByUserId(user.id);
    if (!connection) throw new Error(`No Strava connection for user ${user.id}`);

  const now = new Date();
    const expiresAt = new Date(connection.token_expires_at);

  if (expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
        return connection.access_token;
  }

  console.log(`Refreshing Strava token for user ${user.id}`);
    const tokenData = await refreshAccessToken(connection.refresh_token);

  await updateTokens({
        stravaId: connection.strava_id,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: new Date(tokenData.expires_at * 1000).toISOString(),
  });

  return tokenData.access_token;
}

async function fetchStravaActivity(activityId, accessToken) {
    const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Strava activity fetch failed (${res.status}): ${errBody}`);
    }
    return res.json();
}

// ─── INITIAL SYNC ────────────────────────────────────────────────────────────

async function initialStravaSync(accessToken, athleteId, userId) {
    try {
          const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
          const listRes = await fetch(
                  `https://www.strava.com/api/v3/athlete/activities?after=${thirtyDaysAgo}&per_page=20`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
                );
          if (!listRes.ok) {
                  const errBody = await listRes.text();
                  console.error(`Initial sync: failed to list activities (${listRes.status}): ${errBody}`);
                  return;
          }
          const activities = await listRes.json();
          console.log(`Initial sync for athlete ${athleteId}: fetched ${activities.length} activities from last 30 days`);

      const runs = activities
            .filter(a => a.type === 'Run' && a.map && a.map.summary_polyline)
            .slice(0, 3);

      console.log(`Initial sync: found ${runs.length} qualifying runs to process`);

      for (const run of runs.reverse()) {
              try {
                        const fullActivity = await fetchStravaActivity(run.id, accessToken);
                        const result = await processStravaActivity(fullActivity);
                        if (result) {
                                    console.log(`Initial sync: processed activity ${run.id} — ${run.name}`);
                        } else {
                                    console.log(`Initial sync: skipped activity ${run.id} (no polyline or not a run)`);
                        }
              } catch (err) {
                        console.error(`Initial sync: error processing activity ${run.id}:`, err.message);
              }
      }
          console.log(`Initial sync complete for athlete ${athleteId}`);
    } catch (err) {
          console.error('Initial sync error:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /auth/cities — Public list of cities for signup city picker ─────────
router.get('/cities', async (req, res) => {
    try {
        const cities = await getAllCities();
        res.json({ cities: (cities || []).map(c => ({ id: c.id, name: c.name, state: c.state, lat: parseFloat(c.lat), lng: parseFloat(c.lng) })) });
    } catch (err) {
        console.error('Get cities error:', err);
        res.status(500).json({ error: 'Failed to fetch cities' });
    }
});

// ─── POST /auth/signup — Email + password signup ─────────────────────────────
router.post('/signup', async (req, res) => {
    try {
          const { email, password, displayName, homeCityId } = req.body;

      if (!email || !password) {
              return res.status(400).json({ error: 'Email and password are required' });
      }
          if (password.length < 8) {
                  return res.status(400).json({ error: 'Password must be at least 8 characters' });
          }

      const existing = await getUserByEmail(email);
          if (existing) {
                  return res.status(409).json({ error: 'Email already registered' });
          }

      const passwordHash = await bcrypt.hash(password, 12);
          const user = await createUser({ email, passwordHash, displayName, homeCityId });

      const token = signToken(user);
          await createSession(user.id, token, req.headers['user-agent']);

      console.log(`New user signed up: ${email}`);
          res.json({
                  user: { id: user.id, email: user.email, displayName: user.display_name, avatarUrl: user.avatar_url },
                  token,
          });
    } catch (err) {
          console.error('Signup error:', err);
          if (err.code === '23505') {
                  return res.status(409).json({ error: 'Email already registered' });
          }
          res.status(500).json({ error: 'Signup failed' });
    }
});

// ─── POST /auth/login — Email + password login ──────────────────────────────
router.post('/login', async (req, res) => {
    try {
          const { email, password } = req.body;

      if (!email || !password) {
              return res.status(400).json({ error: 'Email and password are required' });
      }

      const user = await getUserByEmail(email);
          if (!user || !user.password_hash) {
                  return res.status(401).json({ error: 'Invalid email or password' });
          }

      const valid = await bcrypt.compare(password, user.password_hash);
          if (!valid) {
                  return res.status(401).json({ error: 'Invalid email or password' });
          }

      const token = signToken(user);
          await createSession(user.id, token, req.headers['user-agent']);

      // Check if user has Strava connected
      const stravaConnection = await getConnectionByUserId(user.id);

      console.log(`User logged in: ${email}`);
          res.json({
                  user: {
                            id: user.id,
                            email: user.email,
                            displayName: user.display_name,
                            avatarUrl: user.avatar_url,
                            stravaConnected: !!stravaConnection,
                  },
                  token,
          });
    } catch (err) {
          console.error('Login error:', err);
          res.status(500).json({ error: 'Login failed' });
    }
});

// ─── POST /auth/logout — Invalidate current session ─────────────────────────
router.post('/logout', async (req, res) => {
    try {
          const authHeader = req.headers.authorization;
          if (authHeader && authHeader.startsWith('Bearer ')) {
                  const token = authHeader.replace('Bearer ', '');
                  await invalidateSession(hashToken(token));
          }
          res.json({ success: true });
    } catch (err) {
          console.error('Logout error:', err);
          res.json({ success: true }); // always succeed for UX
    }
});

// ─── GET /auth/me — Get current user profile ────────────────────────────────
router.get('/me', async (req, res) => {
    try {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
                  return res.status(401).json({ error: 'Not authenticated' });
          }

      const token = authHeader.replace('Bearer ', '');
          const tokenH = hashToken(token);

      const valid = await isSessionValid(tokenH);
          if (!valid) {
                  return res.status(401).json({ error: 'Session expired or invalid' });
          }

      let decoded;
          try {
                  decoded = jwt.verify(token, JWT_SECRET);
          } catch (e) {
                  return res.status(401).json({ error: 'Invalid token' });
          }

      const user = await getUserById(decoded.userId);
          if (!user) {
                  return res.status(404).json({ error: 'User not found' });
          }

      const stravaConnection = await getConnectionByUserId(user.id);

      // Fetch home city details if set
      let homeCity = null;
      if (user.home_city_id) {
              try {
                      const city = await getCityById(user.home_city_id);
                      homeCity = { id: city.id, name: city.name, lat: parseFloat(city.lat), lng: parseFloat(city.lng) };
              } catch (e) { /* city may have been deleted */ }
      }

      res.json({
              user: {
                        id: user.id,
                        email: user.email,
                        displayName: user.display_name,
                        avatarUrl: user.avatar_url,
                        stravaConnected: !!stravaConnection,
                        stravaId: stravaConnection?.strava_id || null,
                        zonesOwned: user.zones_owned,
                        totalDistanceKm: user.total_distance_km,
                        totalAreaM2: user.total_area_m2,
                        createdAt: user.created_at,
                        homeCity,
              },
      });
    } catch (err) {
          console.error('Auth /me error:', err);
          res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// ─── DELETE /auth/account — Delete user and all their data ───────────────────
router.delete('/account', async (req, res) => {
    try {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
                  return res.status(401).json({ error: 'Not authenticated' });
          }

      const token = authHeader.replace('Bearer ', '');
          let decoded;
          try {
                  decoded = jwt.verify(token, JWT_SECRET);
          } catch (e) {
                  return res.status(401).json({ error: 'Invalid token' });
          }

      const userId = decoded.userId;
          console.log(`Deleting account for user ${userId}`);

      // Revoke Strava access if connected
      try {
              const connection = await getConnectionByUserId(userId);
              if (connection && connection.access_token) {
                        await fetch('https://www.strava.com/oauth/deauthorize', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                    body: `access_token=${connection.access_token}`,
                        });
                        console.log(`Strava access revoked for user ${userId}`);
              }
      } catch (err) {
              console.warn('Strava deauthorize failed (non-fatal):', err.message);
      }

      await deleteUser(userId);
          console.log(`Account deleted: ${userId}`);

      res.json({ success: true, message: 'Account and all data deleted' });
    } catch (err) {
          console.error('Account deletion error:', err);
          res.status(500).json({ error: 'Failed to delete account' });
    }
});

// ─── GET /auth/strava — Redirect to Strava OAuth ────────────────────────────
// If ?link_token=JWT is provided, we'll link Strava to that existing user.
// Otherwise, Strava OAuth creates a new user (or logs into existing one).
router.get('/strava', (req, res) => {
    const scope = 'activity:read_all';
    // Pass link_token as OAuth state so we get it back in the callback
             const state = req.query.link_token || '';
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&approval_prompt=auto&state=${encodeURIComponent(state)}`;
    res.redirect(authUrl);
});

// ─── GET /auth/strava/callback — Handle OAuth callback ──────────────────────
router.get('/strava/callback', async (req, res) => {
    try {
          const { code, error: oauthError, state } = req.query;

      if (oauthError) return res.redirect('/?auth=denied');
          if (!code) return res.redirect('/?auth=error&reason=no_code');

      const tokenData = await exchangeCodeForTokens(code);
          const { athlete, access_token, refresh_token, expires_at } = tokenData;
          const expiresAtISO = new Date(expires_at * 1000).toISOString();
          const athleteName = `${athlete.firstname} ${athlete.lastname}`.trim() || athlete.username;

      let user;
          let isNewUser = false;

      // ── Case 1: Linking Strava to an existing logged-in user ─────────────
      if (state) {
              try {
                        const decoded = jwt.verify(state, JWT_SECRET);
                        user = await getUserById(decoded.userId);
                        if (user) {
                                    console.log(`Linking Strava athlete ${athlete.id} to existing user ${user.id}`);
                                    // Update user profile with Strava info if missing
                          if (!user.display_name || user.display_name === user.email?.split('@')[0]) {
                                        await supabase.from('users').update({
                                                        display_name: athleteName,
                                                        avatar_url: athlete.profile_medium || athlete.profile,
                                                        strava_id: athlete.id,
                                        }).eq('id', user.id);
                          }
                        }
              } catch (e) {
                        console.warn('Link token invalid, treating as new auth:', e.message);
              }
      }

      // ── Case 2: Returning Strava user — find by strava_id ────────────────
      if (!user) {
              const existingConnection = await getConnectionByStravaId(athlete.id);
              if (existingConnection) {
                        user = await getUserById(existingConnection.user_id);
                        console.log(`Returning Strava user: ${athleteName} (${athlete.id})`);
              }
      }

      // ── Case 3: Also check legacy strava_id on users table ───────────────
      if (!user) {
              user = await getUserByStravaId(athlete.id);
              if (user) {
                        console.log(`Found legacy Strava user: ${athleteName} (${athlete.id})`);
              }
      }

      // ── Case 4: Brand new user from Strava ───────────────────────────────
      if (!user) {
              user = await createUserFromStrava({
                        stravaId: athlete.id,
                        displayName: athleteName,
                        avatarUrl: athlete.profile_medium || athlete.profile,
              });
              isNewUser = true;
              console.log(`New user created from Strava: ${athleteName} (${athlete.id})`);
      }

      // ── Save/update Strava connection ────────────────────────────────────
      await upsertStravaConnection({
              userId: user.id,
              stravaId: athlete.id,
              accessToken: access_token,
              refreshToken: refresh_token,
              expiresAt: expiresAtISO,
      });

      // Also keep legacy users table in sync for backward compat
      try {
              await supabase.from('users').update({
                        strava_id: athlete.id,
                        access_token: access_token,
                        refresh_token: refresh_token,
                        token_expires_at: expiresAtISO,
                        display_name: athleteName,
                        avatar_url: athlete.profile_medium || athlete.profile,
              }).eq('id', user.id);
      } catch (e) {
              console.warn('Legacy user sync failed (non-fatal):', e.message);
      }

      console.log(`User authenticated: ${athleteName} (Strava ID: ${athlete.id})`);

      // Issue JWT
      const token = signToken(user);
          await createSession(user.id, token, 'strava-oauth');

      // Sync recent runs in the background
      initialStravaSync(access_token, athlete.id, user.id).catch(err => {
              console.error('Background initial sync failed:', err);
      });

      // Redirect to app with token
      res.redirect(`/zamindar.html?token=${encodeURIComponent(token)}&user=${user.id}&name=${encodeURIComponent(user.display_name)}`);
    } catch (err) {
          console.error('Auth callback error:', err);
          res.redirect('/?auth=error&reason=token_exchange');
    }
});

// ─── DELETE /auth/strava — Disconnect Strava (keep user account) ─────────────
router.delete('/strava', async (req, res) => {
    try {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
                  return res.status(401).json({ error: 'Not authenticated' });
          }

      const token = authHeader.replace('Bearer ', '');
          let decoded;
          try {
                  decoded = jwt.verify(token, JWT_SECRET);
          } catch (e) {
                  return res.status(401).json({ error: 'Invalid token' });
          }

      const connection = await getConnectionByUserId(decoded.userId);
          if (!connection) {
                  return res.status(404).json({ error: 'No Strava connection found' });
          }

      // Revoke on Strava side
      try {
              await fetch('https://www.strava.com/oauth/deauthorize', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `access_token=${connection.access_token}`,
              });
      } catch (e) {
              console.warn('Strava deauthorize call failed:', e.message);
      }

      // Remove from our DB
      const { deleteConnectionByUserId } = require('../db/stravaConnections');
          await deleteConnectionByUserId(decoded.userId);

      res.json({ success: true, message: 'Strava disconnected' });
    } catch (err) {
          console.error('Strava disconnect error:', err);
          res.status(500).json({ error: 'Failed to disconnect Strava' });
    }
});

// ─── GET /auth/status — Backward compatible status check ─────────────────────
router.get('/status', async (req, res) => {
    try {
          const userId = req.query.user;
          if (!userId) return res.json({ authenticated: false });

      const user = await getUserById(userId);
          if (!user) return res.json({ authenticated: false });

      const stravaConnection = await getConnectionByUserId(user.id);
          const tokenValid = stravaConnection
            ? new Date(stravaConnection.token_expires_at) > new Date()
                  : false;

      res.json({
              authenticated: true,
              user: {
                        id: user.id,
                        displayName: user.display_name,
                        avatarUrl: user.avatar_url,
                        stravaId: stravaConnection?.strava_id,
                        stravaConnected: !!stravaConnection,
                        zonesOwned: user.zones_owned,
                        totalDistanceKm: user.total_distance_km,
              },
              tokenValid,
      });
    } catch (err) {
          console.error('Auth status error:', err);
          res.json({ authenticated: false });
    }
});

// ─── POST /auth/strava/subscribe — Register Strava webhook ──────────────────
router.post('/strava/subscribe', async (req, res) => {
    try {
          const callbackUrl = `${process.env.BASE_URL || REDIRECT_URI.replace('/auth/strava/callback', '')}/webhook`;
          const body = {
                  client_id: STRAVA_CLIENT_ID,
                  client_secret: STRAVA_CLIENT_SECRET,
                  callback_url: callbackUrl,
                  verify_token: STRAVA_VERIFY_TOKEN,
          };
          console.log('Subscribing to Strava webhook:', callbackUrl);
          const stravaRes = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
          });
          const data = await stravaRes.json();
          if (!stravaRes.ok) {
                  console.error('Strava subscription error:', data);
                  return res.status(stravaRes.status).json({ error: 'Strava subscription failed', details: data });
          }
          console.log('Strava webhook subscription created:', data);
          res.json({ success: true, subscription: data });
    } catch (err) {
          console.error('Webhook subscription error:', err);
          res.status(500).json({ error: 'Failed to subscribe to Strava webhooks' });
    }
});

// ─── GET /auth/strava/subscriptions — List active webhook subscriptions ──────
router.get('/strava/subscriptions', async (req, res) => {
    try {
          const stravaRes = await fetch(
                  `https://www.strava.com/api/v3/push_subscriptions?client_id=${STRAVA_CLIENT_ID}&client_secret=${STRAVA_CLIENT_SECRET}`
                );
          const data = await stravaRes.json();
          res.json({ subscriptions: data });
    } catch (err) {
          console.error('List subscriptions error:', err);
          res.status(500).json({ error: 'Failed to list subscriptions' });
    }
});

// Export helpers for webhook handler
module.exports = router;
module.exports.getValidToken = getValidToken;
module.exports.fetchStravaActivity = fetchStravaActivity;
module.exports.refreshAccessToken = refreshAccessToken;
module.exports.signToken = signToken;
module.exports.hashToken = hashToken;
module.exports.isSessionValid = isSessionValid;
