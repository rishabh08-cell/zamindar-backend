const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase;

if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  console.log('Supabase client initialized');
} else {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Running in mock mode.');
  // Create a mock client that returns empty results instead of crashing
  const handler = {
    get: function(target, prop) {
      if (prop === 'from') {
        return function() {
          return new Proxy({}, {
            get: function() {
              return function() {
                return Promise.resolve({ data: [], error: null });
              };
            }
          });
        };
      }
      if (prop === 'rpc') {
        return function() {
          return Promise.resolve({ data: null, error: null });
        };
      }
      return function() {
        return new Proxy({}, handler);
      };
    }
  };
  supabase = new Proxy({}, handler);
}

module.exports = { supabase };
