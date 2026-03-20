const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getUserById } = require('../db/users');
const { supabase } = require('../db/client');

const JWT_SECRET = process.env.JWT_SECRET || 'zamindar-dev-secret-change-in-prod';

function hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
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

async function requireAuth(req, res, next) {
        try {
                  const authHeader = req.headers.authorization;
                  if (!authHeader || !authHeader.startsWith('Bearer ')) {
                              return res.status(401).json({ error: 'Missing or invalid Authorization header' });
                  }

          const token = authHeader.replace('Bearer ', '');

          let decoded;
                  try {
                              decoded = jwt.verify(token, JWT_SECRET);
                  } catch (err) {
                              if (err.name === 'TokenExpiredError') {
                                            return res.status(401).json({ error: 'Token expired' });
                              }
                              return res.status(401).json({ error: 'Invalid token' });
                  }

          const tokenH = hashToken(token);
                  const sessionOk = await isSessionValid(tokenH);
                  if (!sessionOk) {
                              return res.status(401).json({ error: 'Session expired or revoked' });
                  }

          const user = await getUserById(decoded.userId);
                  if (!user) {
                              return res.status(401).json({ error: 'User not found' });
                  }

          req.user = user;
                  req.userId = user.id;
                  next();
        } catch (err) {
                  console.error('Auth middleware error:', err.message);
                  return res.status(500).json({ error: 'Authentication error' });
        }
}

module.exports = { requireAuth };
