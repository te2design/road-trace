// RoadModel＋プリミティブ → レイヤー分けSVG
import { COLORS } from './config.js';
import * as geo from './geo.js';
import { zebraRects, stencilPolys, bandPoly } from './markings.js';

const r2 = (v) => Math.round(v * 100) / 100;
const P = (x, y) => `${r2(x)},${r2(-y)}`; // SVGはy反転（北を上に）

function pathFromPts(pts, close = false) {
  let d = `M${P(pts[0][0], pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${P(pts[i][0], pts[i][1])}`;
  return close ? d + 'Z' : d;
}

function colorOf(name) {
  return name === 'white' ? COLORS.white
    : name === 'yellow' ? COLORS.yellow
    : name === 'asphalt' ? COLORS.asphalt
    : name === 'green' ? COLORS.green
    : name;
}

const ROAD_ORDER = ['steps', 'path', 'footway', 'cycleway', 'track', 'pedestrian',
  'living_street', 'service', 'residential', 'unclassified', 'tertiary',
  'secondary', 'primary', 'trunk', 'motorway', 'motorway_link', 'default'];

export function renderSVG(model, autoPrims, tracePrims, opts) {
  const o = Object.assign({
    roads: true, markings: true, crosswalks: true, buildings: true,
    traces: true, classColors: false, ground: false,
  }, opts || {});

  const { minX, minY, maxX, maxY, w, h } = model.local;
  const margin = 0; // viewBoxちょうどで切る
  const clipRect = { minX: minX - 30, minY: minY - 30, maxX: maxX + 30, maxY: maxY + 30 };

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="${r2(minX)} ${r2(-maxY)} ${r2(w)} ${r2(h)}" width="${Math.round(w)}" height="${Math.round(h)}" data-meters-per-unit="1">`);
  parts.push(`<desc>Road Trace 生成SVG / 1ユニット=1m / 範囲 S${model.bbox.s} W${model.bbox.w} N${model.bbox.n} E${model.bbox.e} / データ © OpenStreetMap contributors (ODbL), 地理院タイル</desc>`);

  const layer = (id, label, body) =>
    `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${label}">${body}</g>`;

  // ---- 地面 ----
  if (o.ground) {
    parts.push(layer('ground', '地面', `<rect x="${r2(minX)}" y="${r2(-maxY)}" width="${r2(w)}" height="${r2(h)}" fill="${COLORS.ground}"/>`));
  }

  // ---- 建物 ----
  if (o.buildings) {
    let body = '';
    for (const b of model.buildings) {
      const poly = geo.clipPolygonToRect(b.pts, clipRect);
      if (!poly) continue;
      body += `<path d="${pathFromPts(poly, true)}" fill="${COLORS.building}" stroke="${COLORS.buildingLine}" stroke-width="0.3"/>`;
    }
    parts.push(layer('buildings', '建物', body));
  }

  // ---- 道路（casing→fillの2段塗りで交差点を自然につなぐ） ----
  if (o.roads) {
    const sorted = [...model.roads].sort((a, b) =>
      ROAD_ORDER.indexOf(a.cls) - ROAD_ORDER.indexOf(b.cls));
    const clipped = sorted.map(r => ({
      r, lines: geo.clipPolylineToRect(r.pts, clipRect),
    })).filter(x => x.lines.length);

    let casing = '';
    let fill = '';
    for (const { r, lines } of clipped) {
      const isPath = !r.style.carriage;
      const fillColor = o.classColors ? r.style.color
        : isPath ? COLORS.footway
        : (r.width >= 5.5 ? COLORS.asphalt : COLORS.asphaltMinor);
      for (const pts of lines) {
        const d = pathFromPts(pts);
        if (!isPath) {
          casing += `<path d="${d}" fill="none" stroke="${COLORS.casing}" stroke-width="${r2(r.width + 0.6)}" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        const cap = isPath ? 'butt' : 'round';
        const pathW = isPath ? Math.min(r.width, 2.0) : r.width;
        fill += `<path d="${d}" fill="none" stroke="${fillColor}" stroke-width="${r2(pathW)}" stroke-linecap="${cap}" stroke-linejoin="round"${isPath ? ' stroke-dasharray="3 1.6" opacity="0.85"' : ''}${r.name ? ` data-name="${escapeXml(r.name)}"` : ''}/>`;
      }
    }
    parts.push(layer('roads-casing', '道路縁', casing));
    parts.push(layer('roads-fill', '道路面', fill));
  }

  // ---- 標示（自動生成） ----
  const groups = { line: '', band: '', stencil: '', polygonG: '', zebra: '' };
  const renderPrim = (prim, acc) => {
    const col = colorOf(prim.color || 'white');
    switch (prim.type) {
      case 'line': {
        const lines = geo.clipPolylineToRect(prim.pts, clipRect);
        for (const pts of lines) {
          acc.line += `<path d="${pathFromPts(pts)}" fill="none" stroke="${col}" stroke-width="${r2(prim.width)}"${prim.dash ? ` stroke-dasharray="${prim.dash[0]} ${prim.dash[1]}"` : ''}/>`;
        }
        break;
      }
      case 'band':
        acc.band += `<path d="${pathFromPts(bandPoly(prim), true)}" fill="${col}"/>`;
        break;
      case 'stencil': {
        let d = '';
        for (const poly of stencilPolys(prim)) d += pathFromPts(poly, true);
        acc.stencil += `<path d="${d}" fill="${col}" fill-rule="nonzero"/>`;
        break;
      }
      case 'zebra': {
        let d = '';
        for (const rect of zebraRects(prim)) d += pathFromPts(rect, true);
        acc.zebra += `<path d="${d}" fill="${colorOf('white')}"/>`;
        break;
      }
      case 'polygon':
        acc.polygonG += `<path d="${pathFromPts(prim.pts, true)}" fill="${col}"/>`;
        break;
    }
  };

  if (o.markings || o.crosswalks) {
    for (const prim of autoPrims) {
      if (prim.type === 'zebra' && !o.crosswalks) continue;
      if (prim.type !== 'zebra' && !o.markings) continue;
      renderPrim(prim, groups);
    }
    if (o.markings) {
      parts.push(layer('markings', '路面標示（自動）',
        groups.polygonG + groups.line + groups.band + groups.stencil));
    }
    if (o.crosswalks) parts.push(layer('crosswalks', '横断歩道（自動）', groups.zebra));
  }

  // ---- 手描きトレース ----
  if (o.traces && tracePrims && tracePrims.length) {
    const tg = { line: '', band: '', stencil: '', polygonG: '', zebra: '' };
    for (const prim of tracePrims) renderPrim(prim, tg);
    parts.push(layer('traces', '手描きトレース',
      tg.polygonG + tg.line + tg.band + tg.stencil + tg.zebra));
  }

  // ---- 出典表記 ----
  const fs = Math.max(4, Math.min(18, h * 0.018));
  parts.push(`<g id="attribution"><text x="${r2(minX + 3)}" y="${r2(-(minY + 3))}" font-size="${r2(fs)}" fill="#666" font-family="sans-serif">© OpenStreetMap contributors ／ 地理院タイル（国土地理院）</text></g>`);

  parts.push('</svg>');
  return parts.join('\n');
}

function escapeXml(s) {
  return s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
