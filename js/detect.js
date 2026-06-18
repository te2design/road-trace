// AI検出（実験）: 航空写真から横断歩道・停止線らしき領域を画像処理で探す
// 仕組み: 写真をつなぎ合わせ → 道路の上だけを対象に → 明るい部分を抜き出す →
//         細長い白帯をグループ化して「横断歩道らしさ」を判定する。
// 注意: 写真の解像度は約0.3〜0.6m/画素のため、幅15cmの白線は原理的に検出できない。
//       検出対象は横断歩道（縞の集まり）と停止線・大きめの標示のみ。
import * as geo from './geo.js';
import { stitchPhotoCanvas } from './dem.js';
import { MARK } from './config.js';

export async function detectInView({ viewBbox, model, onStatus = () => {} }) {
  const areaKm2 = geo.bboxAreaKm2(viewBbox);
  if (areaKm2 > 0.35) {
    throw new Error('解析範囲が広すぎます（地図をもっと拡大してから実行してください。目安: 600m四方以内）');
  }

  const photo = await stitchPhotoCanvas(viewBbox, 18, 2200, onStatus);
  const cv = photo.canvas;
  const W = cv.width, H = cv.height;
  const mpp = photo.metersPerPx;

  onStatus('道路の範囲を計算中…');
  // 道路マスク（道路の上だけを解析対象に）
  const maskCv = document.createElement('canvas');
  maskCv.width = W; maskCv.height = H;
  const mctx = maskCv.getContext('2d', { willReadFrequently: true });
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, W, H);
  mctx.fillStyle = '#fff';
  mctx.strokeStyle = '#fff';
  mctx.lineCap = 'round'; mctx.lineJoin = 'round';
  const toPx = (x, y) => { const [lat, lon] = geo.fromLocal(x, y); return photo.pxOfLatLon(lat, lon); };
  for (const r of model.roads) {
    if (!r.style.carriage) continue;
    mctx.lineWidth = (r.width + 2) / mpp;
    mctx.beginPath();
    r.pts.forEach((p, i) => {
      const [px, py] = toPx(p[0], p[1]);
      i ? mctx.lineTo(px, py) : mctx.moveTo(px, py);
    });
    mctx.stroke();
  }
  const mask = mctx.getImageData(0, 0, W, H).data;

  onStatus('明るい標示を抽出中…');
  const img = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    gray[i] = 0.299 * img[i * 4] + 0.587 * img[i * 4 + 1] + 0.114 * img[i * 4 + 2];
  }
  // 積分画像 → 局所平均
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      integ[(y + 1) * (W + 1) + (x + 1)] = integ[y * (W + 1) + (x + 1)] + row;
    }
  }
  const win = 15;
  const bin = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i * 4] < 128) continue;
      const x0 = Math.max(0, x - win), x1 = Math.min(W - 1, x + win);
      const y0 = Math.max(0, y - win), y1 = Math.min(H - 1, y + win);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integ[(y1 + 1) * (W + 1) + (x1 + 1)] - integ[y0 * (W + 1) + (x1 + 1)]
                - integ[(y1 + 1) * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      const mean = sum / n;
      if (gray[i] > mean + 28 && gray[i] > 135) bin[i] = 1;
    }
  }
  // 軽いノイズ除去（収縮→膨張）
  erodeDilate(bin, W, H, true);
  erodeDilate(bin, W, H, false);

  onStatus('候補を分類中…');
  const comps = connectedComponents(bin, W, H);

  // 成分の形状解析（PCAで向き・長さ・幅）
  // 注意: 解像度約0.5m/画素では縞同士が溶けて「1つの白帯」になるため、
  //       横断歩道は (a)縞の集まり と (b)大きな白帯ブロック の両方で探す
  const stripes = [];
  const zebraBlobs = [];
  const others = [];
  for (const c of comps) {
    const areaM = c.count * mpp * mpp;
    if (areaM < 0.4 || areaM > 280) continue;
    const sh = shapeOf(c, mpp);
    const fill = areaM / Math.max(0.01, sh.len * sh.wid); // 矩形への詰まり具合
    if (sh.len >= 1.6 && sh.len <= 10 && sh.wid >= 0.2 && sh.wid <= 1.1) stripes.push(sh);
    else if (sh.len >= 4 && sh.len <= 35 && sh.wid >= 1.8 && sh.wid <= 9 && areaM >= 8 && fill > 0.4) zebraBlobs.push(sh);
    else if (sh.len >= 2.0 && sh.len <= 8 && sh.wid > 1.1 && sh.wid <= 3.2 && areaM < 20) others.push(sh);
  }

  // 既にOSMデータから自動生成済みの横断歩道の近くは候補にしない（重複防止）
  const autoCrossingsLocal = model.crossings.filter(c => c.marked).map(c => [c.x, c.y]);
  function nearAutoCrossing(latLon, distM) {
    const p = geo.toLocal(latLon[0], latLon[1]);
    return autoCrossingsLocal.some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < distM);
  }

  // 縞のグループ化 → 横断歩道候補
  const used = new Set();
  const candidates = [];
  for (let i = 0; i < stripes.length; i++) {
    if (used.has(i)) continue;
    const groupIdx = [i];
    used.add(i);
    let added = true;
    while (added) {
      added = false;
      for (let j = 0; j < stripes.length; j++) {
        if (used.has(j)) continue;
        for (const gi of groupIdx) {
          const a = stripes[gi], b = stripes[j];
          const angDiff = angleDiff(a.angle, b.angle);
          const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
          if (angDiff < 0.35 && d < Math.max(3.5, a.len)) {
            groupIdx.push(j); used.add(j); added = true; break;
          }
        }
      }
    }
    if (groupIdx.length >= 3) {
      const g = groupIdx.map(k => stripes[k]);
      const cx = avg(g.map(s => s.cx)), cy = avg(g.map(s => s.cy));
      const angle = meanAngle(g.map(s => s.angle)); // 縞の長軸 ＝ 道路方向
      const depth = clamp(avg(g.map(s => s.len)), 2, 8);
      // 縞の並び方向（道路を渡る方向）の広がり = span
      const v = [-Math.sin(angle), Math.cos(angle)];
      const offs = g.map(s => (s.cx - cx) * v[0] + (s.cy - cy) * v[1]);
      const span = Math.max(...offs) - Math.min(...offs) + MARK.zebraStripe * 2;
      if (span >= 1.5) {
        const [aLat, aLon] = pxToLatLon(photo, cx - v[0] * span / 2, cy - v[1] * span / 2, mpp);
        const [bLat, bLon] = pxToLatLon(photo, cx + v[0] * span / 2, cy + v[1] * span / 2, mpp);
        candidates.push({
          item: { kind: 'zebra', a: [aLat, aLon], b: [bLat, bLon], props: { depth: Math.round(depth * 10) / 10 }, source: 'ai' },
          label: `横断歩道らしき縞 ×${g.length}`,
          score: Math.min(0.95, 0.4 + g.length * 0.1),
        });
      }
    } else if (groupIdx.length === 1) {
      const s = stripes[groupIdx[0]];
      if (s.len >= 3 && s.wid <= 0.8) {
        // 単独の白帯 → 停止線候補
        const u = [Math.cos(s.angle), Math.sin(s.angle)];
        const [aLat, aLon] = pxToLatLon(photo, s.cx - u[0] * s.len / 2, s.cy - u[1] * s.len / 2, mpp);
        const [bLat, bLon] = pxToLatLon(photo, s.cx + u[0] * s.len / 2, s.cy + u[1] * s.len / 2, mpp);
        candidates.push({
          item: { kind: 'band', a: [aLat, aLon], b: [bLat, bLon], props: { width: MARK.stopWidth }, source: 'ai' },
          label: '停止線らしき白帯',
          score: 0.4,
        });
      }
    }
  }
  // 白帯ブロック → 横断歩道候補（長軸＝渡る方向）
  for (const sh of zebraBlobs) {
    const u = [Math.cos(sh.angle), Math.sin(sh.angle)];
    const aLL = pxToLatLon(photo, sh.cx - u[0] * sh.len / 2, sh.cy - u[1] * sh.len / 2, mpp);
    const bLL = pxToLatLon(photo, sh.cx + u[0] * sh.len / 2, sh.cy + u[1] * sh.len / 2, mpp);
    const cLL = pxToLatLon(photo, sh.cx, sh.cy, mpp);
    if (nearAutoCrossing(cLL, 8)) continue; // 自動生成済みと重複
    candidates.push({
      item: { kind: 'zebra', a: aLL, b: bLL,
        props: { depth: clamp(Math.round(sh.wid * 10) / 10, 2, 8) }, source: 'ai' },
      label: `横断歩道らしき白帯（長さ${sh.len.toFixed(0)}m）`,
      score: Math.min(0.85, 0.5 + sh.len / 50),
    });
  }

  // 大きめの塊 → 矢印などの可能性（参考情報として面で提案）
  for (const sh of others.slice(0, 15)) {
    const u = [Math.cos(sh.angle), Math.sin(sh.angle)];
    const v = [-u[1], u[0]];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
      const px = sh.cx + u[0] * su * sh.len / 2 + v[0] * sv * sh.wid / 2;
      const py = sh.cy + u[1] * su * sh.len / 2 + v[1] * sv * sh.wid / 2;
      return pxToLatLon(photo, px, py, mpp);
    });
    candidates.push({
      item: { kind: 'polygon', latlngs: corners, props: { color: 'white' }, source: 'ai' },
      label: '標示らしき白い塊（矢印・文字など？）',
      score: 0.25,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const sliced = candidates.slice(0, 60);
  onStatus(`解析完了: 候補 ${sliced.length} 件${candidates.length > sliced.length ? `（確度上位のみ表示）` : ''}`);
  return sliced;

  // px座標はメートル換算で扱っているのでここで戻す
  function pxToLatLon(photoRef, cxM, cyM, m) {
    return photoRef.latLonOfPx(cxM / m, cyM / m);
  }
}

function erodeDilate(bin, W, H, erode) {
  const src = bin.slice();
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const s = src[i] + src[i - 1] + src[i + 1] + src[i - W] + src[i + W];
      bin[i] = erode ? (s === 5 ? 1 : 0) : (s >= 1 ? 1 : 0);
    }
  }
}

function connectedComponents(bin, W, H) {
  const labels = new Int32Array(W * H);
  const comps = [];
  const stack = [];
  let next = 0;
  for (let i = 0; i < W * H; i++) {
    if (!bin[i] || labels[i]) continue;
    next++;
    const comp = { xs: [], ys: [], count: 0 };
    stack.push(i);
    labels[i] = next;
    while (stack.length) {
      const p = stack.pop();
      const px = p % W, py = (p / W) | 0;
      comp.xs.push(px); comp.ys.push(py); comp.count++;
      if (comp.count > 20000) break;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || labels[q] || !bin[q]) continue;
        const qx = q % W;
        if (Math.abs(qx - px) > 1) continue;
        labels[q] = next;
        stack.push(q);
      }
    }
    if (comp.count >= 6) comps.push(comp);
  }
  return comps;
}

// PCAで主軸・長さ・幅（メートル）
function shapeOf(comp, mpp) {
  const n = comp.count;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += comp.xs[i]; my += comp.ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = comp.xs[i] - mx, dy = comp.ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return {
    cx: mx * mpp, cy: my * mpp,
    len: Math.sqrt(Math.max(l1, 0)) * 3.6 * mpp,
    wid: Math.sqrt(Math.max(l2, 0)) * 3.6 * mpp,
    angle,
  };
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function angleDiff(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}
function meanAngle(arr) {
  // 180°周期の平均
  let sx = 0, sy = 0;
  for (const a of arr) { sx += Math.cos(2 * a); sy += Math.sin(2 * a); }
  return Math.atan2(sy, sx) / 2;
}
