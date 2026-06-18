// Overpass API（OpenStreetMapのデータ取り出し窓口）からの取得
import { OVERPASS_ENDPOINTS } from './config.js';

const cache = new Map(); // bboxキー → 結果

function buildQuery(b) {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  return `[out:json][timeout:90][bbox:${bbox}];
(
  way["highway"];
  way["building"];
  relation["building"];
  node["highway"~"^(crossing|traffic_signals|stop|give_way)$"];
);
(._;>;);
out body;`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchOSM(bbox, onStatus = () => {}) {
  const key = [bbox.s, bbox.w, bbox.n, bbox.e].map(v => v.toFixed(5)).join(',');
  if (cache.has(key)) { onStatus('キャッシュから読み込みました'); return cache.get(key); }

  const query = buildQuery(bbox);
  let lastErr = null;
  const delays = [0, 2000, 8000];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        if (delays[attempt]) {
          onStatus(`混雑中のため ${delays[attempt] / 1000} 秒待って再試行します…`);
          await sleep(delays[attempt]);
        }
        onStatus(`地図データを取得中…（${new URL(ep).hostname}）`);
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) {
          lastErr = new Error(`サーバー応答 ${res.status}`);
          if ([429, 502, 503, 504].includes(res.status)) continue; // 次のサーバーへ
          throw lastErr;
        }
        onStatus('受信データを解析中…');
        const json = await res.json();
        if (json.remark && /timed out|error/i.test(json.remark)) {
          lastErr = new Error('サーバー側で処理が打ち切られました（範囲を狭めてください）: ' + json.remark);
          continue;
        }
        const result = indexElements(json.elements || []);
        result.fetchedKey = key;
        cache.set(key, result);
        onStatus(`取得完了: 道路系 ${result.counts.highways} 本 / 建物 ${result.counts.buildings} 棟 / 横断歩道ノード ${result.counts.crossings} 点`);
        return result;
      } catch (e) {
        lastErr = e;
        // ネットワークエラー等 → 次のサーバーへ
      }
    }
  }
  throw new Error('地図データの取得に失敗しました。' +
    '時間をおいて再試行するか、範囲を狭めてください。（詳細: ' + (lastErr ? lastErr.message : '不明') + '）');
}

function indexElements(elements) {
  const nodes = new Map();
  const ways = new Map();
  const rels = [];
  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon, tags: el.tags || null });
    else if (el.type === 'way') ways.set(el.id, { id: el.id, nodes: el.nodes, tags: el.tags || {} });
    else if (el.type === 'relation') rels.push(el);
  }
  let highways = 0, buildings = 0, crossings = 0;
  for (const w of ways.values()) {
    if (w.tags.highway) highways++;
    if (w.tags.building) buildings++;
  }
  for (const n of nodes.values()) {
    if (n.tags && n.tags.highway === 'crossing') crossings++;
  }
  return { nodes, ways, rels, counts: { highways, buildings, crossings } };
}
