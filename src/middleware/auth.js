const jwt = require('jsonwebtoken');
const { getUserById } = require('../db/users');
const { hashToken, isSessionValid } = require('../routes/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'zamindar-dev-secret-change-in-prod';

/**
 * requireAuth — Middleware that validates our own JWTs.
 * Replaces the old Supabase Auth approach.
 * Sets req.user = { id, email, display_name, ... } on success.
 */
async function requireAuth(req, res, next) {
      try {
              const authHeader = req.headers.authorization;
              if (!authHeader || !authHeader.startsWith('Bearer ')) {
                        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
              }

        const token = authHeader.replace('Bearer ', '');

        // Verify JWT signature and expiry
        let decoded;
              try {
                        decoded = jwt.verify(token, JWT_SECRET);
              } catch (err) {
                        if (err.name === 'TokenExpiredError') {
                                    return res.status(401).json({ error: 'Token expired' });
                        }
                        return res.status(401).json({ error: 'Invalid token' });
              }

        // Check session is still active (not logged out)
        const tokenH = hashToken(token);
              const sessionOk = await isSessionValid(tokenH);
              if (!sessionOk) {
                        return res.status(401).json({ error: 'Session expired or revoked' });
              }

        // Load the full user object
        const user = await getUserById(decoded.userId);
              if (!user) {
                        return res.status(401).json({ error: 'User not found' });
              }

        // Attach user to request for downstream handlers
        req.user = user;
              req.userId = user.id;
              next();
      } catch (err) {
              console.error('Auth middleware error:', err.message);
              return res.status(500).json({ error: 'Authentication error' });
      }
}

module.exports = { requireAuth };
