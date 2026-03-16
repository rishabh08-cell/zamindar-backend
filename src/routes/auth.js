const express = require('express');
const router = express.Router();

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/strava/callback';

// GET /auth/strava - Redirect to Strava OAuth
router.get('/strava', (req, res) => {
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${REDIRECT_URI}&scope=activity:read_all`;
    res.redirect(authUrl);
});

// GET /auth/strava/callback - Handle Strava OAuth callback
router.get('/strava/callback', async (req, res) => {
    try {
          const { code } = req.query;
          // TODO: Exchange code for token and store user
      res.json({ message: 'Strava auth callback received', code: code ? 'present' : 'missing' });
    } catch (err) {
          console.error('Auth callback error:', err);
          res.status(500).json({ error: 'Authentication failed' });
    }
});

// GET /auth/status - Check auth status
router.get('/status', (req, res) => {
    res.json({ authenticated: false, message: 'Auth not yet implemented' });
});

module.exports = router;
