const polyline = require('@mapbox/polyline');
const { insertRun } = require('../db/runs');
const { getUserByStravaId } = require('../db/users');
const territoryEngine = require('./territoryEngine');

async function processStravaActivity(activityData) {
    const { id: stravaActivityId, athlete, map: activityMap, distance, moving_time, type } = activityData;
    if (type !== 'Run') return null;

  const user = await getUserByStravaId(athlete.id);
    if (!user) return null;

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

  const territoryResult = territoryEngine.processRun(run, decoded);
    return { run, territoryResult };
}

module.exports = { processStravaActivity };
