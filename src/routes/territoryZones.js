// src/routes/territoryZones.js
// API routes for territory sub-zones, defence scores, attacks, and patrols

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const {
  computeDefenceScore,
  applyErosion,
  applyPatrol,
  MIN_ZONE_AREA_M2,
  EROSION_FACTOR,
} = require('../services/defenceService');

// GET /api/territory-zones/:zoneId
// Returns all sub-zones for a parent zone with current defence scores
router.get('/:zoneId', requireAuth, async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { rows } = await db.query(`
      SELECT id, parent_zone_id, owner_user_id,
             ST_AsGeoJSON(zone_polygon)::json AS zone_polygon,
             area_m2, base_defence, last_patrolled_at, half_life_days,
             created_at, updated_at
      FROM territory_zones
      WHERE parent_zone_id = $1 AND is_active = TRUE
      ORDER BY created_at ASC
    `, [zoneId]);

    const zones = rows.map(z => ({
      ...z,
      current_defence: computeDefenceScore(z.base_defence, z.last_patrolled_at, z.half_life_days),
    }));
    res.json({ zones });
  } catch (err) {
    console.error('GET /territory-zones/:zoneId error:', err);
    res.status(500).json({ error: 'Failed to fetch territory zones' });
  }
});

// GET /api/territory-zones/user/:userId
// Returns all sub-zones owned by a user with live defence scores
router.get('/user/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { rows } = await db.query(`
      SELECT tz.id, tz.parent_zone_id, tz.owner_user_id,
             ST_AsGeoJSON(tz.zone_polygon)::json AS zone_polygon,
             tz.area_m2, tz.base_defence, tz.last_patrolled_at, tz.half_life_days,
             tz.created_at
      FROM territory_zones tz
      WHERE tz.owner_user_id = $1 AND tz.is_active = TRUE
      ORDER BY tz.created_at DESC
    `, [userId]);

    const zones = rows.map(z => ({
      ...z,
      current_defence: computeDefenceScore(z.base_defence, z.last_patrolled_at, z.half_life_days),
    }));
    res.json({ zones });
  } catch (err) {
    console.error('GET /territory-zones/user/:userId error:', err);
    res.status(500).json({ error: 'Failed to fetch user territory zones' });
  }
});

// POST /api/territory-zones/attack
// Process an attack: a closed run that intersects an existing territory
// Body: { runId, enclosedPolygon (GeoJSON) }
router.post('/attack', requireAuth, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { runId, enclosedPolygon } = req.body;
    const attackerUserId = req.user.id;

    if (!runId || !enclosedPolygon) {
      return res.status(400).json({ error: 'runId and enclosedPolygon required' });
    }

    await client.query('BEGIN');
    const enclosedGeoJSON = JSON.stringify(enclosedPolygon);

    // Find all territory_zones that intersect the attacker's enclosed polygon
    const { rows: intersecting } = await client.query(`
      SELECT tz.id, tz.parent_zone_id, tz.owner_user_id,
             tz.base_defence, tz.last_patrolled_at, tz.half_life_days, tz.area_m2,
             ST_AsGeoJSON(tz.zone_polygon)::json AS zone_polygon,
             ST_AsGeoJSON(ST_Intersection(tz.zone_polygon, ST_GeomFromGeoJSON($1)))::json AS intersection_polygon,
             ST_Area(ST_Intersection(tz.zone_polygon, ST_GeomFromGeoJSON($1))::geography) AS intersection_area_m2,
             ST_Within(tz.zone_polygon, ST_GeomFromGeoJSON($1)) AS fully_contained
      FROM territory_zones tz
      WHERE tz.owner_user_id != $2
        AND tz.is_active = TRUE
        AND ST_Intersects(tz.zone_polygon, ST_GeomFromGeoJSON($1))
        AND ST_Area(ST_Intersection(tz.zone_polygon, ST_GeomFromGeoJSON($1))::geography) > $3
    `, [enclosedGeoJSON, attackerUserId, MIN_ZONE_AREA_M2]);

    const results = [];

    for (const zone of intersecting) {
      const currentDefence = computeDefenceScore(zone.base_defence, zone.last_patrolled_at, zone.half_life_days);
      const { newBaseDefence, triggersTransfer } = applyErosion(currentDefence, EROSION_FACTOR);

      // Log the attack
      await client.query(`
        INSERT INTO zone_attacks (
          territory_zone_id, parent_zone_id, attacker_user_id, run_id,
          erosion_applied, defence_before, defence_after,
          attack_polygon, resulted_in_transfer
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,ST_GeomFromGeoJSON($8),$9)
      `, [zone.id, zone.parent_zone_id, attackerUserId, runId,
          EROSION_FACTOR, currentDefence, newBaseDefence,
          JSON.stringify(zone.intersection_polygon), triggersTransfer]);

      if (triggersTransfer) {
        if (zone.fully_contained) {
          // Full takeover
          await client.query(`
            UPDATE territory_zones
            SET owner_user_id=$1, base_defence=1.0, last_patrolled_at=NOW(), updated_at=NOW()
            WHERE id=$2
          `, [attackerUserId, zone.id]);
          await checkAndTransferParent(client, zone.parent_zone_id, attackerUserId);
          results.push({ zoneId: zone.id, action: 'full_takeover' });
        } else {
          // Partial split
          await client.query('UPDATE territory_zones SET is_active=FALSE, updated_at=NOW() WHERE id=$1', [zone.id]);

          await client.query(`
            INSERT INTO territory_zones (parent_zone_id, owner_user_id, zone_polygon, area_m2, base_defence, last_patrolled_at, half_life_days)
            SELECT $1,$2,ST_Intersection(zone_polygon,ST_GeomFromGeoJSON($3)),
                   ST_Area(ST_Intersection(zone_polygon,ST_GeomFromGeoJSON($3))::geography),
                   1.0,NOW(),$4
            FROM territory_zones WHERE id=$5
          `, [zone.parent_zone_id, attackerUserId, enclosedGeoJSON, zone.half_life_days, zone.id]);

          await client.query(`
            INSERT INTO territory_zones (parent_zone_id, owner_user_id, zone_polygon, area_m2, base_defence, last_patrolled_at, half_life_days)
            SELECT $1,$2,ST_Difference(zone_polygon,ST_GeomFromGeoJSON($3)),
                   ST_Area(ST_Difference(zone_polygon,ST_GeomFromGeoJSON($3))::geography),
                   $4,NOW(),$5
            FROM territory_zones WHERE id=$6
          `, [zone.parent_zone_id, zone.owner_user_id, enclosedGeoJSON, newBaseDefence, zone.half_life_days, zone.id]);

          results.push({ zoneId: zone.id, action: 'split' });
        }
      } else {
        // Defence held - just erode
        await client.query(`
          UPDATE territory_zones SET base_defence=$1, last_patrolled_at=NOW(), updated_at=NOW() WHERE id=$2
        `, [newBaseDefence, zone.id]);
        results.push({ zoneId: zone.id, action: 'eroded', newDefence: newBaseDefence });
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /territory-zones/attack error:', err);
    res.status(500).json({ error: 'Attack processing failed' });
  } finally {
    client.release();
  }
});

// POST /api/territory-zones/patrol
// Process a patrol: owner runs their own territory boundary
// Body: { runId, enclosedPolygon (GeoJSON) }
router.post('/patrol', requireAuth, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { runId, enclosedPolygon } = req.body;
    const patrollerUserId = req.user.id;

    if (!runId || !enclosedPolygon) {
      return res.status(400).json({ error: 'runId and enclosedPolygon required' });
    }

    await client.query('BEGIN');
    const enclosedGeoJSON = JSON.stringify(enclosedPolygon);

    const { rows: patrolled } = await client.query(`
      SELECT id, parent_zone_id, base_defence, last_patrolled_at, half_life_days
      FROM territory_zones
      WHERE owner_user_id=$1 AND is_active=TRUE
        AND ST_Intersects(zone_polygon, ST_GeomFromGeoJSON($2))
    `, [patrollerUserId, enclosedGeoJSON]);

    const results = [];

    for (const zone of patrolled) {
      const defenceBefore = computeDefenceScore(zone.base_defence, zone.last_patrolled_at, zone.half_life_days);
      const { newBaseDefence, newLastPatrolledAt } = applyPatrol();

      await client.query(`
        UPDATE territory_zones SET base_defence=$1, last_patrolled_at=$2, updated_at=NOW() WHERE id=$3
      `, [newBaseDefence, newLastPatrolledAt, zone.id]);

      await client.query(`
        INSERT INTO zone_patrols (
          territory_zone_id, parent_zone_id, patroller_user_id, run_id,
          patrol_polygon, coverage_pct, defence_before, defence_after
        ) VALUES ($1,$2,$3,$4,ST_GeomFromGeoJSON($5),1.0,$6,$7)
      `, [zone.id, zone.parent_zone_id, patrollerUserId, runId, enclosedGeoJSON, defenceBefore, newBaseDefence]);

      results.push({ zoneId: zone.id, defenceBefore, defenceAfter: newBaseDefence });
    }

    await client.query('COMMIT');
    res.json({ success: true, patrolledCount: patrolled.length, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /territory-zones/patrol error:', err);
    res.status(500).json({ error: 'Patrol processing failed' });
  } finally {
    client.release();
  }
});

// GET /api/territory-zones/:zoneId/attacks
router.get('/:zoneId/attacks', requireAuth, async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { rows } = await db.query(`
      SELECT za.id, za.territory_zone_id, za.attacker_user_id,
             u.display_name AS attacker_name,
             za.erosion_applied, za.defence_before, za.defence_after,
             za.resulted_in_transfer, za.attacked_at
      FROM zone_attacks za
      JOIN users u ON u.id = za.attacker_user_id
      WHERE za.territory_zone_id=$1
      ORDER BY za.attacked_at DESC LIMIT 50
    `, [zoneId]);
    res.json({ attacks: rows });
  } catch (err) {
    console.error('GET /territory-zones/:zoneId/attacks error:', err);
    res.status(500).json({ error: 'Failed to fetch attack history' });
  }
});

async function checkAndTransferParent(client, parentZoneId, newOwnerId) {
  const { rows: [{ all_transferred }] } = await client.query(`
    SELECT BOOL_AND(owner_user_id=$1) AS all_transferred
    FROM territory_zones WHERE parent_zone_id=$2 AND is_active=TRUE
  `, [newOwnerId, parentZoneId]);
  if (all_transferred) {
    await client.query('UPDATE zones SET user_id=$1, updated_at=NOW() WHERE id=$2', [newOwnerId, parentZoneId]);
  }
}

module.exports = router;
