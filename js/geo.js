// 座標系と幾何計算
// ローカル座標: 範囲中心を原点、x=東(m)、y=北(m) の等距円筒近似。
// SVGは y を反転して出力、3Dは (x, 高さ, -y) に対応させる。

const DEG = Math.PI / 180;
const R = 6378137;
const M_PER_DEG = R * DEG; // ≒111319.49 m/度

let origin = { lat: 35.0, lon: 135.0, kx: M_PER_DEG * Math.cos(35 * DEG), ky: M_PER_DEG };

export function setOrigin(lat, lon) {
  origin = { lat, lon, kx: M_PER_DEG * Math.cos(lat * DEG), ky: M_PER_DEG };
}
export function getOrigin() { return origin; }

export function toLocal(lat, lon) {
  return [(lon - origin.lon) * origin.kx, (lat - origin.lat) * origin.ky];
}
export function fromLocal(x, y) {
  return [origin.lat + y / origin.ky, origin.lon + x / origin.kx]; // [lat, lon]
}

export function bboxCenter(b) { return [(b.s + b.n) / 2, (b.w + b.e) / 2]; }

export function bboxToLocal(b) {
  const [minX, minY] = toLocal(b.s, b.w);
  const [maxX, maxY] = toLocal(b.n, b.e);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function bboxAreaKm2(b) {
  const kx = M_PER_DEG * Math.cos(((b.s + b.n) / 2) * DEG);
  return ((b.e - b.w) * kx * (b.n - b.s) * M_PER_DEG) / 1e6;
}

// ---- ベクトル ----
export const vSub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const vScale = (a, s) => [a[0] * s, a[1] * s];
export const vLen = (a) => Math.hypot(a[0], a[1]);
export const vNorm = (a) => { const l = vLen(a) || 1; return [a[0] / l, a[1] / l]; };
export const rot90 = (a) => [-a[1], a[0]]; // 反時計回り90°（進行方向に対する「左」）
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const rotate = (p, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
};

export function pathLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

export function cumDist(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
  return c;
}

// 距離dの位置と接線（単位ベクトル）
export function pointAtDistance(pts, d) {
  const c = cumDist(pts);
  const L = c[c.length - 1];
  const t = Math.max(0, Math.min(L, d));
  for (let i = 1; i < pts.length; i++) {
    if (c[i] >= t) {
      const seg = c[i] - c[i - 1] || 1;
      const f = (t - c[i - 1]) / seg;
      const pt = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
                  pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      return { pt, tan: vNorm(vSub(pts[i], pts[i - 1])) };
    }
  }
  return { pt: pts[pts.length - 1], tan: vNorm(vSub(pts[pts.length - 1], pts[pts.length - 2] || pts[0])) };
}

// 距離 d0〜d1 の部分ポリライン
export function subPolyline(pts, d0, d1) {
  const c = cumDist(pts);
  const L = c[c.length - 1];
  d0 = Math.max(0, d0); d1 = Math.min(L, d1);
  if (d1 - d0 < 0.05) return null;
  const out = [pointAtDistance(pts, d0).pt];
  for (let i = 0; i < pts.length; i++) {
    if (c[i] > d0 && c[i] < d1) out.push(pts[i]);
  }
  out.push(pointAtDistance(pts, d1).pt);
  return out;
}

// おおよそstep間隔で再分割（元の頂点も保持）
export function resamplePolyline(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const segLen = dist(pts[i - 1], pts[i]);
    const n = Math.floor(segLen / step);
    for (let k = 1; k <= n; k++) {
      const f = (k * step) / segLen;
      if (f >= 0.999) break;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]);
    }
    out.push(pts[i]);
  }
  return out;
}

// 符号付きオフセット（+は進行方向左側）。鋭角はマイター制限つき。
export function offsetPolyline(pts, off) {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const segN = [];
  for (let i = 0; i < n - 1; i++) segN.push(rot90(vNorm(vSub(pts[i + 1], pts[i]))));
  const out = [];
  for (let i = 0; i < n; i++) {
    let m;
    if (i === 0) m = segN[0];
    else if (i === n - 1) m = segN[n - 2];
    else {
      m = vAdd(segN[i - 1], segN[i]);
      const l = vLen(m);
      if (l < 1e-6) { m = segN[i]; }
      else {
        const cosHalf = l / 2; // |n1+n2|/2 = cos(θ/2)
        m = vScale(m, 1 / l / Math.max(0.34, cosHalf)); // 最大約3倍に制限
        out.push(vAdd(pts[i], vScale(m, off)));
        continue;
      }
    }
    out.push(vAdd(pts[i], vScale(m, off)));
  }
  return out;
}

// 中心線＋幅 → 左右の縁（同じ頂点数）
export function polylineToStrip(pts, width) {
  return { L: offsetPolyline(pts, width / 2), R: offsetPolyline(pts, -width / 2) };
}

// 破線分割: [onの長さ, offの長さ] で部分ポリライン群に
export function dashSegments(pts, on, off) {
  const c = cumDist(pts);
  const L = c[c.length - 1];
  const segs = [];
  let d = Math.min(1.0, L * 0.1); // 端から少しずらして開始
  while (d < L) {
    const seg = subPolyline(pts, d, Math.min(L, d + on));
    if (seg) segs.push(seg);
    d += on + off;
  }
  return segs;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}
export function ensureCCW(pts) {
  return polygonArea(pts) < 0 ? pts.slice().reverse() : pts;
}
export function polygonCentroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

// ---- クリッピング ----
// 線分単位の Liang–Barsky で矩形にクリップ → 連続部分をつなぎ直す
export function clipPolylineToRect(pts, r) {
  const inside = (p) => p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minY && p[1] <= r.maxY;
  const clipSeg = (a, b) => {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy];
    const q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minY, r.maxY - a[1]];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; }
      else {
        const t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
        else { if (t < t0) return null; if (t < t1) t1 = t; }
      }
    }
    return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
  };
  const lines = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipSeg(pts[i], pts[i + 1]);
    if (!seg) { cur = null; continue; }
    const [a, b] = seg;
    if (cur && dist(cur[cur.length - 1], a) < 0.01) cur.push(b);
    else { cur = [a, b]; lines.push(cur); }
    if (!inside(pts[i + 1])) cur = null;
  }
  return lines.filter(l => pathLength(l) > 0.1);
}

// Sutherland–Hodgman でポリゴンを矩形にクリップ
export function clipPolygonToRect(pts, r) {
  const edges = [
    (p) => p[0] >= r.minX, (p) => p[0] <= r.maxX,
    (p) => p[1] >= r.minY, (p) => p[1] <= r.maxY,
  ];
  const inter = [
    (a, b) => { const t = (r.minX - a[0]) / (b[0] - a[0]); return [r.minX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (r.maxX - a[0]) / (b[0] - a[0]); return [r.maxX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (r.minY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), r.minY]; },
    (a, b) => { const t = (r.maxY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), r.maxY]; },
  ];
  let poly = pts;
  for (let e = 0; e < 4; e++) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ain = edges[e](a), bin = edges[e](b);
      if (ain) out.push(a);
      if (ain !== bin) out.push(inter[e](a, b));
    }
    poly = out;
    if (poly.length === 0) return null;
  }
  return poly.length >= 3 ? poly : null;
}

// ---- タイル座標 ----
export function lon2tx(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }
export function lat2ty(lat, z) {
  const rad = lat * DEG;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}
export function tx2lon(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
export function ty2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
export function metersPerPixel(lat, z) {
  return (156543.03392 * Math.cos(lat * DEG)) / Math.pow(2, z);
}

// ---- 平滑化 ----
export function smoothArray(arr, win) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let k = -win; k <= win; k++) {
      const j = i + k;
      if (j >= 0 && j < arr.length && Number.isFinite(arr[j])) { s += arr[j]; n++; }
    }
    out[i] = n ? s / n : 0;
  }
  return out;
}
