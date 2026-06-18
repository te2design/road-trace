// 地理院 標高タイル（PNG）と航空写真タイルの取得
// 標高デコード: x = R<<16 | G<<8 | B
//   x < 2^23 → h = 0.01x [m] / x = 2^23 → 無効値 / x > 2^23 → h = 0.01(x - 2^24)
import { DEM_SOURCES, PHOTO_TILE_URL } from './config.js';
import * as geo from './geo.js';

const INVALID = 8388608; // 2^23
const tileCache = new Map(); // "z/x/y" → Float32Array(256*256) | 'missing'

async function loadDemTile(srcIdx, tx, ty) {
  const src = DEM_SOURCES[srcIdx];
  const key = `${srcIdx}/${tx}/${ty}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const url = src.url.replace('{z}', src.z).replace('{x}', tx).replace('{y}', ty);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(256 * 256);
    for (let i = 0; i < 256 * 256; i++) {
      const x = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
      out[i] = x === INVALID ? NaN : x < INVALID ? x * 0.01 : (x - 16777216) * 0.01;
    }
    tileCache.set(key, out);
    return out;
  } catch (e) {
    tileCache.set(key, 'missing');
    return 'missing';
  }
}

// bboxを覆う標高サンプラを作る
export async function createDemSampler(bbox, onStatus = () => {}) {
  const jobs = [];
  const loaded = []; // {srcIdx, z, tx, ty, data}
  for (let srcIdx = 0; srcIdx < DEM_SOURCES.length; srcIdx++) {
    const z = DEM_SOURCES[srcIdx].z;
    const tx0 = Math.floor(geo.lon2tx(bbox.w, z)), tx1 = Math.floor(geo.lon2tx(bbox.e, z));
    const ty0 = Math.floor(geo.lat2ty(bbox.n, z)), ty1 = Math.floor(geo.lat2ty(bbox.s, z));
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        jobs.push(loadDemTile(srcIdx, tx, ty).then(d => {
          if (d !== 'missing') loaded.push({ srcIdx, z, tx, ty, data: d });
        }));
      }
    }
    onStatus(`標高データを取得中…（ズーム${z}）`);
    await Promise.all(jobs.splice(0));
    // 第1候補で全タイル取れていれば第2候補は不要
    const z0 = DEM_SOURCES[0].z;
    const need = (Math.floor(geo.lon2tx(bbox.e, z0)) - Math.floor(geo.lon2tx(bbox.w, z0)) + 1) *
                 (Math.floor(geo.lat2ty(bbox.s, z0)) - Math.floor(geo.lat2ty(bbox.n, z0)) + 1);
    if (srcIdx === 0 && loaded.filter(t => t.srcIdx === 0).length === need) break;
  }

  const index = new Map();
  for (const t of loaded) index.set(`${t.srcIdx}/${t.tx}/${t.ty}`, t);

  function rawAt(srcIdx, gx, gy) {
    // gx,gy = グローバルピクセル座標（z固有）
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = index.get(`${srcIdx}/${tx}/${ty}`);
    if (!t) return NaN;
    const px = Math.min(255, Math.max(0, Math.round(gx - tx * 256)));
    const py = Math.min(255, Math.max(0, Math.round(gy - ty * 256)));
    return t.data[py * 256 + px];
  }

  function sampleSrc(srcIdx, lat, lon) {
    const z = DEM_SOURCES[srcIdx].z;
    const gx = geo.lon2tx(lon, z) * 256;
    const gy = geo.lat2ty(lat, z) * 256;
    const x0 = Math.floor(gx - 0.5), y0 = Math.floor(gy - 0.5);
    const fx = gx - 0.5 - x0, fy = gy - 0.5 - y0;
    const v00 = rawAt(srcIdx, x0, y0), v10 = rawAt(srcIdx, x0 + 1, y0);
    const v01 = rawAt(srcIdx, x0, y0 + 1), v11 = rawAt(srcIdx, x0 + 1, y0 + 1);
    const vals = [v00, v10, v01, v11];
    const ok = vals.filter(Number.isFinite);
    if (!ok.length) return NaN;
    if (ok.length < 4) {
      // 端や水面は有効値の平均で代用
      return ok.reduce((a, b) => a + b, 0) / ok.length;
    }
    const a = v00 * (1 - fx) + v10 * fx;
    const b = v01 * (1 - fx) + v11 * fx;
    return a * (1 - fy) + b * fy;
  }

  function heightAt(lat, lon) {
    for (let s = 0; s < DEM_SOURCES.length; s++) {
      const v = sampleSrc(s, lat, lon);
      if (Number.isFinite(v)) return v;
    }
    return 0;
  }

  const hasData = loaded.length > 0;
  onStatus(hasData ? `標高データ取得完了（タイル${loaded.length}枚）` : '標高データなし（平地として扱います）');
  return { heightAt, hasData };
}

// 航空写真タイルをつなぎ合わせた canvas を作る（3Dドレープ・AI検出用）
export async function stitchPhotoCanvas(bbox, prefZ, maxPx, onStatus = () => {}) {
  const local = geo.bboxToLocal(bbox);
  let z = prefZ;
  while (z > 12 && local.w / geo.metersPerPixel((bbox.s + bbox.n) / 2, z) > maxPx) z--;

  const tx0 = Math.floor(geo.lon2tx(bbox.w, z)), tx1 = Math.floor(geo.lon2tx(bbox.e, z));
  const ty0 = Math.floor(geo.lat2ty(bbox.n, z)), ty1 = Math.floor(geo.lat2ty(bbox.s, z));
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  if (nx * ny > 120) throw new Error('範囲が広すぎます（写真タイルが多すぎる）。地図を拡大してから実行してください。');

  const cv = document.createElement('canvas');
  cv.width = nx * 256; cv.height = ny * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#888'; ctx.fillRect(0, 0, cv.width, cv.height);

  onStatus(`航空写真を取得中…（${nx * ny}枚 / ズーム${z}）`);
  const loads = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const url = PHOTO_TILE_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      loads.push(new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256); resolve(); };
        img.onerror = () => resolve();
        img.src = url;
      }));
    }
  }
  await Promise.all(loads);

  // canvasピクセル ⇔ 緯度経度の変換情報
  const west = geo.tx2lon(tx0, z), north = geo.ty2lat(ty0, z);
  return {
    canvas: cv, z,
    pxOfLatLon(lat, lon) {
      return [
        (geo.lon2tx(lon, z) - tx0) * 256,
        (geo.lat2ty(lat, z) - ty0) * 256,
      ];
    },
    latLonOfPx(px, py) {
      return [geo.ty2lat(ty0 + py / 256, z), geo.tx2lon(tx0 + px / 256, z)];
    },
    metersPerPx: geo.metersPerPixel((bbox.s + bbox.n) / 2, z),
    west, north,
  };
}
