const polyline = require('@mapbox/polyline');
const { insertRun } = require('../db/runs');
const { getUserByStravaId } = require('../db/users');
const { supabase } = require('../db/client');

async function processStravaActivity(activityData) {
        const { id: stravaActivityId, athlete, map: activityMap, distance, moving_time, type } = activityData;

    if (type !== 'Run') return null;

    const user = await getUserByStravaId(athlete.id);
        if (!user) return null;

    if (!activityMap || !activityMap.summary_polyline) return null;

    const decoded = polyline.decode(activityMap.summary_polyline);
        if (!decoded || decoded.length === 0) return null;

    const run = await insertRun({
                userId: user.id,
                stravaActivityId: String(stravaActivityId),
                polyline: activityMap.summary_polyline,
                distanceKm: distance / 1000,
                durationSec: moving_time,
                cityId: null
    });

    // Update user's aggregate stats directly via supabase
    try {
                const newDistance = (user.total_distance_km || 0) + (distance / 1000);
                const newZones = (user.zones_owned || 0) + 1;
                await supabase.from('users').update({
                                total_distance_km: newDistance,
                                zones_owned: newZones,
                }).eq('id', user.id);
    } catch (err) {
                console.error('Failed to update user stats:', err.message);
    }

    console.log(`Processed run ${stravaActivityId} for ${user.display_name}: ${(distance / 1000).toFixed(1)} km`);

    return { run };
}

module.exports = { processStravaActivity };
