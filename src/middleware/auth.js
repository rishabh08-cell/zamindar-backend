const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

async function requireAuth(req, res, next) {
    try {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
                  return res.status(401).json({ error: 'Missing or invalid Authorization header' });
          }

      const token = authHeader.replace('Bearer ', '');

      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
              global: { headers: { Authorization: `Bearer ${token}` } },
              auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: { user }, error } = await supabase.auth.getUser(token);

      if (error || !user) {
              console.warn('JWT validation failed:', error?.message || 'No user');
              return res.status(401).json({ error: 'Invalid or expired token' });
      }

      req.user = user;
          next();
    } catch (err) {
          console.error('Auth middleware error:', err.message);
          return res.status(500).json({ error: 'Authentication error' });
    }
}

module.exports = { requireAuth };
