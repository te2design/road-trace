// アプリ全体の結線
import * as L from 'leaflet';
import { TEST_BBOXES, AREA_WARN_KM2, AREA_MAX_KM2, LINE_PRESETS, STENCIL_LABELS, GEOCODE_URL } from './config.js';
import * as geo from './geo.js';
import { fetchOSM } from './overpass.js';
import { buildRoadModel } from './roadmodel.js';
import { generateAutoPrimitives, traceItemsToPrimitives } from './markings.js';
import { renderSVG } from './svgrender.js';
import { createMapUI } from './mapui.js';
import { createTrace } from './trace.js';
import * as storage from './storage.js';
import { createDemSampler } from './dem.js';
import { detectInView } from './detect.js';

const $ = (id) => document.getElementById(id);

const state = {
  bbox: null,
  osm: null,
  model: null,
  autoPrims: [],
  svgText: null,
  dem: null,
  candidates: [],
  viewer: null,
  errors: [],
};

// ---------- 共通UI ----------
function status(msg) { $('statusbar').textContent = msg || '待機中'; }
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), isError ? 9000 : 4000);
  if (isError) { state.errors.push(msg); console.error('[road-trace]', msg); }
}

// ---------- タブ ----------
const panes = { map: $('pane-map'), svg: $('pane-svg'), '3d': $('pane-3d') };
const tabs = { map: $('tab-map'), svg: $('tab-svg'), '3d': $('tab-3d') };
function showTab(key) {
  for (const k of Object.keys(panes)) {
    panes[k].classList.toggle('active', k === key);
    tabs[k].classList.toggle('active', k === key);
  }
  if (key === 'map') setTimeout(() => mapui.map.invalidateSize(), 50);
}
tabs.map.onclick = () => showTab('map');
tabs.svg.onclick = () => showTab('svg');
tabs['3d'].onclick = () => showTab('3d');

// ---------- 地図 ----------
const mapui = createMapUI({
  onBboxChange: (bbox) => { setBbox(bbox, { fromMap: true }); },
  onStatus: status,
});

function setBbox(bbox, { fromMap = false, pan = false } = {}) {
  state.bbox = bbox;
  geo.setOrigin((bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2);
  if (!fromMap) mapui.setBbox(bbox, { pan });
  else mapui.setBbox(bbox);
  $('in-n').value = bbox.n.toFixed(5);
  $('in-s').value = bbox.s.toFixed(5);
  $('in-e').value = bbox.e.toFixed(5);
  $('in-w').value = bbox.w.toFixed(5);
  const km2 = geo.bboxAreaKm2(bbox);
  const lbl = $('area-label');
  const local = geo.bboxToLocal(bbox);
  lbl.textContent = `約 ${Math.round(local.w)}m × ${Math.round(local.h)}m（${km2.toFixed(2)}km²）`;
  lbl.className = km2 > AREA_MAX_KM2 ? 'err' : km2 > AREA_WARN_KM2 ? 'warn' : '';
  if (km2 > AREA_MAX_KM2) lbl.textContent += ' ← 広すぎます（4km²まで）';
  else if (km2 > AREA_WARN_KM2) lbl.textContent += ' ← やや広め（取得に時間がかかります）';
  saveSession();
}

function bboxFromInputs() {
  const n = parseFloat($('in-n').value), s = parseFloat($('in-s').value);
  const e = parseFloat($('in-e').value), w = parseFloat($('in-w').value);
  if ([n, s, e, w].some(v => !Number.isFinite(v))) return null;
  if (n <= s || e <= w) { toast('北＞南、東＞西になるように入力してください', true); return null; }
  return { n, s, e, w };
}
for (const id of ['in-n', 'in-s', 'in-e', 'in-w']) {
  $(id).addEventListener('change', () => {
    const b = bboxFromInputs();
    if (b) setBbox(b, { pan: true });
  });
}
$('btn-rect').onclick = () => mapui.startRectDraw();
$('sel-test-bbox').onchange = (e) => {
  const b = TEST_BBOXES[e.target.value];
  if (b) setBbox({ ...b }, { pan: true });
};
$('sel-base').onchange = (e) => mapui.setBase(e.target.value);

// ---------- 場所検索（Nominatim / OpenStreetMap） ----------
const searchInput = $('search-input');
const searchResults = $('search-results');
L.DomEvent.disableClickPropagation($('map-search'));
L.DomEvent.disableScrollPropagation($('map-search'));

let searchAbort = null;
async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchResults.classList.remove('hidden');
  searchResults.innerHTML = '<div class="search-empty">検索中…</div>';
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  try {
    const url = `${GEOCODE_URL}?format=jsonv2&limit=6&accept-language=ja&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: searchAbort.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('応答 ' + res.status);
    renderSearchResults(await res.json());
  } catch (e) {
    if (e.name === 'AbortError') return;
    searchResults.innerHTML = '<div class="search-empty">検索に失敗しました。時間をおいて再試行してください。</div>';
  }
}

function renderSearchResults(list) {
  searchResults.innerHTML = '';
  if (!list.length) { searchResults.innerHTML = '<div class="search-empty">見つかりませんでした</div>'; return; }
  list.forEach(item => {
    const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
    const full = item.display_name || '';
    const title = full.split(',')[0];
    const sub = full.split(',').slice(1).join(',').trim();
    const div = document.createElement('div');
    div.className = 'search-item';
    const t = document.createElement('div'); t.className = 'si-title'; t.textContent = title;
    const s = document.createElement('div'); s.className = 'si-sub'; s.textContent = sub;
    div.append(t, s);
    div.onclick = () => {
      mapui.flyTo(lat, lon, title);
      searchResults.classList.add('hidden');
      status(`「${title}」へ移動しました。範囲を指定して「データ取得」できます。`);
    };
    searchResults.appendChild(div);
  });
}

$('search-btn').onclick = runSearch;
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
document.addEventListener('click', (e) => {
  if (!$('map-search').contains(e.target)) searchResults.classList.add('hidden');
});

// ---------- トレース ----------
const trace = createTrace({
  map: mapui.map,
  onChange: () => { saveSession(); if (state.model) regenerateSVG(); },
  onSelect: showProps,
  onStatus: status,
});

const presetSel = $('sel-line-preset');
LINE_PRESETS.forEach(p => {
  const o = document.createElement('option');
  o.value = p.id; o.textContent = p.label;
  presetSel.appendChild(o);
});
function currentLineOpts() {
  const p = LINE_PRESETS.find(x => x.id === presetSel.value) || LINE_PRESETS[0];
  return { width: p.width, color: p.color, dash: p.dash };
}
const toolButtons = ['select', 'line', 'zebra', 'band', 'arrow', 'polygon'];
for (const t of toolButtons) {
  $('tool-' + t).onclick = () => {
    toolButtons.forEach(x => $('tool-' + x).classList.toggle('active', x === t));
    const opts = t === 'line' ? currentLineOpts()
      : t === 'arrow' ? { kind: $('sel-arrow-kind').value }
      : t === 'polygon' ? { color: 'white' } : {};
    trace.setTool(t, opts);
  };
}
presetSel.onchange = () => { if (trace.tool === 'line') trace.setTool('line', currentLineOpts()); };
$('sel-arrow-kind').onchange = () => { if (trace.tool === 'arrow') trace.setTool('arrow', { kind: $('sel-arrow-kind').value }); };
$('btn-undo').onclick = () => trace.undo();
$('btn-redo').onclick = () => trace.redo();
$('btn-del').onclick = () => trace.deleteSelected();
$('btn-clear-traces').onclick = () => {
  if (confirm('手描きトレースを全部消します。よろしいですか？')) trace.clearAll();
};

function showProps(item) {
  const panel = $('prop-panel');
  const fields = $('prop-fields');
  if (!item) { panel.classList.add('hidden'); fields.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  fields.innerHTML = '';
  const add = (label, input) => {
    const l = document.createElement('label');
    l.append(label, input);
    fields.appendChild(l);
  };
  const kindName = { line: '白線', zebra: '横断歩道', band: '停止線', stencil: '矢印・記号', polygon: '面塗り' }[item.kind] || item.kind;
  const h = document.createElement('div');
  h.textContent = `種類: ${kindName}（${item.source === 'ai' ? 'AI候補から採用' : '手描き'}）`;
  fields.appendChild(h);
  const numInput = (key, val, step, min, max) => {
    const i = document.createElement('input');
    i.type = 'number'; i.step = step; i.min = min; i.max = max; i.value = val;
    i.onchange = () => trace.updateSelectedProps({ [key]: parseFloat(i.value) });
    return i;
  };
  if (item.kind === 'line' || item.kind === 'band') add('線の太さ(m)', numInput('width', item.props.width, 0.05, 0.05, 2));
  if (item.kind === 'zebra') add('縞の長さ(m)', numInput('depth', item.props.depth, 0.5, 2, 10));
  if (item.kind === 'stencil') {
    add('大きさ(倍率)', numInput('scale', item.props.scale || 1, 0.1, 0.3, 3));
    const sel = document.createElement('select');
    for (const [k, label] of Object.entries(STENCIL_LABELS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = label;
      if (k === item.props.kind) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => trace.updateSelectedProps({ kind: sel.value });
    add('種類', sel);
  }
  if (item.kind === 'line' || item.kind === 'polygon') {
    const sel = document.createElement('select');
    [['white', '白'], ['yellow', '黄']].forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if ((item.props.color || 'white') === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => trace.updateSelectedProps({ color: sel.value });
    add('色', sel);
  }
}

$('btn-offset').onclick = () => {
  mapui.startOffsetCal((dx, dy) => {
    $('offset-label').textContent = `補正: 東${dx.toFixed(1)}m / 北${dy.toFixed(1)}m`;
    status('写真のズレ補正を適用しました');
    saveSession();
  });
};

// ---------- データ取得 → SVG ----------
$('btn-fetch').onclick = () => doFetch().catch(e => { toast(e.message, true); status('取得失敗'); });

async function doFetch() {
  const bbox = state.bbox || bboxFromInputs();
  if (!bbox) { toast('先に範囲を指定してください（ドラッグまたは数値入力）', true); return; }
  const km2 = geo.bboxAreaKm2(bbox);
  if (km2 > AREA_MAX_KM2) { toast(`範囲が広すぎます（${km2.toFixed(1)}km² > 上限${AREA_MAX_KM2}km²）。枠を小さくしてください。`, true); return; }

  $('btn-fetch').disabled = true;
  try {
    status('地図データを取得しています…');
    state.osm = await fetchOSM(bbox, (m) => { status(m); $('fetch-status').textContent = m; });
    status('道路モデルを構築中…');
    state.model = buildRoadModel(state.osm, bbox);
    state.autoPrims = generateAutoPrimitives(state.model);
    mapui.setRoadsOverlay(state.model);
    regenerateSVG();
    const st = state.model.stats;
    $('fetch-status').textContent =
      `道路 ${st.roads} / 建物 ${st.buildings} / 横断歩道 ${st.markedCrossings} / 交差点 ${st.junctions} / 標示部品 ${state.autoPrims.length}`;
    status('SVGを生成しました（「② SVGマップ」タブで確認できます）');
    showTab('svg');
  } finally {
    $('btn-fetch').disabled = false;
  }
}

function layerOpts() {
  return {
    roads: $('chk-roads').checked,
    markings: $('chk-markings').checked,
    crosswalks: $('chk-crosswalks').checked,
    buildings: $('chk-buildings').checked,
    traces: $('chk-traces').checked,
    classColors: $('chk-classcolors').checked,
    ground: $('chk-ground').checked,
  };
}
for (const id of ['chk-roads', 'chk-markings', 'chk-crosswalks', 'chk-buildings', 'chk-traces', 'chk-classcolors', 'chk-ground']) {
  $(id).onchange = () => { if (state.model) regenerateSVG(); };
}

function regenerateSVG() {
  if (!state.model) return;
  const tracePrims = traceItemsToPrimitives(trace.items);
  state.svgText = renderSVG(state.model, state.autoPrims, tracePrims, layerOpts());
  const holder = $('svg-container');
  holder.innerHTML = state.svgText;
  const svg = holder.querySelector('svg');
  if (svg) {
    // 画面表示用に拡大（データ自体は1ユニット=1m）
    const w = parseFloat(svg.getAttribute('width'));
    const h = parseFloat(svg.getAttribute('height'));
    const scale = Math.max(1, Math.min(4, 1200 / Math.max(w, h)));
    svg.setAttribute('width', Math.round(w * scale * baseZoom()));
    svg.setAttribute('height', Math.round(h * scale * baseZoom()));
  }
  $('svg-scale-label').textContent = svg ? `元寸法 ${svg.viewBox.baseVal.width.toFixed(0)}m × ${svg.viewBox.baseVal.height.toFixed(0)}m` : '';
}
function baseZoom() { return Math.pow(2, parseFloat($('svg-zoom').value)); }
$('svg-zoom').oninput = () => regenerateSVG();

$('btn-dl-svg').onclick = () => {
  if (!state.svgText) { toast('まだSVGがありません。先にデータ取得してください。', true); return; }
  storage.downloadFile('road-trace-map.svg', state.svgText, 'image/svg+xml');
  status('SVGを保存しました（1ユニット=1m の実寸データ）');
};

// ---------- 3D ----------
$('btn-build3d').onclick = () => build3D().catch(e => { toast('3D生成に失敗: ' + e.message, true); });

async function build3D() {
  if (!state.model) { toast('先に「データ取得 → SVG生成」を実行してください', true); return; }
  showTab('3d');
  $('three-placeholder')?.remove();
  if (!state.viewer) {
    const { createViewer } = await import('./three3d.js');
    state.viewer = createViewer($('three-container'), (m) => { $('three-status').textContent = m; });
  }
  if ($('chk-terrain').checked && !state.dem) {
    state.dem = await createDemSampler(state.bbox, (m) => { $('three-status').textContent = m; });
  }
  await state.viewer.build({
    model: state.model,
    autoPrims: state.autoPrims,
    tracePrims: traceItemsToPrimitives(trace.items),
    dem: state.dem,
    options: {
      style: $('sel-3dstyle').value,
      terrain: $('chk-terrain').checked,
      drape: $('chk-drape').checked,
      buildings: $('chk-3dbuildings').checked,
      markings: $('chk-3dmarkings').checked,
    },
  });
  state.builtStyle = $('sel-3dstyle').value;
  $('three-overlay').classList.remove('hidden');
}
$('sel-3dstyle').onchange = () => { if (state.viewer && state.model) build3D().catch(e => toast('3D生成に失敗: ' + e.message, true)); };
$('btn-reset-view').onclick = () => state.viewer?.resetView();
$('chk-3dbuildings').onchange = (e) => state.viewer?.setCategoryVisible('Buildings', e.target.checked);
$('chk-3dmarkings').onchange = (e) => {
  for (const n of ['Markings', 'Crosswalks', 'Traces']) state.viewer?.setCategoryVisible(n, e.target.checked);
};

$('btn-dl-glb').onclick = async () => {
  if (!state.viewer) { toast('先に「3Dを生成」を押してください', true); return; }
  try {
    const style = state.builtStyle || $('sel-3dstyle').value;
    const label = style === 'twin' ? 'デジタルツイン' : 'リアル';
    $('three-status').textContent = `glTFを書き出し中…（${label}スタイル）`;
    const buf = await state.viewer.exportGLB();
    storage.downloadFile(`road-trace-${style}.glb`, new Blob([buf], { type: 'model/gltf-binary' }));
    $('three-status').textContent = `書き出し完了（${label}スタイル / メートル実寸 / Blender等で開けます）`;
  } catch (e) {
    toast('glTF書き出しに失敗: ' + e.message, true);
  }
};

// ---------- AI検出 ----------
$('btn-detect').onclick = () => runDetect().catch(e => { toast(e.message, true); $('detect-status').textContent = '失敗: ' + e.message; });

async function runDetect() {
  if (!state.model) { toast('先に「データ取得」を実行してください', true); return; }
  showTab('map');
  const b = mapui.map.getBounds();
  const viewBbox = {
    s: Math.max(b.getSouth(), state.bbox.s), n: Math.min(b.getNorth(), state.bbox.n),
    w: Math.max(b.getWest(), state.bbox.w), e: Math.min(b.getEast(), state.bbox.e),
  };
  if (viewBbox.s >= viewBbox.n || viewBbox.w >= viewBbox.e) {
    toast('地図の表示位置が選択範囲から外れています', true); return;
  }
  $('btn-detect').disabled = true;
  try {
    state.candidates = await detectInView({
      viewBbox, model: state.model,
      onStatus: (m) => { $('detect-status').textContent = m; },
    });
    renderCandidates();
  } finally {
    $('btn-detect').disabled = false;
  }
}

// 候補を地図上にオレンジ枠で表示
let candLayer = null;
function candPolygon(item) {
  if (item.kind === 'polygon') return item.latlngs;
  if (item.kind === 'zebra' || item.kind === 'band') {
    const a = geo.toLocal(item.a[0], item.a[1]);
    const b = geo.toLocal(item.b[0], item.b[1]);
    const half = (item.kind === 'zebra' ? (item.props.depth || 4) : (item.props.width || 0.45)) / 2;
    const v = geo.vNorm(geo.vSub(b, a));
    const u = geo.rot90(v);
    return [
      [a[0] - u[0] * half, a[1] - u[1] * half], [b[0] - u[0] * half, b[1] - u[1] * half],
      [b[0] + u[0] * half, b[1] + u[1] * half], [a[0] + u[0] * half, a[1] + u[1] * half],
    ].map(p => geo.fromLocal(p[0], p[1]));
  }
  return null;
}
function showCandidatesOnMap() {
  if (candLayer) { mapui.map.removeLayer(candLayer); candLayer = null; }
  if (!state.candidates.length) return;
  const layers = [];
  state.candidates.forEach((c, i) => {
    const poly = candPolygon(c.item);
    if (!poly) return;
    const pl = L.polygon(poly, { color: '#ff9100', weight: 2, fillColor: '#ff9100', fillOpacity: 0.2, interactive: false });
    pl.bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: 'cand-tip' });
    layers.push(pl);
  });
  candLayer = L.layerGroup(layers).addTo(mapui.map);
}

function renderCandidates() {
  const list = $('detect-list');
  list.innerHTML = '';
  $('btn-accept-all').classList.toggle('hidden', !state.candidates.length);
  $('btn-clear-cands').classList.toggle('hidden', !state.candidates.length);
  showCandidatesOnMap();
  if (!state.candidates.length) { list.textContent = '候補なし'; return; }
  state.candidates.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cand';
    const name = document.createElement('span');
    name.textContent = `${i + 1}. ${c.label}（確度${Math.round(c.score * 100)}%）`;
    name.style.flex = '1';
    const go = document.createElement('button');
    go.textContent = '見る';
    go.onclick = () => {
      const ll = c.item.a || c.item.at || (c.item.latlngs && c.item.latlngs[0]);
      if (ll) mapui.map.setView(ll, 19);
    };
    const ok = document.createElement('button');
    ok.textContent = '採用';
    ok.onclick = () => {
      trace.addItems([c.item]);
      state.candidates.splice(i, 1);
      renderCandidates();
    };
    const ng = document.createElement('button');
    ng.textContent = '×';
    ng.onclick = () => { state.candidates.splice(i, 1); renderCandidates(); };
    row.append(name, go, ok, ng);
    list.appendChild(row);
  });
}
$('btn-accept-all').onclick = () => {
  trace.addItems(state.candidates.map(c => c.item));
  state.candidates = [];
  renderCandidates();
};
$('btn-clear-cands').onclick = () => { state.candidates = []; renderCandidates(); };

// ---------- 保存・読み込み ----------
function sessionState() {
  return {
    bbox: state.bbox,
    photoOffset: mapui.getPhotoOffset(),
    traces: trace.items,
    settings: { base: $('sel-base').value },
  };
}
function saveSession() { storage.autosave(sessionState()); }

$('btn-save').onclick = () => { storage.saveProjectFile(sessionState()); status('プロジェクトを保存しました'); };
$('btn-load').onclick = () => $('file-load').click();
$('file-load').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const proj = await storage.readProjectFile(f);
    applyProject(proj);
    toast('プロジェクトを読み込みました。「データ取得」を押すと地図データを再取得します。');
  } catch (err) {
    toast('読み込み失敗: ' + err.message, true);
  }
  e.target.value = '';
};

function applyProject(proj) {
  if (proj.bbox) setBbox(proj.bbox, { pan: true });
  if (proj.photoOffset) {
    mapui.setPhotoOffset(proj.photoOffset.dx || 0, proj.photoOffset.dy || 0);
    if (proj.photoOffset.dx || proj.photoOffset.dy) {
      $('offset-label').textContent = `補正: 東${(proj.photoOffset.dx || 0).toFixed(1)}m / 北${(proj.photoOffset.dy || 0).toFixed(1)}m`;
    }
  }
  if (proj.settings?.base) { $('sel-base').value = proj.settings.base; mapui.setBase(proj.settings.base); }
  trace.items = proj.traces || [];
}

// ---------- 起動時の復元 ----------
(function boot() {
  // URL #bbox=s,w,n,e
  const m = location.hash.match(/bbox=([\d.\-]+),([\d.\-]+),([\d.\-]+),([\d.\-]+)/);
  if (m) {
    setBbox({ s: +m[1], w: +m[2], n: +m[3], e: +m[4] }, { pan: true });
  } else {
    const saved = storage.loadAutosave();
    if (saved && saved.bbox) applyProject(saved);
  }
  status('準備OK。範囲を指定して「データ取得」を押してください。');
})();

// ---------- 検証用フック ----------
window.__app = {
  state, trace, mapui,
  setBbox: (b) => setBbox(b, { pan: true }),
  fetch: doFetch,
  build3D,
  stats: () => ({
    bbox: state.bbox,
    model: state.model ? state.model.stats : null,
    prims: state.autoPrims.length,
    traceItems: trace.items.length,
    svgLength: state.svgText ? state.svgText.length : 0,
    errors: state.errors,
  }),
};
