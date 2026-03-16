const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase credentials not set. DB operations will fail.');
}

const supabase = createClient(supabaseUrl || '', supabaseServiceKey || '', {
                                            auth: { autoRefreshToken: false, persistSession: false }
                                          });

module.exports = { supabase };
