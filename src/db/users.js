const { supabase } = require('./client');

async function upsertUser({ stravaId, displayName, avatarUrl, accessToken, refreshToken, expiresAt }) {
    const { data, error } = await supabase.from('users').upsert({ strava_id: stravaId, display_name: displayName, avatar_url: avatarUrl, access_token: accessToken, refresh_token: refreshToken, token_expires_at: expiresAt }, { onConflict: 'strava_id' }).select().single();
    if (error) throw error;
    return data;
}

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

async function getLeaderboard({ cityId, limit = 20 } = {}) {
    let query = supabase.from('users').select('id, display_name, avatar_url, total_distance_km, zones_owned').order('zones_owned', { ascending: false }).limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    return data;
}

module.exports = { upsertUser, getUserByStravaId, getUserById, getLeaderboard };
