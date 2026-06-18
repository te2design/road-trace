// 3Dマップの組み立てと glTF(.glb) 書き出し
// 表示スタイル: 'twin'（デジタルツイン＝透過＋発光エッジ・既定）／ 'real'（リアル）
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import * as geo from './geo.js';
import { COLORS, BUILDING_COLORS } from './config.js';
import { primToPolygons } from './markings.js';
import { stitchPhotoCanvas } from './dem.js';

const ROAD_LIFT = 0.20;   // 地形からの道路の浮かせ量
const MARK_LIFT = 0.04;   // 道路面からの標示の浮かせ量

// デジタルツインのパレット（aptpodブルー基調）
const TWIN = {
  bg: 0x0a1626,
  edge: 0x6fb4ff,
  gridCenter: 0x4c96ff,
  gridLine: 0x16314e,
  road: 0x3c454f, roadEmissive: 0x2a323b,
  terrain: 0x0c1b30, terrainEmissive: 0x081019,
  markWhite: 0xbfe9ff, markYellow: 0xffe08a,
};

// 建物の用途色を「青寄りに冷やす」（用途の区別は残しつつデジタルツイン調に）
function coolColor(hex) {
  const c = new THREE.Color(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s * 0.5, Math.min(0.6, hsl.l * 0.75));
  c.lerp(new THREE.Color(0x4c96ff), 0.18);
  return c;
}

export function createViewer(container, onStatus = () => {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 30000);
  camera.position.set(150, 220, 150);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const lightGroup = new THREE.Group();
  scene.add(lightGroup);

  const world = new THREE.Group();
  world.name = 'road-trace';
  scene.add(world);

  function setupSceneStyle(style, span) {
    // ライト・背景・フォグ・トーンマッピングをスタイルごとに切り替え
    for (const l of [...lightGroup.children]) lightGroup.remove(l);
    if (style === 'twin') {
      scene.background = new THREE.Color(TWIN.bg);
      const near = Math.max(300, span * 0.7);
      scene.fog = new THREE.Fog(TWIN.bg, near, near + Math.max(900, span * 2.2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      lightGroup.add(new THREE.HemisphereLight(0x9fc4ff, 0x0a1626, 0.55));
      const key = new THREE.DirectionalLight(0xbfd4ff, 0.6);
      key.position.set(-300, 600, 300);
      lightGroup.add(key);
    } else {
      scene.background = new THREE.Color(0xbfccd4);
      scene.fog = null;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.0;
      lightGroup.add(new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 1.1));
      const sun = new THREE.DirectionalLight(0xffffff, 2.0);
      sun.position.set(300, 500, 200);
      lightGroup.add(sun);
    }
  }

  function resize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 500;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // 視点リセット用の「ホーム」位置と、なめらかに戻すためのトゥイーン
  const homePos = new THREE.Vector3();
  const homeTarget = new THREE.Vector3();
  let tween = null;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  renderer.setAnimationLoop(() => {
    if (tween) {
      tween.t = Math.min(1, tween.t + 0.07);
      const e = easeInOut(tween.t);
      camera.position.lerpVectors(tween.fromPos, homePos, e);
      controls.target.lerpVectors(tween.fromTarget, homeTarget, e);
      if (tween.t >= 1) tween = null;
    }
    controls.update();
    renderer.render(scene, camera);
  });

  function resetView() {
    tween = { fromPos: camera.position.clone(), fromTarget: controls.target.clone(), t: 0 };
  }

  function clearWorld() {
    for (const g of [...world.children]) {
      g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (m.map) m.map.dispose();
            m.dispose();
          }
        }
      });
      world.remove(g);
    }
  }

  // ============ シーン構築 ============
  async function build({ model, autoPrims, tracePrims, dem, options }) {
    const opt = Object.assign({ style: 'twin', terrain: true, drape: false, buildings: true, markings: true }, options);
    const twin = opt.style === 'twin';
    clearWorld();
    const { minX, minY, maxX, maxY, w, h } = model.local;
    setupSceneStyle(opt.style, Math.max(w, h));

    const flatH = () => 0;
    const demH = (dem && opt.terrain && dem.hasData)
      ? (x, y) => { const [lat, lon] = geo.fromLocal(x, y); return dem.heightAt(lat, lon); }
      : flatH;

    // --- 道路中心線の標高サンプル（平滑化）と近傍検索 ---
    onStatus('道路の高さを計算中…');
    const hashCell = 12;
    const hash = new Map();
    const putSample = (x, y, hVal) => {
      const k = `${Math.floor(x / hashCell)}_${Math.floor(y / hashCell)}`;
      if (!hash.has(k)) hash.set(k, []);
      hash.get(k).push([x, y, hVal]);
    };
    const roadGeomSrc = [];
    const clipRect = { minX, minY, maxX, maxY };
    for (const r of model.roads) {
      for (const line of geo.clipPolylineToRect(r.pts, clipRect)) {
        const pts = geo.resamplePolyline(line, 5);
        let hs = pts.map(p => demH(p[0], p[1]));
        hs = geo.smoothArray(hs, 3);
        if (r.bridge && hs.length > 2) {
          const h0 = hs[0], h1 = hs[hs.length - 1];
          const cum = geo.cumDist(pts), L = cum[cum.length - 1] || 1;
          hs = hs.map((_, i) => h0 + (h1 - h0) * (cum[i] / L) + (r.layer > 0 ? 5 * r.layer : 0));
        }
        pts.forEach((p, i) => putSample(p[0], p[1], hs[i]));
        roadGeomSrc.push({ r, pts, hs });
      }
    }
    function roadHeightAt(x, y) {
      const cx = Math.floor(x / hashCell), cy = Math.floor(y / hashCell);
      let best = null, bestD = Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const cell = hash.get(`${cx + i}_${cy + j}`);
        if (!cell) continue;
        for (const s of cell) {
          const d = (s[0] - x) ** 2 + (s[1] - y) ** 2;
          if (d < bestD) { bestD = d; best = s; }
        }
      }
      return best ? best[2] : demH(x, y);
    }

    // --- 地形 ---
    onStatus('地形を生成中…');
    const gTerrain = new THREE.Group(); gTerrain.name = 'Terrain';
    let minH = Infinity;
    {
      const step = Math.max(2, Math.min(6, w / 220));
      const nx = Math.max(2, Math.round(w / step) + 1);
      const ny = Math.max(2, Math.round(h / step) + 1);
      const pos = new Float32Array(nx * ny * 3);
      const uv = new Float32Array(nx * ny * 2);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = minX + (w * i) / (nx - 1);
          const y = minY + (h * j) / (ny - 1);
          const hh = demH(x, y);
          if (hh < minH) minH = hh;
          const idx = j * nx + i;
          pos[idx * 3] = x; pos[idx * 3 + 1] = hh; pos[idx * 3 + 2] = -y;
          uv[idx * 2] = (x - minX) / w;
          uv[idx * 2 + 1] = (maxY - y) / h;
        }
      }
      const indices = [];
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(indices);
      g.computeVertexNormals();
      let mat;
      if (opt.drape) {
        onStatus('航空写真を地面に貼っています…');
        try {
          const stitched = await stitchPhotoCanvas(model.bbox, 17, 2048, onStatus);
          const tex = new THREE.CanvasTexture(stitched.canvas);
          tex.flipY = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1.0, side: THREE.DoubleSide });
        } catch (e) {
          onStatus('写真の貼り付けに失敗: ' + e.message);
          mat = new THREE.MeshStandardMaterial({ color: 0x9aa78f, roughness: 1.0, side: THREE.DoubleSide });
        }
      } else if (twin) {
        mat = new THREE.MeshStandardMaterial({
          color: TWIN.terrain, roughness: 0.95, metalness: 0.0,
          emissive: TWIN.terrainEmissive, emissiveIntensity: 0.2, side: THREE.DoubleSide,
        });
      } else {
        mat = new THREE.MeshStandardMaterial({ color: 0x9aa78f, roughness: 1.0, side: THREE.DoubleSide });
      }
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'terrain';
      mesh.renderOrder = 0;
      gTerrain.add(mesh);
    }
    if (!Number.isFinite(minH)) minH = 0;
    world.add(gTerrain);

    // --- 地面グリッド（デジタルツインのみ） ---
    if (twin) {
      const gGrid = new THREE.Group(); gGrid.name = 'Grid';
      const gridSize = Math.ceil(Math.max(w, h) / 20) * 20 + 40;
      const divisions = Math.max(4, Math.round(gridSize / 20));
      const grid = new THREE.GridHelper(gridSize, divisions, TWIN.gridCenter, TWIN.gridLine);
      grid.material.transparent = true;
      grid.material.opacity = 0.3;
      grid.material.depthWrite = false;
      grid.material.fog = true;
      grid.position.set((minX + maxX) / 2, minH + 0.05, -(minY + maxY) / 2);
      grid.renderOrder = 1;
      gGrid.add(grid);
      world.add(gGrid);
    }

    // --- 道路リボン ---
    onStatus('道路を生成中…');
    const gRoads = new THREE.Group(); gRoads.name = 'Roads';
    {
      const geoms = [];
      for (const { r, pts, hs } of roadGeomSrc) {
        if (r.tunnel) continue;
        const { L: left, R: right } = geo.polylineToStrip(pts, r.width);
        const n = pts.length;
        const pos = new Float32Array(n * 2 * 3);
        for (let i = 0; i < n; i++) {
          const y = hs[i] + ROAD_LIFT;
          pos[i * 6] = left[i][0]; pos[i * 6 + 1] = y; pos[i * 6 + 2] = -left[i][1];
          pos[i * 6 + 3] = right[i][0]; pos[i * 6 + 4] = y; pos[i * 6 + 5] = -right[i][1];
        }
        const idx = [];
        for (let i = 0; i < n - 1; i++) {
          const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
          idx.push(a, b, c, b, d, c);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setIndex(idx);
        geoms.push(g);
      }
      if (geoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(geoms, false);
        merged.computeVertexNormals();
        const mat = twin
          ? new THREE.MeshStandardMaterial({ color: TWIN.road, roughness: 0.9, metalness: 0.0,
              emissive: TWIN.roadEmissive, emissiveIntensity: 0.4, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: new THREE.Color(COLORS.asphalt), roughness: 0.95, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.name = 'roads';
        mesh.renderOrder = 1;
        gRoads.add(mesh);
        geoms.forEach(g => g.dispose());
      }
    }
    world.add(gRoads);

    // --- 路面標示（板ポリ） ---
    function polysToGeometry(polysWithColor) {
      const positions = [];
      const indices = [];
      let base = 0;
      for (const { poly, h: hh } of polysWithColor) {
        if (poly.length < 3) continue;
        const contour = poly.map(p => new THREE.Vector2(p[0], p[1]));
        let tris;
        try { tris = THREE.ShapeUtils.triangulateShape(contour, []); }
        catch (e) { continue; }
        for (const p of poly) positions.push(p[0], hh, -p[1]);
        for (const t of tris) indices.push(base + t[0], base + t[1], base + t[2]);
        base += poly.length;
      }
      if (!positions.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
      g.setIndex(indices);
      g.computeVertexNormals();
      return g;
    }

    function markColor(primColor) {
      if (primColor === 'yellow') return twin ? TWIN.markYellow : COLORS.yellow;
      if (primColor === 'green') return COLORS.green;
      if (primColor === 'asphalt') return COLORS.asphalt;
      return twin ? TWIN.markWhite : 0xf8f8f4;
    }
    function markMaterial(col) {
      return twin
        ? new THREE.MeshBasicMaterial({ color: new THREE.Color(col), transparent: true, opacity: 0.85,
            depthWrite: false, fog: true, toneMapped: false, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -1 })
        : new THREE.MeshStandardMaterial({ color: new THREE.Color(col), roughness: 0.7, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -1 });
    }

    function buildMarkGroup(name, prims, renderOrder) {
      const group = new THREE.Group(); group.name = name;
      const byColor = new Map();
      for (const prim of prims) {
        const polys = primToPolygons(prim);
        for (const poly of polys) {
          const c = geo.polygonCentroid(poly);
          if (c[0] < minX || c[0] > maxX || c[1] < minY || c[1] > maxY) continue;
          const hh = roadHeightAt(c[0], c[1]) + ROAD_LIFT + MARK_LIFT;
          const col = markColor(prim.color);
          if (!byColor.has(col)) byColor.set(col, []);
          byColor.get(col).push({ poly, h: hh });
        }
      }
      for (const [col, polys] of byColor) {
        const g = polysToGeometry(polys);
        if (!g) continue;
        const mesh = new THREE.Mesh(g, markMaterial(col));
        mesh.name = name.toLowerCase();
        mesh.renderOrder = renderOrder;
        group.add(mesh);
      }
      return group;
    }

    if (opt.markings) {
      onStatus('路面標示を生成中…');
      const zebra = autoPrims.filter(p => p.type === 'zebra');
      const others = autoPrims.filter(p => p.type !== 'zebra');
      world.add(buildMarkGroup('Markings', others, 4));
      world.add(buildMarkGroup('Crosswalks', zebra, 4));
      if (tracePrims && tracePrims.length) world.add(buildMarkGroup('Traces', tracePrims, 5));
    }

    // --- 建物 ---
    if (opt.buildings) {
      onStatus('建物を生成中…');
      const gB = new THREE.Group(); gB.name = 'Buildings';
      const byColor = new Map();
      for (const b of model.buildings) {
        const clipped = geo.clipPolygonToRect(b.pts, clipRect);
        if (!clipped || clipped.length < 3) continue;
        const poly = geo.ensureCCW(clipped);
        let baseH = Infinity;
        const stepN = Math.max(1, Math.floor(poly.length / 6));
        for (let i = 0; i < poly.length; i += stepN) baseH = Math.min(baseH, demH(poly[i][0], poly[i][1]));
        if (!Number.isFinite(baseH)) baseH = 0;
        const shape = new THREE.Shape(poly.map(p => new THREE.Vector2(p[0], p[1])));
        const g = new THREE.ExtrudeGeometry(shape, { depth: b.height + 0.5, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        g.translate(0, baseH, 0);
        const col = BUILDING_COLORS[b.btype] || BUILDING_COLORS.default;
        if (!byColor.has(col)) byColor.set(col, []);
        byColor.get(col).push(g);
      }
      for (const [col, list] of byColor) {
        const merged = BufferGeometryUtils.mergeGeometries(list.map(g => {
          const c = g.clone(); c.deleteAttribute('uv'); return c;
        }), false);
        list.forEach(g => g.dispose());
        if (!merged) continue;

        if (twin) {
          const cool = coolColor(col);
          const body = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
            color: cool, transparent: true, opacity: 0.16, roughness: 0.6, metalness: 0.0,
            emissive: cool, emissiveIntensity: 0.15, depthWrite: false, side: THREE.FrontSide, fog: true,
          }));
          body.name = 'buildings';
          body.renderOrder = 2;
          gB.add(body);

          // 構造エッジ（発光する輪郭線）。ExtrudeGeometryは頂点が揃わず
          // EdgesGeometryが全三角形の対角線まで拾うので、先にmergeVerticesで溶接する。
          let weld = merged.clone();
          weld = BufferGeometryUtils.mergeVertices(weld, 1e-4);
          const edgesGeom = new THREE.EdgesGeometry(weld, 18);
          weld.dispose();
          const edges = new THREE.LineSegments(edgesGeom, new THREE.LineBasicMaterial({
            color: TWIN.edge, transparent: false, depthWrite: true, depthTest: true, fog: true,
          }));
          edges.name = 'building-edges';
          edges.renderOrder = 3;
          gB.add(edges);
        } else {
          const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
            color: new THREE.Color(col), roughness: 0.85, side: THREE.DoubleSide,
          }));
          mesh.name = 'buildings';
          mesh.renderOrder = 2;
          gB.add(mesh);
        }
      }
      world.add(gB);
    }

    // --- カメラ初期位置 ---
    const span = Math.max(w, h);
    const ch = roadHeightAt((minX + maxX) / 2, (minY + maxY) / 2);
    homeTarget.set((minX + maxX) / 2, ch, -(minY + maxY) / 2);
    homePos.set(minX + w * 0.15, ch + span * 0.7, -(minY - h * 0.25));
    controls.target.copy(homeTarget);
    camera.position.copy(homePos);
    tween = null;
    controls.update();

    onStatus(twin ? '3D生成完了（デジタルツイン）' : '3D生成完了（リアル）');
  }

  function setCategoryVisible(name, visible) {
    const g = world.children.find(c => c.name === name);
    if (g) g.visible = visible;
  }

  async function exportGLB() {
    const exporter = new GLTFExporter();
    return new Promise((resolve, reject) => {
      exporter.parse(world,
        (result) => resolve(result),
        (err) => reject(err),
        { binary: true });
    });
  }

  return { build, exportGLB, setCategoryVisible, resize, resetView };
}
