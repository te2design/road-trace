// 路面標示プリミティブ（SVG・3D共通の中間表現）
//
// プリミティブの種類:
//  line:    { type, pts:[[x,y]..], width, color, dash:[on,off]|null, source }
//  band:    { type, a:[x,y], b:[x,y], width, color, source }   … 停止線など
//  zebra:   { type, center, angle(道路方向rad), span(道路幅方向の長さ), depth, stripe, gap, source }
//  stencil: { type, kind, at:[x,y], angle(進行方向rad), scale, color, source }
//  polygon: { type, pts, color, source }
// 座標はすべてローカルメートル。source は 'auto' | 'manual' | 'ai'

import { MARK, LANE_WIDTH, STENCILS } from './config.js';
import * as geo from './geo.js';

// ============ 自動生成 ============
export function generateAutoPrimitives(model) {
  const prims = [];
  for (const road of model.roads) {
    if (!road.style.markings || road.roundabout) continue;
    const intervals = markingIntervals(road);
    if (!intervals.length) continue;
    const W = road.width;

    for (const [d0, d1] of intervals) {
      const seg = geo.subPolyline(road.pts, d0, d1);
      if (!seg || seg.length < 2) continue;

      // 外側線（左右）
      if (W >= MARK.minWidthForEdge) {
        const off = road.halfW - MARK.edgeInset;
        for (const s of [+1, -1]) {
          prims.push({ type: 'line', pts: geo.offsetPolyline(seg, s * off),
            width: MARK.edgeWidth, color: 'white', dash: null, source: 'auto', tag: 'edge' });
        }
      }

      // 中央線（対面通行のみ）
      if (!road.oneway && W >= MARK.minWidthForCenter) {
        const solid = (road.lanes || 2) >= MARK.solidCenterLanes;
        prims.push({ type: 'line', pts: seg, width: MARK.centerWidth, color: 'white',
          dash: solid ? null : MARK.centerDash.slice(), source: 'auto', tag: 'center' });
      }

      // 車線境界線
      const L = road.lanes || 0;
      if (L >= 2) {
        const offs = [];
        if (road.oneway) {
          for (let k = 1; k < L; k++) offs.push((k - L / 2) * LANE_WIDTH);
        } else if (L >= 4 && L % 2 === 0) {
          for (let k = 1; k < L / 2; k++) { offs.push(k * LANE_WIDTH); offs.push(-k * LANE_WIDTH); }
        }
        for (const off of offs) {
          if (Math.abs(off) > road.halfW - 0.5) continue;
          prims.push({ type: 'line', pts: geo.offsetPolyline(seg, off),
            width: MARK.laneWidth, color: 'white', dash: MARK.laneDash.slice(), source: 'auto', tag: 'lane' });
        }
      }
    }

    // turn:lanes の矢印
    addTurnArrows(prims, road, intervals);
  }

  // 横断歩道・停止線・ダイヤマーク
  for (const c of model.crossings) {
    const road = c.road;
    const angle = Math.atan2(c.tan[1], c.tan[0]);
    if (c.marked) {
      prims.push({ type: 'zebra', center: [c.x, c.y], angle,
        span: Math.max(MARK.zebraStripe * 3, c.span), depth: MARK.zebraDepth,
        stripe: MARK.zebraStripe, gap: MARK.zebraGap, source: 'auto' });
    }
    const dirs = road.oneway ? [+1] : [+1, -1];
    const totalLen = road.cum[road.cum.length - 1];
    for (const s of dirs) {
      const t = geo.vScale(c.tan, s);
      const n = geo.rot90(t); // 進行方向の「左」（日本は左側通行 → 自分の車線は左半分）
      if (c.signal) {
        // 停止線: 横断歩道の手前2m
        const back = MARK.zebraDepth / 2 + MARK.stopOffset + MARK.stopWidth / 2;
        const pos = [c.x - t[0] * back, c.y - t[1] * back];
        let a, b;
        if (road.oneway) {
          a = [pos[0] - n[0] * (road.halfW - 0.3), pos[1] - n[1] * (road.halfW - 0.3)];
          b = [pos[0] + n[0] * (road.halfW - 0.3), pos[1] + n[1] * (road.halfW - 0.3)];
        } else {
          a = [pos[0] + n[0] * 0.15, pos[1] + n[1] * 0.15];
          b = [pos[0] + n[0] * (road.halfW - 0.3), pos[1] + n[1] * (road.halfW - 0.3)];
        }
        prims.push({ type: 'band', a, b, width: MARK.stopWidth, color: 'white', source: 'auto', tag: 'stop' });
      } else if (c.marked && MARK.diamondEnabled && road.style.markings && road.width >= 4.5) {
        // ダイヤマーク（横断歩道予告）
        const dBack = MARK.diamondBefore;
        const dAlong = c.d - s * dBack; // 進行方向の手前
        if (dAlong > 6 && dAlong < totalLen - 6) {
          const { pt, tan } = geo.pointAtDistance(road.pts, dAlong);
          const tt = geo.vScale(tan, s);
          const nn = geo.rot90(tt);
          const laneOff = road.oneway ? 0 : road.width / 4;
          const at = [pt[0] + nn[0] * laneOff, pt[1] + nn[1] * laneOff];
          prims.push({ type: 'stencil', kind: 'diamond', at, angle: Math.atan2(tt[1], tt[0]),
            scale: 1, color: 'white', source: 'auto', tag: 'diamond' });
        }
      }
    }
  }

  // 一時停止（stop標識）の停止線
  for (const sp of model.stopNodes || []) {
    const t = sp.tan;
    const n = geo.rot90(t);
    const a = [sp.x + n[0] * 0.15, sp.y + n[1] * 0.15];
    const b = [sp.x + n[0] * (sp.road.halfW - 0.2), sp.y + n[1] * (sp.road.halfW - 0.2)];
    prims.push({ type: 'band', a, b, width: MARK.stopWidth, color: 'white', source: 'auto', tag: 'stop' });
  }

  return prims;
}

// 交差点で切った「標示を描いてよい区間」のリスト
function markingIntervals(road) {
  const total = road.cum[road.cum.length - 1];
  const cuts = [...road.jcuts].sort((a, b) => a.d - b.d);
  const intervals = [];
  let prevD = 0, prevTrim = 0;
  for (const c of cuts) {
    const d0 = prevD + prevTrim, d1 = c.d - c.trim;
    if (d1 - d0 > 1.5) intervals.push([d0, d1]);
    prevD = c.d; prevTrim = c.trim;
  }
  const d0 = prevD + prevTrim;
  if (total - d0 > 1.5) intervals.push([d0, total]);
  return intervals;
}

function parseTurn(v) {
  // 'left|through|through;right' → ['left','through','through_right'] 風に正規化
  return v.split('|').map(s => {
    const parts = s.split(';').map(x => x.trim().replace(/^slight_|^sharp_/, ''));
    const has = (k) => parts.includes(k);
    if (has('through') && has('left')) return 'through_left';
    if (has('through') && has('right')) return 'through_right';
    if (has('left')) return 'left';
    if (has('right')) return 'right';
    if (has('through')) return 'through';
    return null; // none / merge等は描かない
  });
}

function addTurnArrows(prims, road, intervals) {
  if (!intervals.length) return;
  const total = road.cum[road.cum.length - 1];
  const last = intervals[intervals.length - 1];
  const first = intervals[0];

  // 前進方向（wayの向き）: way末尾の交差点手前に置く
  if (road.turnF) {
    const kinds = parseTurn(road.turnF);
    const L = kinds.length;
    const d = Math.max(first[0], last[1] - MARK.arrowBefore);
    if (d > 2) {
      const { pt, tan } = geo.pointAtDistance(road.pts, d);
      const n = geo.rot90(tan);
      const half = road.oneway ? 0 : 0; // 前進はそのまま
      kinds.forEach((kind, i) => {
        if (!kind) return;
        // turn:lanesは進行方向の左から右の順。左側通行: 左端が中央寄りでなく「左端」
        const offAcross = road.oneway
          ? (L / 2 - i - 0.5) * LANE_WIDTH
          : ((road.lanesF || Math.ceil((road.lanes || 2) / 2)) - i - 0.5) * LANE_WIDTH;
        const at = [pt[0] + n[0] * offAcross, pt[1] + n[1] * offAcross];
        prims.push({ type: 'stencil', kind, at, angle: Math.atan2(tan[1], tan[0]),
          scale: 1, color: 'white', source: 'auto', tag: 'arrow' });
      });
    }
  }
  // 後退方向: way先頭の交差点手前（向きは逆）
  if (road.turnB && !road.oneway) {
    const kinds = parseTurn(road.turnB);
    const d = Math.min(last[1], first[0] + MARK.arrowBefore);
    if (d < total - 2) {
      const { pt, tan } = geo.pointAtDistance(road.pts, d);
      const t = geo.vScale(tan, -1);
      const n = geo.rot90(t);
      const Lb = road.lanesB || Math.floor((road.lanes || 2) / 2);
      kinds.forEach((kind, i) => {
        if (!kind) return;
        const offAcross = (Lb - i - 0.5) * LANE_WIDTH;
        const at = [pt[0] + n[0] * offAcross, pt[1] + n[1] * offAcross];
        prims.push({ type: 'stencil', kind, at, angle: Math.atan2(t[1], t[0]),
          scale: 1, color: 'white', source: 'auto', tag: 'arrow' });
      });
    }
  }
}

// ============ プリミティブ → ポリゴン群（3D・SVGゼブラ用） ============

// ゼブラ → 縞の四角形リスト（日本式: 縞の長軸は車の進行方向に平行）
export function zebraRects(prim) {
  const u = [Math.cos(prim.angle), Math.sin(prim.angle)]; // 道路方向（縞の長軸）
  const v = geo.rot90(u);                                  // 道路を横切る方向（歩く方向）
  const { stripe, gap, depth, span } = prim;
  const count = Math.max(2, Math.floor((span + gap) / (stripe + gap)));
  const totalAcross = count * stripe + (count - 1) * gap;
  const rects = [];
  for (let i = 0; i < count; i++) {
    const off = -totalAcross / 2 + stripe / 2 + i * (stripe + gap);
    const c = [prim.center[0] + v[0] * off, prim.center[1] + v[1] * off];
    rects.push(rectPoly(c, u, depth, v, stripe));
  }
  return rects;
}

function rectPoly(c, u, lenU, v, lenV) {
  const hu = geo.vScale(u, lenU / 2), hv = geo.vScale(v, lenV / 2);
  return [
    [c[0] - hu[0] - hv[0], c[1] - hu[1] - hv[1]],
    [c[0] + hu[0] - hv[0], c[1] + hu[1] - hv[1]],
    [c[0] + hu[0] + hv[0], c[1] + hu[1] + hv[1]],
    [c[0] - hu[0] + hv[0], c[1] - hu[1] + hv[1]],
  ];
}

// ステンシル → ポリゴンリスト（+Y定義を進行方向angleへ回転）
export function stencilPolys(prim) {
  const shapes = STENCILS[prim.kind] || STENCILS.through;
  const rot = prim.angle - Math.PI / 2;
  return shapes.map(poly => poly.map(p =>
    geo.vAdd(prim.at, geo.rotate([p[0] * (prim.scale || 1), p[1] * (prim.scale || 1)], rot))
  ));
}

// band → 四角形
export function bandPoly(prim) {
  const u = geo.vNorm(geo.vSub(prim.b, prim.a));
  const v = geo.rot90(u);
  const c = [(prim.a[0] + prim.b[0]) / 2, (prim.a[1] + prim.b[1]) / 2];
  return rectPoly(c, u, geo.dist(prim.a, prim.b), v, prim.width);
}

// 任意プリミティブ → ポリゴンリスト（3D板ポリ化用）
export function primToPolygons(prim) {
  switch (prim.type) {
    case 'zebra': return zebraRects(prim);
    case 'stencil': return stencilPolys(prim);
    case 'band': return [bandPoly(prim)];
    case 'polygon': return [prim.pts];
    case 'line': {
      const segs = prim.dash ? geo.dashSegments(prim.pts, prim.dash[0], prim.dash[1]) : [prim.pts];
      const polys = [];
      for (const seg of segs) {
        if (seg.length < 2) continue;
        const { L, R } = geo.polylineToStrip(seg, prim.width);
        polys.push([...L, ...R.slice().reverse()]);
      }
      return polys;
    }
    default: return [];
  }
}

// ============ 手描きトレース項目 → プリミティブ ============
// トレース項目（緯度経度ベース）:
//  { kind:'line', latlngs:[[lat,lng]..], props:{width,color,dash} }
//  { kind:'zebra', a:[lat,lng], b:[lat,lng], props:{depth} }     a-b は横断歩道の両端（歩く方向）
//  { kind:'band',  a, b, props:{width} }
//  { kind:'stencil', at:[lat,lng], props:{kind, angle(rad), scale} }
//  { kind:'polygon', latlngs:[..], props:{color} }
export function traceItemsToPrimitives(items, source = 'manual') {
  const prims = [];
  for (const it of items) {
    const p = it.props || {};
    try {
      if (it.kind === 'line' && it.latlngs.length >= 2) {
        prims.push({ type: 'line', pts: it.latlngs.map(ll => geo.toLocal(ll[0], ll[1])),
          width: p.width || 0.15, color: p.color || 'white', dash: p.dash || null, source });
      } else if (it.kind === 'polygon' && it.latlngs.length >= 3) {
        prims.push({ type: 'polygon', pts: it.latlngs.map(ll => geo.toLocal(ll[0], ll[1])),
          color: p.color || 'white', source });
      } else if (it.kind === 'zebra') {
        const a = geo.toLocal(it.a[0], it.a[1]);
        const b = geo.toLocal(it.b[0], it.b[1]);
        const span = geo.dist(a, b);
        if (span < 0.5) continue;
        const v = geo.vNorm(geo.vSub(b, a)); // 歩く方向
        const u = geo.rot90(v);              // 道路方向
        prims.push({ type: 'zebra', center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
          angle: Math.atan2(u[1], u[0]), span,
          depth: p.depth || MARK.zebraDepth, stripe: MARK.zebraStripe, gap: MARK.zebraGap, source });
      } else if (it.kind === 'band') {
        prims.push({ type: 'band', a: geo.toLocal(it.a[0], it.a[1]), b: geo.toLocal(it.b[0], it.b[1]),
          width: p.width || MARK.stopWidth, color: p.color || 'white', source });
      } else if (it.kind === 'stencil') {
        prims.push({ type: 'stencil', kind: p.kind || 'through', at: geo.toLocal(it.at[0], it.at[1]),
          angle: p.angle ?? Math.PI / 2, scale: p.scale || 1, color: 'white', source });
      }
    } catch (e) { /* 1項目の不備で全体を止めない */ }
  }
  return prims;
}
