const express = require('express');
const router = express.Router();

// GET /webhook - Strava webhook verification
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

             if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
                   res.json({ 'hub.challenge': challenge });
             } else {
                   res.status(403).json({ error: 'Verification failed' });
             }
});

// POST /webhook - Strava event receiver
router.post('/', async (req, res) => {
    try {
          const { object_type, aspect_type, object_id, owner_id } = req.body;
          console.log(`Strava webhook: ${aspect_type} ${object_type} ${object_id} for athlete ${owner_id}`);
          // TODO: Wire up to stravaProcessor
      res.status(200).json({ received: true });
            } catch (err) {
          console.error('Webhook error:', err);
          res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
