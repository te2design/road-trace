// Leaflet地図・背景切替・範囲選択・写真ズレ補正
import * as L from 'leaflet';
import { TILE_LAYERS } from './config.js';
import * as geo from './geo.js';

export function createMapUI({ onBboxChange, onStatus }) {
  const map = L.map('map', { zoomControl: true, doubleClickZoom: false })
    .setView([35.68613, 139.7305], 16);

  // 写真専用ペイン（ズレ補正でこのペインだけ平行移動する）
  map.createPane('photoPane');
  map.getPane('photoPane').style.zIndex = 205;

  const layers = {};
  for (const [key, def] of Object.entries(TILE_LAYERS)) {
    layers[key] = L.tileLayer(def.url, {
      attribution: def.attribution,
      maxZoom: 19,
      maxNativeZoom: def.maxZoom,
      pane: key === 'gsi_photo' ? 'photoPane' : 'tilePane',
      crossOrigin: 'anonymous',
    });
  }
  let currentBase = 'gsi_photo';
  layers[currentBase].addTo(map);

  function setBase(key) {
    if (!layers[key] || key === currentBase) return;
    map.removeLayer(layers[currentBase]);
    layers[key].addTo(map);
    currentBase = key;
    applyPhotoOffset();
  }

  // ---------- 写真ズレ補正 ----------
  let photoOffset = { dx: 0, dy: 0 }; // メートル（東・北が正）
  function applyPhotoOffset() {
    const pane = map.getPane('photoPane');
    if (!pane) return;
    const mpp = geo.metersPerPixel(map.getCenter().lat, map.getZoom());
    pane.style.left = `${photoOffset.dx / mpp}px`;
    pane.style.top = `${-photoOffset.dy / mpp}px`;
  }
  map.on('zoomend', applyPhotoOffset);
  function setPhotoOffset(dx, dy) { photoOffset = { dx, dy }; applyPhotoOffset(); }
  function getPhotoOffset() { return { ...photoOffset }; }

  // 2点クリック校正: 1点目=正しい位置(OSM線上)、2点目=写真上の同じ場所
  function startOffsetCal(done) {
    onStatus('ズレ補正: ①OSMの道路線の上で「正しい位置」をクリック');
    const picks = [];
    map.getContainer().classList.add('drawing');
    const h = (e) => {
      picks.push(e.latlng);
      if (picks.length === 1) {
        onStatus('ズレ補正: ②航空写真上の「同じ場所」をクリック');
      } else {
        map.off('click', h);
        map.getContainer().classList.remove('drawing');
        const lat = picks[0].lat;
        const kx = 111319.49 * Math.cos(lat * Math.PI / 180);
        const dx = (picks[0].lng - picks[1].lng) * kx + photoOffset.dx;
        const dy = (picks[0].lat - picks[1].lat) * 111319.49 + photoOffset.dy;
        setPhotoOffset(dx, dy);
        done(dx, dy);
      }
    };
    map.on('click', h);
  }

  // ---------- 範囲選択 ----------
  let rect = null;
  let handles = [];
  let suppress = false;

  function bboxFromRect() {
    if (!rect) return null;
    const b = rect.getBounds();
    return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  }

  function drawRect(bbox, fire = true) {
    const bounds = L.latLngBounds([bbox.s, bbox.w], [bbox.n, bbox.e]);
    if (!rect) {
      rect = L.rectangle(bounds, { color: '#1976d2', weight: 2, fillOpacity: 0.04, interactive: false });
      rect.addTo(map);
    } else rect.setBounds(bounds);
    updateHandles();
    if (fire && !suppress) onBboxChange(bbox);
  }

  function updateHandles() {
    handles.forEach(h => map.removeLayer(h));
    handles = [];
    if (!rect) return;
    const b = rect.getBounds();
    const corners = [
      [b.getSouth(), b.getWest()], [b.getSouth(), b.getEast()],
      [b.getNorth(), b.getWest()], [b.getNorth(), b.getEast()],
    ];
    corners.forEach((c, idx) => {
      const m = L.marker(c, {
        draggable: true,
        icon: L.divIcon({ className: 'bbox-handle' }),
      });
      m.on('drag', () => {
        const ll = m.getLatLng();
        const cur = rect.getBounds();
        // idx: 0=SW 1=SE 2=NW 3=NE → 対角を固定
        const fixed = [
          [cur.getNorth(), cur.getEast()], [cur.getNorth(), cur.getWest()],
          [cur.getSouth(), cur.getEast()], [cur.getSouth(), cur.getWest()],
        ][idx];
        rect.setBounds(L.latLngBounds([ll.lat, ll.lng], fixed));
      });
      m.on('dragend', () => { updateHandles(); onBboxChange(bboxFromRect()); });
      m.addTo(map);
      handles.push(m);
    });
  }

  function startRectDraw() {
    onStatus('範囲指定: 地図上でドラッグして枠を描いてください');
    map.dragging.disable();
    map.getContainer().classList.add('drawing');
    let startLL = null;
    const onDown = (e) => { startLL = e.latlng; };
    const onMove = (e) => {
      if (!startLL) return;
      suppress = true;
      drawRect({
        s: Math.min(startLL.lat, e.latlng.lat), n: Math.max(startLL.lat, e.latlng.lat),
        w: Math.min(startLL.lng, e.latlng.lng), e: Math.max(startLL.lng, e.latlng.lng),
      }, false);
      suppress = false;
    };
    const onUp = () => {
      map.off('mousedown', onDown); map.off('mousemove', onMove); map.off('mouseup', onUp);
      map.dragging.enable();
      map.getContainer().classList.remove('drawing');
      if (rect) onBboxChange(bboxFromRect());
      onStatus('');
    };
    map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
  }

  function setBbox(bbox, { pan = false } = {}) {
    suppress = true;
    drawRect(bbox, false);
    suppress = false;
    geo.setOrigin((bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2);
    if (pan) map.fitBounds(L.latLngBounds([bbox.s, bbox.w], [bbox.n, bbox.e]), { padding: [30, 30] });
  }

  // ---------- 取得済み道路のオーバーレイ（トレースの下敷き） ----------
  let roadsOverlay = null;
  function setRoadsOverlay(model) {
    if (roadsOverlay) { map.removeLayer(roadsOverlay); roadsOverlay = null; }
    if (!model) return;
    const lines = model.roads.filter(r => r.style.carriage).map(r =>
      L.polyline(r.pts.map(p => geo.fromLocal(p[0], p[1])),
        { color: '#00e5ff', weight: 1.2, opacity: 0.75, interactive: false }));
    roadsOverlay = L.layerGroup(lines).addTo(map);
  }

  // ---------- 検索結果のピン ----------
  let searchMarker = null;
  function flyTo(lat, lon, label) {
    map.setView([lat, lon], 17);
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker([lat, lon], {
      icon: L.divIcon({ className: 'search-pin', html: '📍', iconSize: [24, 24], iconAnchor: [12, 24] }),
    }).addTo(map);
    if (label) searchMarker.bindTooltip(label, { direction: 'top', offset: [0, -22] }).openTooltip();
  }
  function clearSearchMarker() { if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; } }

  return {
    map, setBase, setBbox, getBbox: bboxFromRect, startRectDraw,
    setPhotoOffset, getPhotoOffset, startOffsetCal, setRoadsOverlay,
    flyTo, clearSearchMarker,
  };
}
