/**
 * Zamindar — Realtime Broadcast Layer
 *
 * Uses Supabase Realtime channels to push territory updates
 * to all connected browser clients after a run is processed.
 *
 * Why Supabase Realtime over raw WebSockets:
 * - Zero infrastructure — no Redis, no Socket.io server
 * - Built-in presence (who is online viewing the map)
 * - Scales with Supabase's connection pool automatically
 * - Frontend uses the same Supabase client it already has
 *
 * Channel structure:
 *   "territory:india"       — global channel, all territory updates
 *   "territory:city:{id}"   — city-specific updates (ownership changes)
 *
 * Message types sent:
 *   territory_updated — one or more polygons changed
 *   city_captured     — city ownership changed
 *   run_expired       — run deactivated, polygon should be removed
 */

const { supabase } = require('../db/client');
const { getRunsByCity } = require('../db/runs');
const { getConflictsByZone } = require('../db/conflicts');

// ── BROADCAST territory update after a run is processed ─────────────────────

/**
 * Called at the end of processStravaActivity.
 * Broadcasts territory changes to all connected clients.
 *
 * bbox is the bounding box of the new run — clients only re-render
 * what intersects their current viewport.
 */
async function broadcastTerritoryUpdate({ bbox, affectedUserIds, cityUpdates = [] }) {
  try {
    const channel = supabase.channel('territory:india');
    await channel.send({
      type: 'broadcast',
      event: 'territory_updated',
      payload: {
        bbox,
        affected_users: affectedUserIds,
        city_updates: cityUpdates,
        timestamp: new Date().toISOString(),
      },
    });
    console.log(`[realtime] broadcast territory_updated to territory:india`);
  } catch (err) {
    // Realtime failure should never block the main processing pipeline
    console.error('[realtime] broadcast failed (non-fatal):', err.message);
  }
}

// ── BROADCAST city capture ──────────────────────────────────────────────────

async function broadcastCityCapture({ cityId, cityName, newOwnerId, ownerName, ownerColor }) {
  try {
    const channel = supabase.channel('territory:india');
    await channel.send({
      type: 'broadcast',
      event: 'city_captured',
      payload: {
        city_id: cityId,
        city_name: cityName,
        new_owner_id: newOwnerId,
        owner_name: ownerName,
        owner_color: ownerColor,
        timestamp: new Date().toISOString(),
      },
    });
    console.log(`[realtime] broadcast city_captured: ${cityName} → ${ownerName}`);
  } catch (err) {
    console.error('[realtime] city broadcast failed:', err.message);
  }
}

// ── BROADCAST run expiry ────────────────────────────────────────────────────

/**
 * Called by the daily expiry job when runs are deactivated.
 * Clients remove the polygon from the map.
 */
async function broadcastRunExpiry(expiredRunIds) {
  if (!expiredRunIds.length) return;
  try {
    const channel = supabase.channel('territory:india');
    await channel.send({
      type: 'broadcast',
      event: 'runs_expired',
      payload: {
        run_ids: expiredRunIds,
        timestamp: new Date().toISOString(),
      },
    });
    console.log(`[realtime] broadcast runs_expired: ${expiredRunIds.length} runs`);
  } catch (err) {
    console.error('[realtime] expiry broadcast failed:', err.message);
  }
}

module.exports = {
  broadcastTerritoryUpdate,
  broadcastCityCapture,
  broadcastRunExpiry,
};
