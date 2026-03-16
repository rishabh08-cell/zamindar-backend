const { supabase } = require('./client');

async function insertRun({ userId, stravaActivityId, polyline, distanceKm, durationSec, cityId }) {
    const { data, error } = await supabase
      .from('runs')
      .insert({
              user_id: userId,
              strava_activity_id: stravaActivityId,
              polyline,
              distance_km: distanceKm,
              duration_sec: durationSec,
              city_id: cityId,
              created_at: new Date().toISOString()
            })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

async function getRunsByUser(userId, { limit = 50, offset = 0 } = {}) {
    const { data, error } = await supabase
      .from('runs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  }

async function getRunsByCity(cityId, { limit = 100 } = {}) {
    const { data, error } = await supabase
      .from('runs')
      .select('*, users(display_name, avatar_url)')
      .eq('city_id', cityId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

module.exports = { insertRun, getRunsByUser, getRunsByCity };
