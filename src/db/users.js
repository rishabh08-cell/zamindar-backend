const { supabase } = require('./client');

// ─── Users DB Module ─────────────────────────────────────────────────────────
// Users are independent entities. Strava data lives in strava_connections.
// Users can sign up via email or be auto-created through Strava OAuth.

// ── Create a user from email signup ──────────────────────────────────────────
async function createUser({ email, passwordHash, displayName }) {
      const { data, error } = await supabase
        .from('users')
        .insert({
                  email,
                  password_hash: passwordHash,
                  display_name: displayName || email.split('@')[0],
        })
        .select()
        .single();

  if (error) throw error;
      return data;
}

// ── Create a user from Strava OAuth (no email/password) ──────────────────────
async function createUserFromStrava({ stravaId, displayName, avatarUrl }) {
      const { data, error } = await supabase
        .from('users')
        .insert({
                  strava_id: stravaId,
                  display_name: displayName,
                  avatar_url: avatarUrl,
        })
        .select()
        .single();

  if (error) throw error;
      return data;
}

// ── Upsert (backward compat — still used by legacy flows) ────────────────────
async function upsertUser({ stravaId, displayName, avatarUrl, accessToken, refreshToken, expiresAt }) {
      const { data, error } = await supabase.from('users').upsert({
              strava_id: stravaId,
              display_name: displayName,
              avatar_url: avatarUrl,
              access_token: accessToken,
              refresh_token: refreshToken,
              token_expires_at: expiresAt,
      }, { onConflict: 'strava_id' }).select().single();

  if (error) throw error;
      return data;
}

// ── Lookups ──────────────────────────────────────────────────────────────────
async function getUserByStravaId(stravaId) {
      const { data, error } = await supabase.from('users').select('*').eq('strava_id', stravaId).single();
      if (error && error.code !== 'PGRST116') throw error;
      return data;
}

async function getUserById(id) {
      const { data, error } = await supabase.from('users').select('*').eq('id', id).single();
      if (error) throw error;
      return data;
}

async function getUserByEmail(email) {
      const { data, error } = await supabase.from('users').select('*').eq('email', email).single();
      if (error && error.code !== 'PGRST116') throw error;
      return data;
}

// ── Update profile ───────────────────────────────────────────────────────────
async function updateUser(userId, updates) {
      const allowed = {};
      if (updates.displayName !== undefined) allowed.display_name = updates.displayName;
      if (updates.avatarUrl !== undefined) allowed.avatar_url = updates.avatarUrl;
      if (updates.email !== undefined) allowed.email = updates.email;

  allowed.updated_at = new Date().toISOString();

  const { data, error } = await supabase
        .from('users')
        .update(allowed)
        .eq('id', userId)
        .select()
        .single();

  if (error) throw error;
      return data;
}

// ── Delete user and all their data (cascades via FK) ─────────────────────────
async function deleteUser(userId) {
      // Delete in order: zones → runs → strava_connections → sessions → user
  // ON DELETE CASCADE handles strava_connections and sessions.
  // zones and runs reference user_id but may not have CASCADE, so be explicit.
  await supabase.from('zone_history').delete().eq('user_id', userId);
      await supabase.from('zones').delete().eq('user_id', userId);
      await supabase.from('runs').delete().eq('user_id', userId);
      await supabase.from('city_coverage').delete().eq('user_id', userId);

  const { error } = await supabase.from('users').delete().eq('id', userId);
      if (error) throw error;
}

// ── Leaderboard ──────────────────────────────────────────────────────────────
async function getLeaderboard({ cityId, limit = 20 } = {}) {
      let query = supabase.from('users').select('id, display_name, avatar_url, total_distance_km, zones_owned').order('zones_owned', { ascending: false }).limit(limit);
      const { data, error } = await query;
      if (error) throw error;
      return data;
}

module.exports = {
      createUser,
      createUserFromStrava,
      upsertUser,
      getUserByStravaId,
      getUserById,
      getUserByEmail,
      updateUser,
      deleteUser,
      getLeaderboard,
};
