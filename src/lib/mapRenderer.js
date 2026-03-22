/**
 * TerraRun — Leaflet Map Renderer
 *
 * Consumes GeoJSON from the territory engine and renders it onto a Leaflet map.
 * Handles:
 *   - Territory polygons (owned, contested, expiring)
 *   - Contested overlap zones (striped dual-color)
 *   - City markers with ownership state
 *   - Real-time GeoJSON diff application via WebSocket
 *   - Viewport-aware rendering (only render what's visible)
 *   - Click/tap interactions (zone popup, rival info)
 *
 * Dependencies (loaded via CDN in HTML):
 *   - Leaflet 1.9.x
 *   - Leaflet.pattern (for contested stripe fills)
 *
 * Usage:
 *   const renderer = createMapRenderer({ containerId: 'map', currentUserId: 'user-abc' });
 *   renderer.loadInitialState(geoJSON, cities);
 *   renderer.connectWebSocket(wsUrl);
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MAP = {
  DEFAULT_CENTER:   [20.5937, 78.9629], // centre of India
  DEFAULT_ZOOM:     5,
  MIN_ZOOM:         4,
  MAX_ZOOM:         17,
  CITY_ZOOM_LEVEL:  10,                 // zoom in to this when clicking a city
  TILE_URL:         'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  TILE_ATTR:        '&copy; OpenStreetMap &copy; CARTO',
};

// Visual config per territory status — renderer stays dumb, engine decides values
const STYLE = {
  owned: {
    fillOpacity:  null,    // from feature.properties.opacity — engine computed
    weight:       null,    // from feature.properties.stroke_width
    dashArray:    null,
    opacity:      0.9,     // stroke opacity (always high)
  },
  contested: {
    fillOpacity:  0.15,
    weight:       1.5,
    dashArray:    '6 3',
    opacity:      0.8,
  },
  expiring: {
    fillOpacity:  null,    // from properties
    weight:       null,
    dashArray:    '4 4',   // dashed = expiring
    opacity:      0.6,
  },
  contested_overlap: {
    fillOpacity:  0.0,     // fill handled by stripe pattern
    weight:       1.5,
    dashArray:    '6 3',
    opacity:      0.9,
  },
};

const CITY = {
  UNCLAIMED_COLOR:   '#ffffff',
  MARKER_RADIUS:     8,
  CAPTURE_RADIUS:    6,
  PULSE_INTERVAL_MS: 2000,
};

// ─── FACTORY ─────────────────────────────────────────────────────────────────

function createMapRenderer({ containerId, currentUserId, onZoneClick, onCityClick }) {

  // ── Internal state ────────────────────────────────────────────────────────
  let map             = null;
  let ws              = null;
  let territoryLayer  = null;   // L.GeoJSON layer for all territory polygons
  let overlapLayer    = null;   // L.GeoJSON layer for contested overlaps (rendered on top)
  let cityLayer       = null;   // L.LayerGroup for city markers
  let patternCache    = {};     // stripe patterns keyed by "colorA_colorB"
  let featureMap      = {};     // run_id → Leaflet layer, for fast diff updates
  let cityMarkerMap   = {};     // city_id → Leaflet marker

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    map = L.map(containerId, {
      center:    MAP.DEFAULT_CENTER,
      zoom:      MAP.DEFAULT_ZOOM,
      minZoom:   MAP.MIN_ZOOM,
      maxZoom:   MAP.MAX_ZOOM,
      zoomControl: true,
    });

    L.tileLayer(MAP.TILE_URL, {
      attribution: MAP.TILE_ATTR,
      maxZoom:     MAP.MAX_ZOOM,
    }).addTo(map);

    // Layer order matters — territories below overlaps below cities
    territoryLayer = L.geoJSON(null, {
      style:       styleTerritory,
      onEachFeature: bindTerritoryEvents,
    }).addTo(map);

    overlapLayer = L.geoJSON(null, {
      style:       styleOverlap,
      onEachFeature: bindOverlapEvents,
    }).addTo(map);

    cityLayer = L.layerGroup().addTo(map);

    // Locate user and pan to their city on first load
    locateUser();

    return publicAPI;
  }

  // ── Geolocation ───────────────────────────────────────────────────────────

  function locateUser() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 12);
      },
      () => {} // silently fail — default India view is fine
    );
  }

  // ── Initial state load ────────────────────────────────────────────────────

  /**
   * Called once on app load with the full GeoJSON from the API.
   * Separates territory features from contested overlap features
   * and adds them to the correct layers.
   */
  function loadInitialState(geoJSON, cities = []) {
    if (!geoJSON?.features?.length) return;

    const territories = {
      type: 'FeatureCollection',
      features: geoJSON.features.filter(f => f.properties.type !== 'contested_overlap'),
    };
    const overlaps = {
      type: 'FeatureCollection',
      features: geoJSON.features.filter(f => f.properties.type === 'contested_overlap'),
    };

    // Index features by run_id for fast diff application later
    territories.features.forEach(f => {
      featureMap[f.properties.run_id] = f;
    });

    territoryLayer.addData(territories);
    overlapLayer.addData(overlaps);
    renderCities(cities);

    // If user has territory, pan to their centroid
    const myFeature = territories.features.find(f => f.properties.owner_id === currentUserId);
    if (myFeature) {
      const bounds = L.geoJSON(myFeature).getBounds();
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
    }
  }

  // ── Style functions ───────────────────────────────────────────────────────

  /**
   * Styles a territory polygon feature.
   * All visual values come from feature.properties — renderer stays dumb.
   */
  function styleTerritory(feature) {
    const p      = feature.properties;
    const status = p.status || 'owned';
    const base   = STYLE[status] || STYLE.owned;

    return {
      color:       p.owner_color,
      fillColor:   p.owner_color,
      fillOpacity: base.fillOpacity ?? p.opacity,
      weight:      base.weight     ?? p.stroke_width,
      dashArray:   base.dashArray  ?? p.stroke_dash ?? null,
      opacity:     base.opacity,
      // Highlight the current user's zones slightly
      ...(p.owner_id === currentUserId ? { weight: (base.weight ?? p.stroke_width) + 0.5 } : {}),
    };
  }

  /**
   * Styles a contested overlap zone.
   * Uses a stripe pattern blending both runners' colors.
   * Requires Leaflet.Pattern plugin.
   */
  function styleOverlap(feature) {
    const p = feature.properties;

    // Create or reuse a stripe pattern for this color pair
    const patternKey = `${p.color_a}_${p.color_b}`;
    if (!patternCache[patternKey]) {
      patternCache[patternKey] = createStripePattern(p.color_a, p.color_b);
    }

    return {
      fillPattern: patternCache[patternKey],
      fillOpacity: 1,
      color:       p.color_a,           // border uses owner_a color
      weight:      STYLE.contested_overlap.weight,
      dashArray:   STYLE.contested_overlap.dashArray,
      opacity:     STYLE.contested_overlap.opacity,
    };
  }

  /**
   * Creates a diagonal stripe SVG pattern alternating between two colors.
   * Used for contested overlap zones.
   */
  function createStripePattern(colorA, colorB) {
    // L.Pattern is from the Leaflet.Pattern plugin
    // Falls back to a semi-transparent blend if plugin not loaded
    if (typeof L.Pattern === 'undefined') {
      return null; // Leaflet ignores null fillPattern, uses fillColor instead
    }

    const pattern = new L.Pattern({ width: 10, height: 10, angle: 45 });
    pattern.addShape(new L.PatternPath({
      d:           'M0,5 L10,5',
      stroke:      true,
      color:       colorA,
      weight:      5,
      opacity:     0.7,
    }));
    pattern.addShape(new L.PatternPath({
      d:           'M0,10 L10,10',
      stroke:      true,
      color:       colorB,
      weight:      5,
      opacity:     0.7,
    }));
    pattern.addTo(map);
    return pattern;
  }

  // ── Event binding ─────────────────────────────────────────────────────────

  function bindTerritoryEvents(feature, layer) {
    const p = feature.properties;

    // Hover — highlight
    layer.on('mouseover', () => {
      layer.setStyle({ weight: (p.stroke_width || 2) + 1.5, fillOpacity: Math.min(0.6, (p.opacity || 0.25) + 0.15) });
      layer.bringToFront();
    });
    layer.on('mouseout', () => {
      territoryLayer.resetStyle(layer);
    });

    // Click — show popup
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      showTerritoryPopup(feature, layer, e.latlng);
      onZoneClick?.(p);
    });
  }

  function bindOverlapEvents(feature, layer) {
    const p = feature.properties;
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      showContestedPopup(feature, layer, e.latlng);
    });
  }

  // ── Popups ────────────────────────────────────────────────────────────────

  function showTerritoryPopup(feature, layer, latlng) {
    const p   = feature.properties;
    const isMe = p.owner_id === currentUserId;

    const html = `
      <div style="font-family:system-ui;min-width:160px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div style="width:10px;height:10px;border-radius:50%;background:${p.owner_color};flex-shrink:0"></div>
          <strong style="font-size:13px">${p.owner_name}</strong>
          ${isMe ? '<span style="font-size:10px;background:#f4651a22;color:#f4651a;padding:1px 6px;border-radius:99px">You</span>' : ''}
        </div>
        <div style="font-size:11px;color:#666;line-height:1.8">
          <div>Status: <strong>${capitalise(p.status)}</strong></div>
          <div>Area: <strong>${p.area_km2} km²</strong></div>
          <div>Run: <strong>${p.distance_km} km</strong> on ${formatDate(p.run_date)}</div>
          <div>Expires: <strong>${p.expires_in_days}d</strong></div>
        </div>
        ${p.status === 'expiring'
          ? '<div style="margin-top:6px;font-size:10px;color:#f4651a">⚠ Expiring soon — run here to refresh</div>'
          : ''}
        ${!isMe
          ? `<div style="margin-top:8px;font-size:11px;color:#888">Run a loop around this area to contest it</div>`
          : ''}
      </div>`;

    L.popup({ closeButton: false, className: 'tr-popup' })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(map);
  }

  function showContestedPopup(feature, layer, latlng) {
    const p = feature.properties;

    const html = `
      <div style="font-family:system-ui;min-width:160px">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">⚔ Contested zone</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
          <div style="width:8px;height:8px;border-radius:50%;background:${p.color_a}"></div>
          <span style="font-size:11px">${p.owner_a}</span>
          <span style="font-size:11px;color:#888">${p.score_a}/100</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div style="width:8px;height:8px;border-radius:50%;background:${p.color_b}"></div>
          <span style="font-size:11px">${p.owner_b}</span>
          <span style="font-size:11px;color:#888">${p.score_b}/100</span>
        </div>
        <div style="margin-top:8px">
          <div style="height:4px;border-radius:2px;background:#eee;overflow:hidden">
            <div style="height:100%;width:${p.score_a}%;background:${p.color_a}"></div>
          </div>
        </div>
        <div style="font-size:10px;color:#888;margin-top:4px">Run more to strengthen your claim</div>
      </div>`;

    L.popup({ closeButton: false, className: 'tr-popup' })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(map);
  }

  // ── City markers ──────────────────────────────────────────────────────────

  function renderCities(cities) {
    cityLayer.clearLayers();
    cityMarkerMap = {};

    cities.forEach(city => {
      const marker = createCityMarker(city);
      cityMarkerMap[city.id] = marker;
      cityLayer.addLayer(marker);
    });
  }

  function createCityMarker(city) {
    const color   = city.current_owner_id
      ? (city.owner_color || CITY.UNCLAIMED_COLOR)
      : CITY.UNCLAIMED_COLOR;
    const isOwned = !!city.current_owner_id;
    const isMe    = city.current_owner_id === currentUserId;

    const icon = L.divIcon({
      className: '',
      html: `
        <div style="position:relative;width:16px;height:16px">
          <div style="
            width:12px;height:12px;
            border-radius:50%;
            background:${color};
            border:2px solid rgba(255,255,255,${isOwned ? 0.9 : 0.4});
            position:absolute;top:2px;left:2px;
            ${isMe ? `box-shadow:0 0 0 3px ${color}44` : ''}
          "></div>
        </div>`,
      iconSize:   [16, 16],
      iconAnchor: [8, 8],
    });

    const marker = L.marker(city.ll, { icon, zIndexOffset: 1000 });

    // City label
    const labelIcon = L.divIcon({
      className: '',
      html: `<div style="
        font-family:system-ui;font-size:9px;font-weight:600;
        color:rgba(255,255,255,0.7);
        white-space:nowrap;margin-left:10px;margin-top:-4px;
        pointer-events:none;
        text-shadow:0 1px 2px rgba(0,0,0,0.8)
      ">${city.name}</div>`,
      iconSize:   [120, 16],
      iconAnchor: [-2, 8],
    });
    L.marker(city.ll, { icon: labelIcon, interactive: false }).addTo(cityLayer);

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      showCityPopup(city, marker);
      onCityClick?.(city);
    });

    return marker;
  }

  function showCityPopup(city, marker) {
    const isOwned = !!city.current_owner_id;
    const isMe    = city.current_owner_id === currentUserId;

    const html = `
      <div style="font-family:system-ui;min-width:170px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">${city.name}</div>
        <div style="font-size:11px;color:#666;line-height:1.8;margin-bottom:8px">
          <div>Multiplier: <strong style="color:#f4651a">${city.territory_multiplier}×</strong></div>
          <div>Capture radius: <strong>${(city.capture_radius_m / 1000).toFixed(1)} km loop</strong></div>
          ${isOwned
            ? `<div>Owner: <strong style="color:${city.owner_color}">${city.owner_name}${isMe ? ' (you)' : ''}</strong></div>`
            : '<div>Status: <strong>Unclaimed</strong></div>'
          }
        </div>
        ${isOwned && !isMe
          ? '<div style="font-size:10px;color:#888">Run a loop enclosing this city to capture it</div>'
          : ''}
        ${!isOwned
          ? '<div style="font-size:10px;color:#2ECC71">Run a loop around this city to claim the bonus!</div>'
          : ''}
        ${isMe
          ? '<div style="font-size:10px;color:#f4651a">Your stronghold — run nearby to keep it</div>'
          : ''}
      </div>`;

    marker.bindPopup(html, { closeButton: false, className: 'tr-popup' }).openPopup();
  }

  // ── Real-time WebSocket diff application ───────────────────────────────────

  /**
   * Connects to the TerraRun WebSocket server and listens for territory_update events.
   * On receiving a diff, applies only the changed features — never redraws everything.
   */
  function connectWebSocket(wsUrl) {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => console.log('[ws] connected');
    ws.onclose = () => {
      // Reconnect after 3 seconds
      console.log('[ws] disconnected — reconnecting in 3s');
      setTimeout(() => connectWebSocket(wsUrl), 3000);
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); }
      catch { return; }

      if (msg.channel !== 'territory_update') return;

      // Viewport cull — ignore updates outside what the user is currently viewing
      if (!isInViewport(msg.bbox)) return;

      applyGeoJSONDiff(msg.payload.geojson);
      updateCityMarkers(msg.payload.city_updates || []);
    };

    ws.onerror = (err) => console.error('[ws] error', err);
  }

  /**
   * Applies a GeoJSON diff to the live map.
   * Only touches features that changed — no full redraws.
   *
   * Each feature in the diff has a run_id in properties.
   * We match against featureMap and update/add/remove accordingly.
   */
  function applyGeoJSONDiff(geoJSON) {
    if (!geoJSON?.features?.length) return;

    geoJSON.features.forEach(feature => {
      const p = feature.properties;

      if (p.type === 'contested_overlap') {
        // Overlap zones — always re-render, they're small
        // Remove old ones for these run_ids, add new
        overlapLayer.clearLayers(); // simple for now — overlaps are few
        return;
      }

      const runId = p.run_id;
      if (!runId) return;

      const existingLayer = findLayerByRunId(territoryLayer, runId);

      if (existingLayer) {
        // Update existing feature — style and geometry may have changed
        existingLayer.setStyle(styleTerritory(feature));
        if (feature.geometry) {
          existingLayer.setLatLngs(geoJSONToLatLngs(feature.geometry));
        }
        // Update popup content on next click — rebind
        existingLayer.off('click');
        existingLayer.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          showTerritoryPopup(feature, existingLayer, e.latlng);
        });
      } else {
        // New feature — add to layer
        const newLayer = L.geoJSON(feature, {
          style:         () => styleTerritory(feature),
          onEachFeature: bindTerritoryEvents,
        });
        newLayer.addTo(map);
      }

      featureMap[runId] = feature;
    });

    // Re-add overlap features on top
    if (geoJSON.features.some(f => f.properties.type === 'contested_overlap')) {
      const overlaps = {
        type: 'FeatureCollection',
        features: geoJSON.features.filter(f => f.properties.type === 'contested_overlap'),
      };
      overlapLayer.clearLayers();
      overlapLayer.addData(overlaps);
    }
  }

  function updateCityMarkers(cityUpdates) {
    cityUpdates.forEach(city => {
      const marker = cityMarkerMap[city.id];
      if (!marker) return;
      // Rebuild the marker icon with new owner
      cityLayer.removeLayer(marker);
      const updated = createCityMarker(city);
      cityMarkerMap[city.id] = updated;
      cityLayer.addLayer(updated);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function isInViewport(bbox) {
    if (!bbox || !map) return true; // no bbox = show everything
    const bounds = map.getBounds();
    const bboxBounds = L.geoJSON({ type: 'Feature', geometry: bbox }).getBounds();
    return bounds.intersects(bboxBounds);
  }

  function findLayerByRunId(geoJSONLayer, runId) {
    let found = null;
    geoJSONLayer.eachLayer(layer => {
      if (layer.feature?.properties?.run_id === runId) found = layer;
    });
    return found;
  }

  function geoJSONToLatLngs(geometry) {
    if (geometry.type === 'Polygon') {
      return geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
    }
    return [];
  }

  function capitalise(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  // ── Focus helpers (called from UI) ────────────────────────────────────────

  function flyToUser(userId) {
    const feature = Object.values(featureMap).find(f => f.properties.owner_id === userId);
    if (!feature) return;
    const bounds = L.geoJSON(feature).getBounds();
    map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 13, duration: 1.2 });
  }

  function flyToCity(cityId) {
    const marker = cityMarkerMap[cityId];
    if (!marker) return;
    map.flyTo(marker.getLatLng(), MAP.CITY_ZOOM_LEVEL, { duration: 1.0 });
  }

  function resetView() {
    map.flyTo(MAP.DEFAULT_CENTER, MAP.DEFAULT_ZOOM, { duration: 1.0 });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  const publicAPI = {
    loadInitialState,
    connectWebSocket,
    flyToUser,
    flyToCity,
    resetView,
    renderCities,
    // Expose map for advanced use
    getMap: () => map,
  };

  return init();
}

// ─── CSS (injected into <head> at runtime) ────────────────────────────────────

const POPUP_CSS = `
  .tr-popup .leaflet-popup-content-wrapper {
    background: #ffffff;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    color: #1a1a2e;
  }
  .tr-popup .leaflet-popup-tip {
    background: #ffffff;
  }
  .tr-popup .leaflet-popup-content {
    margin: 12px 14px;
  }
`;

function injectCSS() {
  const style = document.createElement('style');
  style.textContent = POPUP_CSS;
  document.head.appendChild(style);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined') {
  module.exports = { createMapRenderer, injectCSS, POPUP_CSS, MAP, STYLE };
}
