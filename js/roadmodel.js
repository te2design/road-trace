// OSM生データ → RoadModel（SVG・3D共通の中間モデル）
import { ROAD_STYLES, LANE_WIDTH, DEFAULT_BUILDING_HEIGHT, LEVELS_TO_METERS, MARK } from './config.js';
import * as geo from './geo.js';

function normalizeHighway(h) {
  if (ROAD_STYLES[h]) return h;
  const base = h.replace(/_link$/, '');
  if (ROAD_STYLES[base]) return base;
  return 'default';
}

export function normalizeBuildingType(tags) {
  let t = tags.building || 'yes';
  if (t === 'yes' || t === '1') {
    const a = tags.amenity;
    if (a) {
      if (['school', 'kindergarten', 'college', 'university'].includes(a)) return a;
      if (['hospital', 'clinic'].includes(a)) return 'hospital';
      if (a === 'place_of_worship') return tags.religion || 'religious';
      if (['townhall', 'courthouse', 'embassy'].includes(a)) return 'government';
      if (['library', 'community_centre'].includes(a)) return 'public';
    }
    if (tags.shop) return 'retail';
    if (tags.office) return 'office';
    if (tags.tourism === 'hotel') return 'hotel';
    if (tags.railway || tags.public_transport) return 'train_station';
  }
  return t;
}

function parseHeight(tags) {
  if (tags.height) {
    const h = parseFloat(String(tags.height).replace(/m/i, '').trim());
    if (Number.isFinite(h) && h > 0) return h;
  }
  if (tags['building:levels']) {
    const lv = parseFloat(tags['building:levels']);
    if (Number.isFinite(lv) && lv > 0) return lv * LEVELS_TO_METERS;
  }
  return DEFAULT_BUILDING_HEIGHT;
}

function wayToPts(way, nodes) {
  const pts = [];
  const ids = [];
  for (const nid of way.nodes) {
    const n = nodes.get(nid);
    if (!n) continue;
    pts.push(geo.toLocal(n.lat, n.lon));
    ids.push(nid);
  }
  return { pts, ids };
}

export function buildRoadModel(osm, bbox) {
  const [clat, clon] = geo.bboxCenter(bbox);
  geo.setOrigin(clat, clon);
  const local = geo.bboxToLocal(bbox);

  const roads = [];
  const buildings = [];
  const usedBuildingWays = new Set();

  // ---- 建物リレーション（外周のみ採用、穴は未対応） ----
  for (const rel of osm.rels) {
    if (!rel.tags || !rel.tags.building) continue;
    for (const m of rel.members || []) {
      if (m.type !== 'way' || m.role !== 'outer') continue;
      const way = osm.ways.get(m.ref);
      if (!way) continue;
      usedBuildingWays.add(way.id);
      addBuilding(way, rel.tags);
    }
  }

  function addBuilding(way, tags) {
    const { pts } = wayToPts(way, osm.nodes);
    if (pts.length < 4) return;
    let poly = pts;
    if (geo.dist(poly[0], poly[poly.length - 1]) < 0.01) poly = poly.slice(0, -1);
    if (poly.length < 3) return;
    buildings.push({
      id: way.id,
      pts: geo.ensureCCW(poly),
      height: parseHeight(tags),
      btype: normalizeBuildingType(tags),
      name: tags.name || null,
    });
  }

  // ---- 道路・建物（way） ----
  for (const way of osm.ways.values()) {
    const t = way.tags;
    if (t.highway && t.area !== 'yes') {
      const cls = normalizeHighway(t.highway);
      const style = ROAD_STYLES[cls];
      const { pts, ids } = wayToPts(way, osm.nodes);
      if (pts.length < 2) continue;
      const lanes = t.lanes ? parseInt(t.lanes, 10) : null;
      let width = null;
      if (t.width) {
        const w = parseFloat(String(t.width).replace(/m/i, '').trim());
        if (Number.isFinite(w) && w > 0.5) width = w;
      }
      if (!width) width = (lanes && style.carriage) ? lanes * LANE_WIDTH : style.width;
      const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || t.junction === 'roundabout';
      if (t.oneway === '-1') { pts.reverse(); ids.reverse(); }
      roads.push({
        id: way.id, cls, style, name: t.name || null,
        pts, nodeIds: ids,
        cum: geo.cumDist(pts),
        width, halfW: width / 2,
        lanes, oneway,
        roundabout: t.junction === 'roundabout',
        bridge: t.bridge === 'yes' || t.bridge === 'viaduct',
        tunnel: t.tunnel === 'yes',
        layer: t.layer ? parseInt(t.layer, 10) || 0 : 0,
        turnF: t['turn:lanes:forward'] || (oneway ? t['turn:lanes'] : null),
        turnB: t['turn:lanes:backward'] || null,
        lanesF: t['lanes:forward'] ? parseInt(t['lanes:forward'], 10) : null,
        lanesB: t['lanes:backward'] ? parseInt(t['lanes:backward'], 10) : null,
      });
    } else if (t.building && !usedBuildingWays.has(way.id)) {
      if (way.nodes[0] === way.nodes[way.nodes.length - 1]) addBuilding(way, t);
    }
  }

  // ---- 交差点（同じノードを通る「車道」が2本以上） ----
  const nodeToWays = new Map(); // nodeId -> Map(wayId -> halfW)
  for (const r of roads) {
    if (!r.style.carriage) continue;
    for (const nid of r.nodeIds) {
      let m = nodeToWays.get(nid);
      if (!m) { m = new Map(); nodeToWays.set(nid, m); }
      m.set(r.id, Math.max(m.get(r.id) || 0, r.halfW));
    }
  }
  const junctions = new Map(); // nodeId -> { maxHalfW, ways }
  for (const [nid, m] of nodeToWays) {
    if (m.size >= 2) {
      junctions.set(nid, { ways: m.size, maxHalfW: Math.max(...m.values()) });
    }
  }

  // ---- 各道路の交差点位置（標示の切れ目用） ----
  for (const r of roads) {
    r.jcuts = [];
    for (let i = 0; i < r.nodeIds.length; i++) {
      const j = junctions.get(r.nodeIds[i]);
      if (j) {
        const trim = j.maxHalfW * MARK.junctionTrimFactor + MARK.junctionTrimAdd;
        r.jcuts.push({ d: r.cum[i], trim });
      }
    }
  }

  // ---- 横断歩道・停止・信号ノード ----
  const crossings = [];
  const signalNodes = [];
  const stopNodes = [];
  for (const n of osm.nodes.values()) {
    if (!n.tags) continue;
    if (n.tags.highway === 'crossing') {
      const host = findHostRoad(n.id);
      if (!host) continue;
      const cVal = n.tags.crossing || '';
      const marked = !['unmarked', 'no', 'informal'].includes(cVal);
      const signal = cVal === 'traffic_signals' || n.tags['crossing:signals'] === 'yes' ||
        n.tags.traffic_signals === 'signal';
      crossings.push(makeRoadPoint(n, host, { marked, signal }));
    } else if (n.tags.highway === 'traffic_signals') {
      signalNodes.push(n);
    } else if (n.tags.highway === 'stop') {
      const host = findHostRoad(n.id);
      if (host) stopNodes.push(makeRoadPoint(n, host, {}));
    }
  }

  function findHostRoad(nodeId) {
    let best = null;
    for (const r of roads) {
      if (!r.style.carriage) continue;
      const idx = r.nodeIds.indexOf(nodeId);
      if (idx >= 0 && (!best || r.width > best.road.width)) best = { road: r, idx };
    }
    return best;
  }

  function makeRoadPoint(n, host, extra) {
    const { road, idx } = host;
    const d = road.cum[idx];
    const { pt, tan } = geo.pointAtDistance(road.pts, Math.min(d, road.cum[road.cum.length - 1] - 0.01) + 0.005);
    return {
      nodeId: n.id, road, d,
      x: pt[0], y: pt[1], tan,
      span: road.width, ...extra,
    };
  }

  // 信号ノードが近く（12m以内・同じ道路）にある横断歩道はsignal扱いに
  for (const sn of signalNodes) {
    for (const c of crossings) {
      if (c.signal) continue;
      const idx = c.road.nodeIds.indexOf(sn.id);
      if (idx >= 0 && Math.abs(c.road.cum[idx] - c.d) < 12) c.signal = true;
    }
  }

  const stats = {
    roads: roads.length,
    buildings: buildings.length,
    crossings: crossings.length,
    markedCrossings: crossings.filter(c => c.marked).length,
    junctions: junctions.size,
  };

  return { bbox, local, roads, buildings, crossings, stopNodes, junctions, stats };
}
