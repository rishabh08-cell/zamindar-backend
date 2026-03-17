const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
        console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Exiting.');
        process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
});

console.log('Supabase client initialized');

module.exports = { supabase };
