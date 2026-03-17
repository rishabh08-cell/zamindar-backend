const express = require('express');
const router = express.Router();
const { upsertUser, getUserByStravaId } = require('../db/users');

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/strava/callback';
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN;

// ─── Helper: Exchange code for tokens with Strava ───────────────────────────
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

// ─── Helper: Refresh an expired access token ────────────────────────────────
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

// ─── Helper: Get a valid access token for a user (auto-refresh if expired) ──
async function getValidToken(user) {
        const now = new Date();
        const expiresAt = new Date(user.token_expires_at);

    // If token still valid (with 5 min buffer), return it
    if (expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
                return user.access_token;
    }

    // Token expired — refresh it
    console.log(`Refreshing token for user ${user.strava_id}`);
        const tokenData = await refreshAccessToken(user.refresh_token);

    // Update tokens in DB
    await upsertUser({
                stravaId: user.strava_id,
                displayName: user.display_name,
                avatarUrl: user.avatar_url,
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt: new Date(tokenData.expires_at * 1000).toISOString(),
    });

    return tokenData.access_token;
}

// ─── Helper: Fetch a Strava activity by ID ──────────────────────────────────
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

// ─── GET /auth/strava — Redirect to Strava OAuth consent screen ─────────────
router.get('/strava', (req, res) => {
        const scope = 'activity:read_all';
        const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&approval_prompt=auto`;
        res.redirect(authUrl);
});

// ─── GET /auth/strava/callback — Handle OAuth callback, exchange code ───────
router.get('/strava/callback', async (req, res) => {
        try {
                    const { code, error: oauthError } = req.query;

            // User denied access
            if (oauthError) {
                            return res.redirect('/?auth=denied');
            }

            if (!code) {
                            return res.redirect('/?auth=error&reason=no_code');
            }

            // Exchange authorization code for tokens
            const tokenData = await exchangeCodeForTokens(code);

            const { athlete, access_token, refresh_token, expires_at } = tokenData;

            // Upsert user in our DB with tokens and profile info
            const user = await upsertUser({
                            stravaId: athlete.id,
                            displayName: `${athlete.firstname} ${athlete.lastname}`.trim() || athlete.username,
                            avatarUrl: athlete.profile_medium || athlete.profile,
                            accessToken: access_token,
                            refreshToken: refresh_token,
                            expiresAt: new Date(expires_at * 1000).toISOString(),
            });

            console.log(`User authenticated: ${user.display_name} (Strava ID: ${athlete.id})`);

            // Redirect to the app with the user's internal ID as a simple session token
            // In production you'd use a proper JWT or session cookie
            res.redirect(`/zamindar.html?user=${user.id}&name=${encodeURIComponent(user.display_name)}`);
        } catch (err) {
                    console.error('Auth callback error:', err);
                    res.redirect('/?auth=error&reason=token_exchange');
        }
});

// ─── GET /auth/status — Check if a user is authenticated ───────────────────
router.get('/status', async (req, res) => {
        try {
                    const userId = req.query.user;
                    if (!userId) {
                                    return res.json({ authenticated: false });
                    }

            const { getUserById } = require('../db/users');
                    const user = await getUserById(userId);

            if (!user) {
                            return res.json({ authenticated: false });
            }

            // Check if token is still valid
            const tokenValid = new Date(user.token_expires_at) > new Date();

            res.json({
                            authenticated: true,
                            user: {
                                                id: user.id,
                                                displayName: user.display_name,
                                                avatarUrl: user.avatar_url,
                                                stravaId: user.strava_id,
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

// ─── POST /auth/strava/subscribe — Register Strava webhook subscription ─────
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

// ─── GET /auth/strava/subscriptions — List active webhook subscriptions ─────
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

// Export helpers for use by webhook handler
module.exports = router;
module.exports.getValidToken = getValidToken;
module.exports.fetchStravaActivity = fetchStravaActivity;
module.exports.refreshAccessToken = refreshAccessToken;
