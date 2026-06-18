// 手描きトレース（航空写真からのなぞり描き）
import * as L from 'leaflet';
import * as geo from './geo.js';
import { COLORS, MARK } from './config.js';
import { traceItemsToPrimitives, zebraRects, stencilPolys, bandPoly } from './markings.js';

let seq = 1;
const newId = () => 't' + (seq++) + '_' + Math.random().toString(36).slice(2, 7);

export function createTrace({ map, onChange, onSelect, onStatus }) {
  let items = [];
  let tool = 'select';
  let toolOpts = {};       // line preset / arrow kind
  let selected = null;
  const undoStack = [], redoStack = [];

  const group = L.layerGroup().addTo(map);
  let tempLayer = null;    // 描画中プレビュー
  let drawPts = [];        // 描画中の頂点
  let armed = {};          // 現在のイベントハンドラ

  // ---------- 状態管理 ----------
  const snapshot = () => {
    undoStack.push(JSON.stringify(items));
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
  };
  const commit = () => { render(); onChange(items); };

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(items));
    items = JSON.parse(undoStack.pop());
    selected = null; onSelect(null); commit();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(items));
    items = JSON.parse(redoStack.pop());
    selected = null; onSelect(null); commit();
  }
  function deleteSelected() {
    if (!selected) return;
    snapshot();
    items = items.filter(it => it.id !== selected.id);
    selected = null; onSelect(null); commit();
  }

  // ---------- 描画（レンダリング） ----------
  function styleFor(it, base) {
    const sel = selected && selected.id === it.id;
    return Object.assign(base, sel ? { color: '#ff4081', fillColor: '#ff4081' } : {});
  }

  function itemLayers(it) {
    const p = it.props || {};
    const col = p.color === 'yellow' ? COLORS.yellow : '#ffffff';
    const ls = [];
    if (it.kind === 'line') {
      ls.push(L.polyline(it.latlngs, styleFor(it, {
        color: col, weight: 3, opacity: 0.95,
        dashArray: p.dash ? '10 10' : null,
      })));
    } else if (it.kind === 'polygon') {
      ls.push(L.polygon(it.latlngs, styleFor(it, {
        color: col, weight: 1, fillColor: col, fillOpacity: 0.5,
      })));
    } else {
      // ゼブラ・停止線・ステンシルはメートル形状を計算してポリゴン表示
      const prims = traceItemsToPrimitives([it]);
      for (const prim of prims) {
        let polys = [];
        if (prim.type === 'zebra') polys = zebraRects(prim);
        else if (prim.type === 'band') polys = [bandPoly(prim)];
        else if (prim.type === 'stencil') polys = stencilPolys(prim);
        for (const poly of polys) {
          ls.push(L.polygon(poly.map(pt => geo.fromLocal(pt[0], pt[1])), styleFor(it, {
            color: col, weight: 1, fillColor: col, fillOpacity: 0.85, opacity: 0.9,
          })));
        }
      }
    }
    return ls;
  }

  function render() {
    group.clearLayers();
    for (const it of items) {
      for (const layer of itemLayers(it)) {
        layer.on('click', (e) => {
          if (tool !== 'select') return;
          L.DomEvent.stopPropagation(e);
          selected = it;
          onSelect(it);
          render();
        });
        layer.on('mousedown', (e) => {
          if (tool !== 'select' || !selected || selected.id !== it.id) return;
          L.DomEvent.stopPropagation(e);
          startMove(e.latlng);
        });
        group.addLayer(layer);
      }
    }
  }

  // ---------- 移動 ----------
  function startMove(startLL) {
    map.dragging.disable();
    const orig = JSON.stringify(selected);
    const move = (e) => {
      const dLat = e.latlng.lat - startLL.lat;
      const dLng = e.latlng.lng - startLL.lng;
      const src = JSON.parse(orig);
      shiftItem(selected, src, dLat, dLng);
      render();
    };
    const up = () => {
      map.off('mousemove', move); map.off('mouseup', up);
      map.dragging.enable();
      snapshotBeforeApplied(orig);
      commit();
    };
    map.on('mousemove', move);
    map.on('mouseup', up);
  }
  function snapshotBeforeApplied(origJson) {
    // 移動前の状態をUndo履歴に入れる
    const cur = JSON.stringify(items);
    const before = items.map(it => it.id === selected.id ? JSON.parse(origJson) : it);
    undoStack.push(JSON.stringify(before));
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
    items = JSON.parse(cur);
  }
  function shiftItem(target, src, dLat, dLng) {
    const mv = (ll) => [ll[0] + dLat, ll[1] + dLng];
    if (src.latlngs) target.latlngs = src.latlngs.map(mv);
    if (src.a) target.a = mv(src.a);
    if (src.b) target.b = mv(src.b);
    if (src.at) target.at = mv(src.at);
  }

  // ---------- ツール ----------
  function disarm() {
    for (const [ev, fn] of Object.entries(armed)) map.off(ev, fn);
    armed = {};
    if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; }
    drawPts = [];
    map.getContainer().classList.remove('drawing');
  }

  function setTool(name, opts = {}) {
    disarm();
    tool = name;
    toolOpts = opts;
    if (name === 'select') { onStatus(''); return; }
    map.getContainer().classList.add('drawing');
    selected = null; onSelect(null); render();

    if (name === 'line' || name === 'polygon') armPolyDraw(name);
    else if (name === 'zebra') armTwoPoint('zebra', '横断歩道: 渡る方向の両端を順にクリック');
    else if (name === 'band') armTwoPoint('band', '停止線: 線の両端を順にクリック');
    else if (name === 'arrow') armStencil();
  }

  function armPolyDraw(kind) {
    onStatus(kind === 'line' ? '白線: クリックで点を追加、ダブルクリックで確定（Escで中止）'
      : '面塗り: クリックで点を追加、ダブルクリックで確定（Escで中止）');
    const click = (e) => {
      drawPts.push([e.latlng.lat, e.latlng.lng]);
      updateTemp(kind);
    };
    const dbl = (e) => {
      L.DomEvent.stop(e);
      if (drawPts.length >= (kind === 'line' ? 2 : 3)) {
        snapshot();
        const props = kind === 'line'
          ? { width: toolOpts.width || 0.15, color: toolOpts.color || 'white', dash: toolOpts.dash || null }
          : { color: toolOpts.color || 'white' };
        items.push({ id: newId(), kind, latlngs: drawPts.slice(), props, source: 'manual' });
        commit();
      }
      drawPts = [];
      if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; }
    };
    const move = (e) => { if (drawPts.length) updateTemp(kind, [e.latlng.lat, e.latlng.lng]); };
    map.on('click', click); map.on('dblclick', dbl); map.on('mousemove', move);
    armed = { click, dblclick: dbl, mousemove: move };
  }

  function updateTemp(kind, extra) {
    const pts = extra ? [...drawPts, extra] : drawPts;
    if (tempLayer) map.removeLayer(tempLayer);
    if (pts.length < 2) { tempLayer = null; return; }
    tempLayer = kind === 'polygon'
      ? L.polygon(pts, { color: '#ff4081', weight: 2, fillOpacity: 0.2, dashArray: '4 4', interactive: false })
      : L.polyline(pts, { color: '#ff4081', weight: 2, dashArray: '4 4', interactive: false });
    tempLayer.addTo(map);
  }

  function armTwoPoint(kind, msg) {
    onStatus(msg);
    let first = null;
    const click = (e) => {
      if (!first) {
        first = [e.latlng.lat, e.latlng.lng];
        updateTempLine(first, first);
      } else {
        snapshot();
        const second = [e.latlng.lat, e.latlng.lng];
        const props = kind === 'zebra' ? { depth: MARK.zebraDepth } : { width: MARK.stopWidth, color: 'white' };
        items.push({ id: newId(), kind, a: first, b: second, props, source: 'manual' });
        first = null;
        if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; }
        commit();
        onStatus(msg + '（続けて描けます）');
      }
    };
    const move = (e) => { if (first) updateTempLine(first, [e.latlng.lat, e.latlng.lng]); };
    map.on('click', click); map.on('mousemove', move);
    armed = { click, mousemove: move };
  }
  function updateTempLine(a, b) {
    if (tempLayer) map.removeLayer(tempLayer);
    tempLayer = L.polyline([a, b], { color: '#ff4081', weight: 2, dashArray: '4 4', interactive: false });
    tempLayer.addTo(map);
  }

  function armStencil() {
    onStatus('矢印: ①置く位置をクリック → ②進行方向をクリック');
    let at = null;
    const click = (e) => {
      if (!at) {
        at = [e.latlng.lat, e.latlng.lng];
      } else {
        snapshot();
        const p1 = geo.toLocal(at[0], at[1]);
        const p2 = geo.toLocal(e.latlng.lat, e.latlng.lng);
        const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
        items.push({ id: newId(), kind: 'stencil', at,
          props: { kind: toolOpts.kind || 'through', angle, scale: 1 }, source: 'manual' });
        at = null;
        if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; }
        commit();
      }
    };
    const move = (e) => { if (at) updateTempLine(at, [e.latlng.lat, e.latlng.lng]); };
    map.on('click', click); map.on('mousemove', move);
    armed = { click, mousemove: move };
  }

  // ---------- キーボード ----------
  document.addEventListener('keydown', (e) => {
    const inInput = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (inInput) return;
    if (e.key === 'Escape') { disarm(); if (tool !== 'select') setTool(tool, toolOpts); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteSelected(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  });

  // ---------- 外部API ----------
  function updateSelectedProps(patch) {
    if (!selected) return;
    snapshot();
    Object.assign(selected.props, patch);
    commit();
  }
  function addItems(arr) {
    if (!arr.length) return;
    snapshot();
    for (const it of arr) items.push({ ...it, id: it.id || newId() });
    commit();
  }
  function clearAll() {
    if (!items.length) return;
    snapshot();
    items = []; selected = null; onSelect(null); commit();
  }

  return {
    setTool, undo, redo, deleteSelected, updateSelectedProps, addItems, clearAll, render,
    get items() { return items; },
    set items(v) { items = v; selected = null; render(); },
    get selected() { return selected; },
    get tool() { return tool; },
  };
}
