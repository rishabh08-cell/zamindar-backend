/**
 * TerraRun — Strava Webhook Handler
 * 
 * Strava pushes a lightweight event to this endpoint within ~30s of
 * a user completing an activity. We then fetch the full activity,
 * normalise it, qualify it, and hand off to the territory engine.
 *
 * Strava webhook docs:
 *   https://developers.strava.com/docs/webhooks/
 *
 * Flow:
 *   POST /webhooks/strava
 *     → verify signature
 *     → enqueue job (return 200 immediately — Strava retries if we're slow)
 *   
 *   Worker picks up job:
 *     → fetch full activity from Strava API
 *     → normalise to TerraRun run schema
 *     → idempotency check (already processed?)
 *     → qualifyRun
 *     → fetch overlapping runs from PostGIS
 *     → processNewRun (territory engine)
 *     → apply mutations in DB transaction
 *     → push GeoJSON diff to connected clients via WebSocket
 *     → send push notification if territory changed
 */

const crypto  = require('crypto');
const { RULES, qualifyRun, processNewRun } = require('./territoryEngine');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const STRAVA = {
  BASE_URL:          'https://www.strava.com/api/v3',
  VERIFY_TOKEN:      process.env.STRAVA_VERIFY_TOKEN,   // set on webhook subscription
  CLIENT_ID:         process.env.STRAVA_CLIENT_ID,
  CLIENT_SECRET:     process.env.STRAVA_CLIENT_SECRET,
  // Strava activity types we care about — everything else dropped immediately
  ALLOWED_TYPES:     new Set(['Run', 'TrailRun', 'Walk']),
  // Strava type → our enum
  TYPE_MAP: {
    Run:      'run',
    TrailRun: 'trail_run',
    Walk:     'walk',
  },
};

// How long to wait before retrying a failed Strava API fetch
const RETRY_DELAYS_MS = [2_000, 10_000, 60_000]; // 3 attempts

// ─── STEP 1: WEBHOOK RECEIVER (Express route handler) ────────────────────────

/**
 * GET /webhooks/strava
 * Strava sends this to validate the endpoint when you first subscribe.
 * Must echo back hub.challenge.
 */
function handleStravaValidation(req, res) {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  if (mode !== 'subscribe' || token !== process.env.STRAVA_VERIFY_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Strava requires exactly this response shape
  return res.status(200).json({ 'hub.challenge': challenge });
}

/**
 * POST /webhooks/strava
 * Receives activity events. Returns 200 immediately — processing is async.
 *
 * Strava event payload shape:
 * {
 *   object_type:  "activity",
 *   object_id:    12345678,        ← Strava activity ID
 *   aspect_type:  "create",        ← create | update | delete
 *   owner_id:     87654321,        ← Strava athlete ID
 *   subscription_id: 999,
 *   event_time:   1640000000,
 *   updates:      {}               ← populated on "update" events
 * }
 */
async function handleStravaEvent(req, res, { queue, db }) {
  // Return 200 immediately — Strava will retry for up to 48h if we're slow
  res.status(200).json({ received: true });

  const event = req.body;

  // Only care about activity creation events
  if (event.object_type !== 'activity' || event.aspect_type !== 'create') {
    return; // silently ignore updates/deletes for now
  }

  // Look up which TerraRun user owns this Strava athlete ID
  const source = await db.connected_sources.findOne({
    provider:          'strava',
    provider_user_id:  String(event.owner_id),
  });

  if (!source) {
    // This athlete hasn't connected TerraRun — ignore
    return;
  }

  // Enqueue the heavy work — don't do it in the webhook handler
  await queue.enqueue('process_strava_activity', {
    strava_activity_id: event.object_id,
    user_id:            source.user_id,
    source_id:          source.id,
    access_token:       source.access_token,
    refresh_token:      source.refresh_token,
    token_expires_at:   source.token_expires_at,
    enqueued_at:        new Date().toISOString(),
  });
}

// ─── STEP 2: QUEUE WORKER ─────────────────────────────────────────────────────

/**
 * processStravaActivity — runs in a background worker (BullMQ / Supabase Edge Function)
 * 
 * This is the main function. Does everything from fetching the activity
 * to writing the final mutations.
 */
async function processStravaActivity(job, { db, ws, pushNotif }) {
  const {
    strava_activity_id,
    user_id,
    source_id,
    access_token,
    refresh_token,
    token_expires_at,
  } = job.data;

  // ── 2a. Idempotency check ──────────────────────────────────────────────────
  // If we've already processed this Strava activity ID, skip.
  // Strava can deliver duplicate webhook events.
  const existing = await db.runs.findOne({
    external_id: String(strava_activity_id),
    source_id,
  });
  if (existing) {
    console.log(`[strava] already processed activity ${strava_activity_id} — skipping`);
    return { skipped: true, reason: 'duplicate' };
  }

  // ── 2b. Ensure token is fresh ──────────────────────────────────────────────
  const token = await ensureFreshToken({
    access_token, refresh_token, token_expires_at, source_id, db
  });

  // ── 2c. Fetch full activity from Strava ────────────────────────────────────
  const stravaActivity = await fetchStravaActivity(strava_activity_id, token);

  // Quick pre-filter before doing any DB work
  if (!STRAVA.ALLOWED_TYPES.has(stravaActivity.type)) {
    console.log(`[strava] activity ${strava_activity_id} is type '${stravaActivity.type}' — not a run/walk, skipping`);
    return { skipped: true, reason: `activity type '${stravaActivity.type}' not allowed` };
  }

  if (!stravaActivity.map?.polyline && !stravaActivity.map?.summary_polyline) {
    console.log(`[strava] activity ${strava_activity_id} has no GPS data — skipping`);
    return { skipped: true, reason: 'no GPS polyline' };
  }

  // ── 2d. Normalise to TerraRun run schema ───────────────────────────────────
  const normalisedRun = normaliseStravaActivity(stravaActivity, { user_id, source_id });

  // ── 2e. Compute polygon via PostGIS ───────────────────────────────────────
  // We store the raw LineString and ask PostGIS to compute the territory polygon.
  // ST_ConvexHull(ST_Buffer(route::geography, 50)) gives us a clean polygon
  // that fills in the space enclosed by the route with a 50m buffer.
  const withPolygon = await computePolygon(normalisedRun, db);

  // ── 2f. Qualify ───────────────────────────────────────────────────────────
  const { qualified, reason } = qualifyRun(withPolygon);

  // Store the run regardless — unqualified runs useful for debugging + user feedback
  const storedRun = await db.runs.insert({
    ...withPolygon,
    qualified,
    is_active: false, // territory engine decides activation
  });

  if (!qualified) {
    console.log(`[strava] run ${strava_activity_id} did not qualify: ${reason}`);
    // Let user know if their run didn't count
    await pushNotif.send(user_id, {
      title: 'Run recorded but not counted',
      body:  reason,
      type:  'run_rejected',
    });
    return { qualified: false, reason };
  }

  // ── 2g. Fetch context for territory engine ─────────────────────────────────
  const [existingUserRuns, overlappingRuns, cities, userStats, users] = await Promise.all([
    // This user's current active runs
    db.runs.findMany({
      user_id,
      is_active: true,
      order:     'started_at DESC',
    }),
    // Other users' active runs whose polygon intersects this run's polygon
    // PostGIS query: ST_Intersects(r.polygon, $polygon) AND user_id != $user_id
    db.runs.findOverlapping({
      polygon: withPolygon.polygon,
      exclude_user_id: user_id,
    }),
    // Cities near this run's centroid (within 50km)
    db.cities.findNear({
      point:      withPolygon.centroid,
      radius_m:   50_000,
    }),
    // Tiebreaker stats for all involved users
    db.users.getStats([user_id, ...overlappingRuns.map(r => r.user_id)]),
    // Display info for GeoJSON
    db.users.findMany([user_id, ...overlappingRuns.map(r => r.user_id)]),
  ]);

  // ── 2h. Run territory engine ───────────────────────────────────────────────
  const result = processNewRun({
    newRun:           withPolygon,
    existingUserRuns,
    overlappingRuns,
    cities,
    userStats,
    users:            Object.fromEntries(users.map(u => [u.id, u])),
  });

  // ── 2i. Apply all mutations in a single DB transaction ────────────────────
  await db.transaction(async (tx) => {
    const { mutations } = result;

    // Activate/deactivate runs
    if (mutations.runs.activate.length) {
      await tx.runs.setActive(mutations.runs.activate, true);
    }
    if (mutations.runs.deactivate.length) {
      await tx.runs.setActive(mutations.runs.deactivate, false);
    }

    // Upsert conflicts
    if (mutations.conflicts.upsert.length) {
      await tx.zone_conflicts.upsert(mutations.conflicts.upsert, {
        conflict_key: ['run_a_id', 'run_b_id'],
      });
    }

    // City captures
    for (const city of mutations.cities.capture) {
      await tx.cities.update(city.id, {
        current_owner_id: city.new_owner_id,
        owner_since:      new Date().toISOString(),
      });
    }

    // City contestations — log the siege attempt
    for (const city of mutations.cities.contest) {
      await tx.city_siege_log.insert({
        city_id:       city.id,
        challenger_id: city.challenger_id,
        run_id:        withPolygon.id,
        attempted_at:  new Date().toISOString(),
      });
    }

    // Update user denormalised stats
    for (const update of mutations.users.update) {
      await tx.users.update(update.id, update);
    }
  });

  // ── 2j. Push real-time updates ────────────────────────────────────────────
  // Send GeoJSON diff to all clients viewing the affected area
  await ws.broadcast({
    channel: 'territory_update',
    bbox:    withPolygon.bbox, // clients filter by their viewport
    payload: {
      type:    'territory_diff',
      geojson: result.geojson,
      // Also send the raw conflict list so clients can update their UI
      conflicts: result.mutations.conflicts.upsert.map(c => ({
        run_a_owner: c.run_a_owner,
        run_b_owner: c.run_b_owner,
        score_a:     c.control_score_a,
        score_b:     c.control_score_b,
        status:      c.resolved_owner_id ? 'resolved' : 'contested',
      })),
    },
  });

  // ── 2k. Push notifications to affected runners ────────────────────────────
  await sendAffectedNotifications({
    newRun:    withPolygon,
    mutations: result.mutations,
    cities:    result.mutations.cities,
    pushNotif,
    db,
  });

  console.log(`[strava] processed activity ${strava_activity_id} for user ${user_id}`);
  return { success: true, qualified: true, conflicts: result.mutations.conflicts.upsert.length };
}

// ─── STEP 3: STRAVA API HELPERS ───────────────────────────────────────────────

/**
 * Fetches a single activity from Strava with retry logic.
 * Returns the full Strava activity object.
 */
async function fetchStravaActivity(activityId, accessToken, attempt = 0) {
  const url = `${STRAVA.BASE_URL}/activities/${activityId}?include_all_efforts=false`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    // Rate limited — Strava allows 100 req/15min, 1000/day
    const retryAfter = parseInt(res.headers.get('X-RateLimit-Reset') || '900', 10);
    throw new RateLimitError(`Strava rate limited — retry after ${retryAfter}s`);
  }

  if (res.status === 401) {
    throw new TokenExpiredError('Strava token expired');
  }

  if (!res.ok) {
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      return fetchStravaActivity(activityId, accessToken, attempt + 1);
    }
    throw new Error(`Strava API error ${res.status} after ${attempt + 1} attempts`);
  }

  return res.json();
}

/**
 * Refreshes the Strava OAuth token if it's expired or within 5 min of expiry.
 * Persists the new token to DB.
 */
async function ensureFreshToken({ access_token, refresh_token, token_expires_at, source_id, db }) {
  const expiresAt  = new Date(token_expires_at);
  const bufferMs   = 5 * 60 * 1000; // refresh 5 min before expiry
  const needsRefresh = expiresAt.getTime() - Date.now() < bufferMs;

  if (!needsRefresh) return access_token;

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     STRAVA.CLIENT_ID,
      client_secret: STRAVA.CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token,
    }),
  });

  if (!res.ok) throw new Error('Failed to refresh Strava token');

  const { access_token: newToken, refresh_token: newRefresh, expires_at } = await res.json();

  // Persist refreshed token
  await db.connected_sources.update(source_id, {
    access_token:      newToken,
    refresh_token:     newRefresh,
    token_expires_at:  new Date(expires_at * 1000).toISOString(),
    last_synced_at:    new Date().toISOString(),
  });

  return newToken;
}

// ─── STEP 4: NORMALISE STRAVA → TERRARUN ──────────────────────────────────────

/**
 * Converts a Strava activity object into a TerraRun run record.
 * All unit conversions happen here — everything downstream is metric SI.
 */
function normaliseStravaActivity(activity, { user_id, source_id }) {
  // Strava sends polyline-encoded routes. We store as GeoJSON LineString.
  // decodePolyline converts Google's encoded polyline format to [lng, lat] pairs.
  const coordinates = decodePolyline(
    activity.map.polyline || activity.map.summary_polyline
  );

  const route = {
    type:        'LineString',
    coordinates, // [[lng, lat], [lng, lat], ...]
  };

  return {
    // Identity
    id:              generateUUID(),
    user_id,
    source_id,
    external_id:     String(activity.id),

    // Timing — started_at is the conflict resolution source of truth
    started_at:      activity.start_date,       // ISO8601 UTC from Strava

    // Metrics (Strava uses metres and seconds natively — no conversion needed)
    distance_m:      Math.round(activity.distance),
    duration_s:      Math.round(activity.moving_time),

    // Type normalisation
    activity_type:   STRAVA.TYPE_MAP[activity.type] || 'run',

    // Geography — polygon and area computed by PostGIS after insert (see computePolygon)
    route,          // GeoJSON LineString
    polygon:        null,           // filled in by computePolygon()
    polygon_area_m2: null,          // filled in by computePolygon()
    centroid:       null,           // filled in by computePolygon()
    bbox:           null,           // filled in by computePolygon()

    // State
    is_active:       false,         // territory engine decides
    qualified:       false,         // qualifyRun decides
    ingested_at:     new Date().toISOString(),
  };
}

/**
 * Calls PostGIS to compute the territory polygon from the raw LineString.
 * 
 * SQL executed:
 *   SELECT
 *     ST_AsGeoJSON(
 *       ST_ConvexHull(
 *         ST_Buffer(ST_GeomFromGeoJSON($route)::geography, 50)::geometry
 *       )
 *     )::json                         AS polygon,
 *     ST_Area(
 *       ST_ConvexHull(
 *         ST_Buffer(ST_GeomFromGeoJSON($route)::geography, 50)::geometry
 *       )::geography
 *     )                               AS polygon_area_m2,
 *     ST_AsGeoJSON(
 *       ST_Centroid(ST_GeomFromGeoJSON($route))
 *     )::json                         AS centroid,
 *     ST_AsGeoJSON(
 *       ST_Envelope(ST_GeomFromGeoJSON($route))
 *     )::json                         AS bbox
 */
async function computePolygon(run, db) {
  const result = await db.query(`
    SELECT
      ST_AsGeoJSON(
        ST_ConvexHull(
          ST_Buffer(ST_GeomFromGeoJSON($1)::geography, $2)::geometry
        )
      )::json                              AS polygon,
      ST_Area(
        ST_ConvexHull(
          ST_Buffer(ST_GeomFromGeoJSON($1)::geography, $2)::geometry
        )::geography
      )                                    AS polygon_area_m2,
      ST_AsGeoJSON(ST_Centroid(
        ST_GeomFromGeoJSON($1))
      )::json                              AS centroid,
      ST_AsGeoJSON(ST_Envelope(
        ST_GeomFromGeoJSON($1))
      )::json                              AS bbox
  `, [JSON.stringify(run.route), RULES.ROUTE_BUFFER_M]);

  const { polygon, polygon_area_m2, centroid, bbox } = result.rows[0];

  return {
    ...run,
    polygon,
    polygon_area_m2: Math.round(polygon_area_m2),
    centroid,
    bbox,
  };
}

// ─── STEP 5: NOTIFICATIONS ────────────────────────────────────────────────────

/**
 * Sends push notifications to all runners whose territory was affected.
 * Batches by affected user to avoid spamming.
 */
async function sendAffectedNotifications({ newRun, mutations, cities, pushNotif, db }) {
  const runner = await db.users.findOne(newRun.user_id);
  const notifications = [];

  // Notify runners whose zones were cut
  const affectedUserIds = [...new Set(
    mutations.conflicts.upsert
      .filter(c => c.resolved_owner_id === newRun.user_id || c.control_score_b > 60)
      .map(c => c.run_a_owner)
      .filter(id => id !== newRun.user_id)
  )];

  for (const rivalId of affectedUserIds) {
    notifications.push(pushNotif.send(rivalId, {
      title: `${runner.display_name} is challenging your zone`,
      body:  'Run back to defend your territory.',
      type:  'zone_challenged',
      data:  { challenger_id: newRun.user_id, run_id: newRun.id },
    }));
  }

  // Notify runner about city captures
  for (const city of cities.capture) {
    notifications.push(pushNotif.send(newRun.user_id, {
      title: `You captured ${city.name}!`,
      body:  `${city.territory_multiplier}× multiplier now active for nearby runs.`,
      type:  'city_captured',
      data:  { city_id: city.id },
    }));

    // Notify the previous owner they lost the city
    if (city.current_owner_id) {
      notifications.push(pushNotif.send(city.current_owner_id, {
        title: `${runner.display_name} took ${city.name}`,
        body:  'Run around it again to reclaim it.',
        type:  'city_lost',
        data:  { city_id: city.id, new_owner_id: newRun.user_id },
      }));
    }
  }

  await Promise.allSettled(notifications); // don't let notification failures block
}

// ─── STEP 6: INITIAL SYNC (on Strava connect) ─────────────────────────────────

/**
 * When a user first connects Strava, pull their last 3 qualified runs
 * within 30 days and process each one.
 *
 * Called once on OAuth callback — gives instant territory on signup.
 * "You've been building this for months. You just didn't know it."
 */
async function initialStravaSync({ user_id, source_id, access_token, db, queue }) {
  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 86400000) / 1000); // Unix timestamp

  // Fetch recent activities — we ask for more than 3 to account for
  // unqualified ones (indoor, too short etc.) being filtered out
  const res = await fetch(
    `${STRAVA.BASE_URL}/athlete/activities?after=${thirtyDaysAgo}&per_page=20`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );

  if (!res.ok) throw new Error(`Failed to fetch Strava activities: ${res.status}`);

  const activities = await res.json();

  // Filter to allowed types immediately — don't even queue the rest
  const eligible = activities
    .filter(a => STRAVA.ALLOWED_TYPES.has(a.type))
    .slice(0, 10); // process up to 10, engine will pick the best 3

  // Enqueue each one — the territory engine handles ordering correctly
  // Process oldest first so newest ends up as the "most recent" after all are done
  const ordered = eligible.sort((a, b) =>
    new Date(a.start_date) - new Date(b.start_date)
  );

  for (const activity of ordered) {
    await queue.enqueue('process_strava_activity', {
      strava_activity_id: activity.id,
      user_id,
      source_id,
      access_token,
      is_initial_sync: true,
    });
  }

  return { enqueued: ordered.length };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Decode Google's encoded polyline format → GeoJSON coordinates.
 * Strava uses this to compact GPS traces.
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function decodePolyline(encoded) {
  if (!encoded) return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];

  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    // GeoJSON is [longitude, latitude]
    coordinates.push([lng / 1e5, lat / 1e5]);
  }

  return coordinates;
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RateLimitError extends Error { constructor(msg) { super(msg); this.name = 'RateLimitError'; } }
class TokenExpiredError extends Error { constructor(msg) { super(msg); this.name = 'TokenExpiredError'; } }

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  handleStravaValidation,
  handleStravaEvent,
  processStravaActivity,
  initialStravaSync,
  normaliseStravaActivity,
  decodePolyline,
  ensureFreshToken,
  // Errors — caller can catch these specifically
  RateLimitError,
  TokenExpiredError,
};
