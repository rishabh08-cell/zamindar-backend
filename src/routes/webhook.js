const express = require('express');
const router = express.Router();
const { getUserByStravaId } = require('../db/users');
const { processStravaActivity } = require('../lib/stravaProcessor');
const { getValidToken, fetchStravaActivity } = require('./auth');

// ─── GET /webhook — Strava webhook verification (subscription handshake) ────
router.get('/', (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

               console.log('Webhook verification request:', { mode, token: token ? 'present' : 'missing', challenge: challenge ? 'present' : 'missing' });

               if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
                           console.log('Webhook verified successfully');
                           res.json({ 'hub.challenge': challenge });
               } else {
                           console.error('Webhook verification failed — token mismatch');
                           res.status(403).json({ error: 'Verification failed' });
               }
});

// ─── POST /webhook — Strava event receiver ──────────────────────────────────
router.post('/', async (req, res) => {
        // Always respond 200 immediately — Strava retries on non-200
                res.status(200).json({ received: true });

                try {
                            const { object_type, aspect_type, object_id, owner_id } = req.body;

            console.log(`Webhook event: ${aspect_type} ${object_type} ${object_id} for athlete ${owner_id}`);

            // We only care about new/updated activities
            if (object_type !== 'activity') {
                            console.log(`Ignoring non-activity event: ${object_type}`);
                            return;
            }

            // Only process creates and updates (not deletes)
            if (aspect_type === 'delete') {
                            console.log(`Ignoring delete event for activity ${object_id}`);
                            return;
            }

            // Look up the user in our DB by their Strava athlete ID
            const user = await getUserByStravaId(owner_id);
                            if (!user) {
                                            console.log(`No user found for Strava athlete ${owner_id} — they may not have connected yet`);
                                            return;
                            }

            // Get a valid access token (auto-refreshes if expired)
            const accessToken = await getValidToken(user);

            // Fetch the full activity details from Strava API
            const activity = await fetchStravaActivity(object_id, accessToken);

            // Process through our territory engine
            const result = await processStravaActivity(activity);

            if (result) {
                            console.log(`Activity ${object_id} processed: ${result.run ? 'run stored' : 'skipped'}`);
            } else {
                            console.log(`Activity ${object_id} skipped (not a run or no polyline)`);
            }
                } catch (err) {
                            // Don't throw — we already sent 200
                                        console.error('Webhook processing error:', err);
                }
});

module.exports = router;
