/**
 * TerraRun Territory Engine
 * Runs on every new run ingestion. Pure functions — no side effects.
 * Input:  a newly ingested run + current DB state
 * Output: a set of DB mutations to apply atomically
 */

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const RULES = {
  MAX_ACTIVE_RUNS:       3,
  WINDOW_DAYS:           30,
  MIN_DISTANCE_M:        2000,
  MIN_DURATION_S:        900,       // 15 min
  MIN_AREA_M2:           100_000,   // 0.1 km²
  MAX_AREA_M2:           25_000_000,// 25 km² — caps a single run
  ALLOWED_TYPES:         ['run', 'trail_run', 'walk'],
  WALK_ZONE_MULTIPLIER:  0.6,       // walks earn 60% of a run's zone score
  ROUTE_BUFFER_M:        50,        // buffer around LineString before convex hull

  // Control score — how much a new run shifts the score in the overlap
  SCORE_NEW_RUN:         +30,       // run_b (newer) gets this advantage
  SCORE_BASE_DEFENDER:   60,        // existing owner starts at 60 in their zone

  // Tiebreaker weights (all normalised 0–1 before applying)
  TIE_TOTAL_ZONES_W:     0.4,
  TIE_CITY_OWNERSHIP_W:  0.35,
  TIE_RUN_RECENCY_W:     0.15,
  TIE_STREAK_W:          0.10,

  // Fauj (army) alliance bonuses
  FAUJ_DEFENSE_BONUS:    15,  // control score bonus when fauj allies have nearby zones
  FRIEND_CONFLICT_PENALTY: 0.5, // friends in diff faujs: contest at 50% intensity
};

// ─── STEP 1: QUALIFY THE RUN ─────────────────────────────────────────────────

/**
 * Decides whether a run is eligible to become territory.
 * Returns { qualified: bool, reason: string }
 */
function qualifyRun(run) {
  if (!RULES.ALLOWED_TYPES.includes(run.activity_type)) {
    return { qualified: false, reason: `activity_type '${run.activity_type}' not allowed — running and walking only` };
  }
  if (run.distance_m < RULES.MIN_DISTANCE_M) {
    return { qualified: false, reason: `distance ${run.distance_m}m is under 2km minimum` };
  }
  if (run.duration_s < RULES.MIN_DURATION_S) {
    return { qualified: false, reason: `duration ${run.duration_s}s is under 15min minimum` };
  }
  if (!run.polygon) {
    return { qualified: false, reason: 'no GPS polygon — likely indoor or treadmill run' };
  }
  if (run.polygon_area_m2 < RULES.MIN_AREA_M2) {
    return { qualified: false, reason: `enclosed area ${run.polygon_area_m2}m² is under 0.1km² minimum — route too linear` };
  }
  if (run.polygon_area_m2 > RULES.MAX_AREA_M2) {
    // Don't reject — clip. Very long runs still qualify, just capped.
    run._areaCapped = true;
  }
  return { qualified: true, reason: 'ok' };
}

// ─── STEP 2: COMPUTE ACTIVE WINDOW ───────────────────────────────────────────

/**
 * Given a user's existing runs (already sorted newest first),
 * returns which runs remain active after the new run is added.
 *
 * Rules:
 *   - Must be within 30 days of today
 *   - Max 3 active at once
 *   - New run always takes a slot if it qualifies (it's the most recent)
 *   - If already 3 active, oldest is evicted
 *
 * Returns { toActivate: [runId], toDeactivate: [runId] }
 */
function computeActiveWindow(newRun, existingRuns, now = new Date()) {
  const cutoff = new Date(now - RULES.WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Filter existing active runs that are still within the 30-day window
  const stillValid = existingRuns
    .filter(r => r.is_active && new Date(r.started_at) >= cutoff)
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at)); // newest first

  const toDeactivate = [];
  const toActivate = [newRun.id];

  // Anything outside the window gets deactivated regardless
  existingRuns
    .filter(r => r.is_active && new Date(r.started_at) < cutoff)
    .forEach(r => toDeactivate.push(r.id));

  // If adding new run exceeds MAX_ACTIVE_RUNS, evict the oldest valid one
  if (stillValid.length >= RULES.MAX_ACTIVE_RUNS) {
    const evicted = stillValid[stillValid.length - 1]; // oldest
    toDeactivate.push(evicted.id);
  }

  return { toActivate, toDeactivate };
}

// ─── STEP 3: DETECT CONFLICTS ─────────────────────────────────────────────────

/**
 * Given the new run's polygon and all OTHER users' active run polygons,
 * returns a list of conflicts to create/update.
 *
 * In production this is a single PostGIS query:
 *   SELECT r.* FROM runs r
 *   WHERE r.is_active = true
 *   AND r.user_id != $newRun.user_id
 *   AND ST_Intersects(r.polygon, $newRun.polygon)
 *
 * Here we simulate the output structure.
 *
 * Returns ConflictRecord[]
 */
/**
 * Filter out overlaps between Fauj allies. Members of the same Fauj
 * merge territory instead of fighting over it.
 *
 * @param {string[]} faujMemberIds - user IDs in the same fauj as newRun's owner (empty if no fauj)
 * @param {string[]} friendIds - user IDs who are friends with newRun's owner
 */
function detectConflicts(newRun, overlappingRuns, faujMemberIds = [], friendIds = []) {
  const faujSet = new Set(faujMemberIds);
  const friendSet = new Set(friendIds);

  return overlappingRuns
    .filter(existingRun => {
      // Same fauj = no conflict (territories merge)
      if (faujSet.has(existingRun.user_id)) return false;
      return true;
    })
    .map(existingRun => {
    // run_a = earlier, run_b = later (newer run always wins the overlap)
    const [runA, runB] = newRun.started_at > existingRun.started_at
      ? [existingRun, newRun]
      : [newRun, existingRun];

    // Overlap geometry computed by PostGIS ST_Intersection — we represent it here
    // as a placeholder; real value comes from the DB query
    const overlapPolygon = `ST_Intersection(${runA.id}.polygon, ${runB.id}.polygon)`;
    const overlapAreaM2  = estimateOverlapArea(runA, runB); // see below

    return {
      run_a_id:        runA.id,
      run_b_id:        runB.id,
      run_a_owner:     runA.user_id,
      run_b_owner:     runB.user_id,
      overlap_polygon: overlapPolygon,
      overlap_area_m2: overlapAreaM2,
      expires_at:      earlierExpiry(runA, runB),
      is_friend:       friendSet.has(existingRun.user_id),
    };
  });
}

// ─── STEP 4: COMPUTE CONTROL SCORES ──────────────────────────────────────────

/**
 * For each conflict, compute the control score for both sides.
 * run_b (newer) starts with a natural advantage.
 * Tiebreaker metrics shift the score further when it's close.
 *
 * Score is always from run_a's perspective (0 = run_a owns nothing,
 * 100 = run_a owns everything). run_b's score = 100 - run_a's score.
 */
/**
 * @param {Object} conflict
 * @param {Object} userStats - keyed by user_id
 * @param {number} faujAllyCountA - how many fauj allies of run_a owner have active zones nearby
 * @param {number} faujAllyCountB - how many fauj allies of run_b owner have active zones nearby
 */
function computeControlScore(conflict, userStats, faujAllyCountA = 0, faujAllyCountB = 0) {
  const statsA = userStats[conflict.run_a_owner];
  const statsB = userStats[conflict.run_b_owner];

  // Base: defender (run_a, older run) starts at 60, challenger (run_b) at 70
  // run_b wins by default if everything else is equal — newer run has authority
  let scoreA = RULES.SCORE_BASE_DEFENDER;        // 60
  let scoreB = RULES.SCORE_BASE_DEFENDER + RULES.SCORE_NEW_RUN; // 90 — but capped below

  // Fauj defense bonus: each fauj ally with nearby zones adds to your score
  scoreA += Math.min(faujAllyCountA, 3) * RULES.FAUJ_DEFENSE_BONUS;
  scoreB += Math.min(faujAllyCountB, 3) * RULES.FAUJ_DEFENSE_BONUS;

  // Friend conflict penalty: friends fight at reduced intensity
  // Both scores pulled toward 50 (less decisive outcome)
  if (conflict.is_friend) {
    scoreA = 50 + (scoreA - 50) * RULES.FRIEND_CONFLICT_PENALTY;
    scoreB = 50 + (scoreB - 50) * RULES.FRIEND_CONFLICT_PENALTY;
  }

  // Tiebreaker adjustments — only meaningful when scores are within 15pts of each other
  const gap = Math.abs(scoreA - scoreB);
  if (gap <= 15) {
    const tieScore = computeTiebreaker(statsA, statsB);
    // tieScore > 0 means A wins tiebreaker, < 0 means B wins
    scoreA += tieScore * 10;
    scoreB -= tieScore * 10;
  }

  // Clamp to 0–100
  scoreA = Math.min(100, Math.max(0, Math.round(scoreA)));
  scoreB = Math.min(100, Math.max(0, Math.round(scoreB)));

  const resolvedOwner = scoreA > 70 ? conflict.run_a_owner
                      : scoreB > 70 ? conflict.run_b_owner
                      : null; // genuinely contested — no single owner

  return {
    ...conflict,
    control_score_a:    scoreA,
    control_score_b:    scoreB,
    resolved_owner_id:  resolvedOwner,
  };
}

/**
 * Returns a value -1 to +1.
 * Positive = userA wins tiebreaker.
 * Negative = userB wins tiebreaker.
 */
function computeTiebreaker(statsA, statsB) {
  // Normalise each metric to 0–1 relative to each other
  const norm = (a, b) => (a + b) === 0 ? 0 : (a - b) / (a + b);

  const zonesEdge   = norm(statsA.total_zones,    statsB.total_zones);
  const citiesEdge  = norm(statsA.cities_owned,   statsB.cities_owned);
  const recencyEdge = norm(statsA.recency_score,  statsB.recency_score);
  const streakEdge  = norm(statsA.current_streak, statsB.current_streak);

  return (
    zonesEdge   * RULES.TIE_TOTAL_ZONES_W  +
    citiesEdge  * RULES.TIE_CITY_OWNERSHIP_W +
    recencyEdge * RULES.TIE_RUN_RECENCY_W  +
    streakEdge  * RULES.TIE_STREAK_W
  );
}

// ─── STEP 5: CITY CAPTURE CHECK ──────────────────────────────────────────────

/**
 * Checks whether the new run's polygon contains any city points.
 * In production: ST_Within(city.point, newRun.polygon)
 *
 * Returns { captured: City[], contested: City[] }
 */
function checkCityCapture(newRun, cities) {
  const captured  = [];
  const contested = [];

  cities.forEach(city => {
    // pointInPolygon is ST_Within in PostGIS
    const isEnclosed = pointInPolygon(city.point, newRun.polygon);
    if (!isEnclosed) return;

    if (city.current_owner_id === null) {
      // Unclaimed — immediate capture
      captured.push({ ...city, new_owner_id: newRun.user_id });
    } else if (city.current_owner_id !== newRun.user_id) {
      // Owned by rival — mark contested, needs 3 enclosures on different days
      contested.push({ ...city, challenger_id: newRun.user_id });
    }
    // Already owned by this user — nothing to do
  });

  return { captured, contested };
}

// ─── STEP 6: BUILD GEOJSON FOR MAP ───────────────────────────────────────────

/**
 * Converts the engine output into GeoJSON FeatureCollection
 * for Leaflet to render directly.
 *
 * Each feature has properties that drive the visual style:
 *   - owner_id, owner_name, owner_color
 *   - control_score (0–100)
 *   - status: 'owned' | 'contested' | 'expiring'
 *   - opacity, strokeWidth — precomputed so renderer is dumb
 */
function buildGeoJSON(activeRuns, conflicts, users) {
  const conflictMap = buildConflictMap(conflicts);

  const features = activeRuns.map(run => {
    const user        = users[run.user_id];
    const conflict    = conflictMap[run.id];
    const isContested = !!conflict && conflict.resolved_owner_id === null;
    const daysOld     = daysSince(run.started_at);
    const isExpiring  = daysOld >= 25; // within 5 days of 30-day expiry

    // Visual weight — stronger hold = more opaque, bolder stroke
    const controlScore = conflict
      ? (conflict.run_a_id === run.id ? conflict.control_score_a : conflict.control_score_b)
      : 80; // uncontested runs sit at 80 by default

    const opacity     = scoreToOpacity(controlScore);    // 0.15–0.45
    const strokeWidth = scoreToStrokeWidth(controlScore); // 1–3px

    return {
      type: 'Feature',
      geometry: run.polygon, // GeoJSON Polygon from PostGIS ST_AsGeoJSON()
      properties: {
        run_id:        run.id,
        owner_id:      run.user_id,
        owner_name:    user.display_name,
        owner_color:   user.color,         // assigned on signup from palette
        control_score: controlScore,
        status:        isContested ? 'contested' : isExpiring ? 'expiring' : 'owned',
        opacity,
        stroke_width:  strokeWidth,
        stroke_dash:   isExpiring ? '4 4' : null, // dashed border = expiring soon
        label:         isContested ? `${user.display_name} (contested)` : user.display_name,
        // For popup on click
        distance_km:   (run.distance_m / 1000).toFixed(1),
        run_date:      run.started_at,
        area_km2:      (run.polygon_area_m2 / 1_000_000).toFixed(2),
        expires_in_days: 30 - daysOld,
      }
    };
  });

  // Contested overlap zones get their own features — rendered on top
  const contestedFeatures = conflicts
    .filter(c => c.resolved_owner_id === null)
    .map(c => ({
      type: 'Feature',
      geometry: c.overlap_polygon,
      properties: {
        type:            'contested_overlap',
        owner_a:         users[c.run_a_owner]?.display_name,
        owner_b:         users[c.run_b_owner]?.display_name,
        color_a:         users[c.run_a_owner]?.color,
        color_b:         users[c.run_b_owner]?.color,
        score_a:         c.control_score_a,
        score_b:         c.control_score_b,
        // Renderer will stripe this with both colors
        status:          'contested',
        opacity:         0.3,
        stroke_width:    1.5,
        stroke_dash:     '6 3',
      }
    }));

  return {
    type: 'FeatureCollection',
    features: [...features, ...contestedFeatures],
  };
}

// ─── STEP 7: MAIN ENTRY POINT ─────────────────────────────────────────────────

/**
 * processNewRun — called by the Strava webhook handler after a run is stored.
 *
 * In production each step hits the DB. Here we show the logic clearly.
 * Returns a mutations object — the caller applies these atomically.
 */
/**
 * @param {string[]} faujMemberIds - user IDs in same fauj as runner (empty if no fauj)
 * @param {string[]} friendIds - user IDs who are friends with runner
 * @param {Object} faujAllyZoneCounts - { [userId]: number } nearby zone counts for fauj allies
 */
function processNewRun({ newRun, existingUserRuns, overlappingRuns, cities, userStats, users, faujMemberIds = [], friendIds = [], faujAllyZoneCounts = {} }) {
  // 1. Qualify
  const { qualified, reason } = qualifyRun(newRun);
  if (!qualified) {
    return { qualified: false, reason, mutations: {} };
  }

  // 2. Apply walk multiplier to zone contribution
  const zoneMultiplier = newRun.activity_type === 'walk' ? RULES.WALK_ZONE_MULTIPLIER : 1.0;

  // 3. Compute which runs stay active
  const { toActivate, toDeactivate } = computeActiveWindow(newRun, existingUserRuns);

  // 4. Detect + score conflicts (fauj allies' overlaps are auto-merged, not conflicted)
  const rawConflicts   = detectConflicts(newRun, overlappingRuns, faujMemberIds, friendIds);
  const scoredConflicts = rawConflicts.map(c => {
    const allyCountA = faujAllyZoneCounts[c.run_a_owner] || 0;
    const allyCountB = faujAllyZoneCounts[c.run_b_owner] || 0;
    return computeControlScore(c, userStats, allyCountA, allyCountB);
  });

  // 5. City captures
  const { captured, contested } = checkCityCapture(newRun, cities);

  // 6. Build GeoJSON for immediate map render
  const allActiveRuns = [
    ...existingUserRuns.filter(r => toActivate.includes(r.id) || (r.is_active && !toDeactivate.includes(r.id))),
    newRun,
  ];
  const geoJSON = buildGeoJSON(allActiveRuns, scoredConflicts, users);

  // 7. Return all mutations — applied atomically by caller in a single transaction
  return {
    qualified: true,
    zone_multiplier: zoneMultiplier,
    mutations: {
      runs: {
        activate:   toActivate,   // SET is_active = true
        deactivate: toDeactivate, // SET is_active = false
      },
      conflicts: {
        upsert: scoredConflicts,  // INSERT ... ON CONFLICT DO UPDATE
      },
      cities: {
        capture:  captured,   // SET current_owner_id, owner_since
        contest:  contested,  // INSERT into city_siege_log
      },
      users: {
        // Denormalised stats to update on users table
        update: [{
          id:               newRun.user_id,
          last_run_at:      newRun.started_at,
          active_run_count: toActivate.length,
        }],
      },
    },
    geojson: geoJSON, // pushed to connected clients via WebSocket
  };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function scoreToOpacity(score) {
  // 0 → 0.12 (barely visible), 100 → 0.45 (solid)
  return +(0.12 + (score / 100) * 0.33).toFixed(2);
}

function scoreToStrokeWidth(score) {
  // 0 → 1px, 100 → 3px
  return +(1 + (score / 100) * 2).toFixed(1);
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
}

function earlierExpiry(runA, runB) {
  const expiryA = new Date(new Date(runA.started_at).getTime() + RULES.WINDOW_DAYS * 86400000);
  const expiryB = new Date(new Date(runB.started_at).getTime() + RULES.WINDOW_DAYS * 86400000);
  return expiryA < expiryB ? expiryA : expiryB;
}

function buildConflictMap(conflicts) {
  const map = {};
  conflicts.forEach(c => {
    map[c.run_a_id] = c;
    map[c.run_b_id] = c;
  });
  return map;
}

function estimateOverlapArea(runA, runB) {
  // Placeholder — real value is ST_Area(ST_Intersection(a.polygon, b.polygon))
  return Math.min(runA.polygon_area_m2, runB.polygon_area_m2) * 0.3;
}

function pointInPolygon(point, polygon) {
  // Placeholder — real value is ST_Within(point, polygon) in PostGIS
  return false;
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  qualifyRun,
  computeActiveWindow,
  detectConflicts,
  computeControlScore,
  computeTiebreaker,
  checkCityCapture,
  buildGeoJSON,
  processNewRun,
  RULES,
};
