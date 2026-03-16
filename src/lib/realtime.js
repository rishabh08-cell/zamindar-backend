/**
 * Zamindar — Realtime Broadcast Layer
 *
 * Uses Supabase Realtime channels to push territory updates
 * to all connected browser clients after a run is processed.
 *
 * Why Supabase Realtime over raw WebSockets:
 *   - Zero infrastructure — no Redis, no Socket.io server
 *   - Built-in presence (who is online viewing the map)
 *   - Scales with Supabase's connection pool automatically
 *   - Frontend uses the same Supabase client it already has
 *
 * Channel structure:
 *   "territory:india"    — global channel, all territory updates
 *   "territory:city:{id}" — city-specific updates (ownership changes)
 *
 * Message types sent:
 *   territory_updated   — one or more polygons changed
 *   city_captured       — city ownership changed
 *   run_expired         — run deactivated, polygon should be removed
 */

import { supabase } from '../db/client.js';
import { getMapGeoJSON }       from '../db/runs.js';
import { getContestedGeoJSON } from '../db/conflicts.js';

// ── BROADCAST territory update after a run is processed ─────────────────────

/**
 * Called at the end of processStravaActivity.
 * Fetches the fresh GeoJSON for the affected area and broadcasts to clients.
 *
 * bbox is the bounding box of the new run — clients only re-render
 * what intersects their current viewport.
 */
export async function broadcastTerritoryUpdate({ bbox, affectedUserIds, cityUpdates = [] }) {
  try {
    // Fetch fresh GeoJSON for the affected bounding box
    const [territories, contested] = await Promise.all([
      getMapGeoJSON(bbox),
      getContestedGeoJSON(bbox),
    ]);

    const geojson = {
      type: 'FeatureCollection',
      features: [...territories.features, ...contested],
    };

    // Broadcast to the global India channel
    // All connected clients receive this and apply viewport filtering client-side
    const channel = supabase.channel('territory:india');
    await channel.send({
      type:    'broadcast',
      event:   'territory_updated',
      payload: {
        bbox,                    // clients filter by this
        geojson,                 // fresh GeoJSON for the affected area
        affected_users: affectedUserIds,
        city_updates:   cityUpdates,
        timestamp:      new Date().toISOString(),
      },
    });

    console.log(`[realtime] broadcast territory_updated to territory:india`);
  } catch (err) {
    // Realtime failure should never block the main processing pipeline
    console.error('[realtime] broadcast failed (non-fatal):', err.message);
  }
}

// ── BROADCAST city capture ────────────────────────────────────────────────────

export async function broadcastCityCapture({ cityId, cityName, newOwnerId, ownerName, ownerColor }) {
  try {
    const channel = supabase.channel('territory:india');
    await channel.send({
      type:  'broadcast',
      event: 'city_captured',
      payload: {
        city_id:    cityId,
        city_name:  cityName,
        new_owner_id: newOwnerId,
        owner_name:   ownerName,
        owner_color:  ownerColor,
        timestamp:    new Date().toISOString(),
      },
    });
    console.log(`[realtime] broadcast city_captured: ${cityName} → ${ownerName}`);
  } catch (err) {
    console.error('[realtime] city broadcast failed:', err.message);
  }
}

// ── BROADCAST run expiry ──────────────────────────────────────────────────────

/**
 * Called by the daily expiry job when runs are deactivated.
 * Clients remove the polygon from the map.
 */
export async function broadcastRunExpiry(expiredRunIds) {
  if (!expiredRunIds.length) return;
  try {
    const channel = supabase.channel('territory:india');
    await channel.send({
      type:  'broadcast',
      event: 'runs_expired',
      payload: {
        run_ids:   expiredRunIds,
        timestamp: new Date().toISOString(),
      },
    });
    console.log(`[realtime] broadcast runs_expired: ${expiredRunIds.length} runs`);
  } catch (err) {
    console.error('[realtime] expiry broadcast failed:', err.message);
  }
}
