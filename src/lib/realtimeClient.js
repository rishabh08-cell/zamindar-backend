/**
 * Zamindar — Frontend Realtime Client
 *
 * Drop this into zamindar-mobile.html (or a separate JS file).
 * Subscribes to Supabase Realtime and applies territory diffs
 * to the live Leaflet map without a full page reload.
 *
 * Usage:
 *   const rt = createRealtimeClient({
 *     supabaseUrl:  'https://xxx.supabase.co',
 *     supabaseKey:  'your-anon-key',
 *     renderer:     mapRenderer,       // the createMapRenderer() instance
 *     currentUserId: 'user-abc',
 *     onCityCapture: (event) => {},    // optional callback
 *   });
 *   rt.connect();
 *
 * Dependencies (CDN):
 *   <script src="https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
 */

function createRealtimeClient({
  supabaseUrl,
  supabaseKey,
  renderer,
  currentUserId,
  onCityCapture,
  onRunExpired,
}) {
  // ── Init Supabase client ───────────────────────────────────────────────────
  const { createClient } = supabase; // from CDN global
  const client   = createClient(supabaseUrl, supabaseKey);
  let channel    = null;
  let connected  = false;
  let reconnectTimer = null;

  // ── Connect ────────────────────────────────────────────────────────────────

  function connect() {
    if (channel) channel.unsubscribe();

    channel = client
      .channel('territory:india')

      // ── Territory updated ─────────────────────────────────────────────────
      .on('broadcast', { event: 'territory_updated' }, ({ payload }) => {
        handleTerritoryUpdate(payload);
      })

      // ── City captured ─────────────────────────────────────────────────────
      .on('broadcast', { event: 'city_captured' }, ({ payload }) => {
        handleCityCapture(payload);
      })

      // ── Runs expired ──────────────────────────────────────────────────────
      .on('broadcast', { event: 'runs_expired' }, ({ payload }) => {
        handleRunsExpired(payload);
      })

      // ── Presence — show how many people are viewing the map ───────────────
      .on('presence', { event: 'sync' }, () => {
        const state    = channel.presenceState();
        const viewers  = Object.keys(state).length;
        updateViewerCount(viewers);
      })

      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          connected = true;
          console.log('[realtime] connected to territory:india');
          // Track this user's presence on the map
          await channel.track({
            user_id:  currentUserId,
            online_at: new Date().toISOString(),
          });
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          connected = false;
          console.warn('[realtime] disconnected — reconnecting in 5s');
          scheduleReconnect();
        }
      });
  }

  // ── Handle territory update ───────────────────────────────────────────────

  function handleTerritoryUpdate(payload) {
    if (!payload.geojson || !renderer) return;

    // Viewport check — only apply if the update affects what we're looking at
    if (!isRelevantToViewport(payload.bbox)) {
      console.log('[realtime] update outside viewport — skipping');
      return;
    }

    // Apply the GeoJSON diff to the live map
    // renderer.loadInitialState merges new features over existing ones
    renderer.loadInitialState(payload.geojson);

    // If this update affected the current user — show a notification
    if (payload.affected_users?.includes(currentUserId)) {
      showToast('Your zameen was updated', 'info');
    }

    // Check if a rival just cut into our territory
    const rivalCut = payload.geojson.features.some(f =>
      f.properties.type === 'contested_overlap' &&
      (f.properties.owner_a === currentUserId || f.properties.owner_b === currentUserId) &&
      payload.affected_users?.some(id => id !== currentUserId)
    );

    if (rivalCut) {
      showToast('⚔ Someone is challenging your zameen!', 'warning');
    }
  }

  // ── Handle city capture ───────────────────────────────────────────────────

  function handleCityCapture(payload) {
    // Update the city marker on the map
    renderer?.renderCities?.([{
      id:           payload.city_id,
      name:         payload.city_name,
      current_owner_id: payload.new_owner_id,
      owner_name:   payload.owner_name,
      owner_color:  payload.owner_color,
    }]);

    // Notify if it affects the current user
    if (payload.new_owner_id === currentUserId) {
      showToast(`🏙 You captured ${payload.city_name}!`, 'success');
    } else if (payload.previous_owner_id === currentUserId) {
      showToast(`${payload.owner_name} took ${payload.city_name} from you`, 'warning');
    }

    onCityCapture?.(payload);
  }

  // ── Handle run expiry ─────────────────────────────────────────────────────

  function handleRunsExpired(payload) {
    // Remove expired polygons from the map
    // In production: renderer would have a removeFeatures(runIds) method
    // For now, trigger a bbox refresh for the affected area
    console.log('[realtime] runs expired:', payload.run_ids);
    onRunExpired?.(payload.run_ids);
  }

  // ── Viewport relevance check ──────────────────────────────────────────────

  function isRelevantToViewport(bbox) {
    if (!bbox || !renderer) return true;
    try {
      const map    = renderer.getMap();
      const bounds = map.getBounds();
      return !(
        bbox.maxLat < bounds.getSouth() ||
        bbox.minLat > bounds.getNorth() ||
        bbox.maxLng < bounds.getWest()  ||
        bbox.minLng > bounds.getEast()
      );
    } catch {
      return true; // if we can't check, show it
    }
  }

  // ── Viewer count ──────────────────────────────────────────────────────────

  function updateViewerCount(count) {
    const el = document.getElementById('live-txt');
    if (el) el.textContent = `${count} zamindar${count !== 1 ? 's' : ''} watching`;
  }

  // ── Toast notifications ───────────────────────────────────────────────────

  function showToast(message, type = 'info') {
    // Reuse existing toast if present, or create one
    let toast = document.getElementById('rt-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rt-toast';
      toast.style.cssText = `
        position:fixed; bottom:calc(56px + env(safe-area-inset-bottom) + 12px);
        left:50%; transform:translateX(-50%) translateY(8px);
        background:rgba(26,18,8,0.97);
        border:1px solid var(--border-bright);
        border-radius:10px; padding:10px 18px;
        font-family:'Outfit',sans-serif; font-size:12px;
        color:var(--cream); white-space:nowrap;
        opacity:0; transition:all .3s; z-index:2000;
        pointer-events:none;
      `;
      document.body.appendChild(toast);
    }

    const colors = {
      info:    'var(--border-bright)',
      success: 'rgba(94,189,138,0.6)',
      warning: 'rgba(232,105,10,0.6)',
    };
    toast.style.borderColor = colors[type] || colors.info;
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(8px)';
    }, 3000);
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log('[realtime] attempting reconnect...');
      connect();
    }, 5000);
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    channel?.unsubscribe();
    connected = false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return { connect, disconnect, isConnected: () => connected };
}
