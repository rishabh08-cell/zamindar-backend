const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseServiceKey) {
      supabase = createClient(supabaseUrl, supabaseServiceKey, {
                auth: { autoRefreshToken: false, persistSession: false }
      });
      console.log('Supabase client initialized');
} else {
      console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. DB operations will return empty results.');
      // Create a mock client that returns empty results instead of crashing
    const handler = {
              get(target, prop) {
                            if (prop === 'from') {
                                              return () => new Proxy({}, {
                                                                    get(t, p) {
                                                                                              if (['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'order', 'limit', 'range', 'single', 'maybeSingle'].includes(p)) {
                                                                                                                            return (...args) => new Proxy({}, handler);
                                                                                                }
                                                                                              if (p === 'then') return undefined; // not a promise
                                                                        return () => ({ data: null, error: { message: 'Supabase not configured', code: 'NO_CONFIG' } });
                                                                    }
                                              });
                            }
                            return target[prop];
              }
    };
      supabase = new Proxy({}, handler);
}

module.exports = { supabase };
