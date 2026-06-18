// Road Trace 全設定値（タイル・道路スタイル・路面標示寸法・色）

export const TILE_LAYERS = {
  osm: {
    name: 'OSM標準',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  gsi_pale: {
    name: '地理院 淡色',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
    maxZoom: 18,
  },
  gsi_photo: {
    name: '地理院 航空写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
    maxZoom: 18,
  },
};

// 解析・3Dドレープ用写真タイル（CORS可・出典明記で利用可）
export const PHOTO_TILE_URL = TILE_LAYERS.gsi_photo.url;

// 標高タイル（上から順に試す）
export const DEM_SOURCES = [
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png', z: 15 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png', z: 14 },
];

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

// 場所検索（ジオコーディング）。Nominatim（OpenStreetMap）はランドマーク・駅名・住所に強い。
// 利用規約に配慮し「Enter／ボタン押下時のみ」検索する（1回ずつ・自動補完しない）。
export const GEOCODE_URL = 'https://nominatim.openstreetmap.org/search';

export const AREA_WARN_KM2 = 1.0; // これ以上は時間がかかる旨を警告
export const AREA_MAX_KM2 = 4.0;  // これ以上は取得をブロック

// 道路クラス → 既定の総幅(m)・クラス色・標示自動生成の対象か・車道か
export const ROAD_STYLES = {
  motorway:      { width: 12.0, color: '#5a6acf', markings: true,  carriage: true },
  motorway_link: { width:  6.0, color: '#5a6acf', markings: false, carriage: true },
  trunk:         { width: 10.0, color: '#cf7a5a', markings: true,  carriage: true },
  primary:       { width:  9.0, color: '#cf9a5a', markings: true,  carriage: true },
  secondary:     { width:  7.5, color: '#cfba5a', markings: true,  carriage: true },
  tertiary:      { width:  6.5, color: '#b8bf6a', markings: true,  carriage: true },
  unclassified:  { width:  5.0, color: '#9aa66f', markings: true,  carriage: true },
  residential:   { width:  4.5, color: '#8a9a8f', markings: true,  carriage: true },
  service:       { width:  3.0, color: '#8d939c', markings: false, carriage: true },
  living_street: { width:  4.0, color: '#8a9a8f', markings: false, carriage: true },
  pedestrian:    { width:  3.5, color: '#b0a8b8', markings: false, carriage: false },
  footway:       { width:  1.8, color: '#b8aFA6', markings: false, carriage: false },
  path:          { width:  1.5, color: '#b8afa6', markings: false, carriage: false },
  cycleway:      { width:  2.2, color: '#7e8a96', markings: false, carriage: false },
  track:         { width:  2.5, color: '#a89a7e', markings: false, carriage: false },
  steps:         { width:  1.5, color: '#b8afa6', markings: false, carriage: false },
  default:       { width:  4.0, color: '#8a9a8f', markings: false, carriage: true },
};

export const LANE_WIDTH = 3.0; // 1車線の標準幅(m)

// 路面標示の寸法（日本の実務上の標準採用値、単位m）
export const MARK = {
  edgeWidth: 0.15,        // 車道外側線の線幅
  edgeInset: 0.25,        // 路端からの内側オフセット
  minWidthForEdge: 4.5,   // 外側線を引く最小道路幅
  centerWidth: 0.15,      // 中央線の線幅
  centerDash: [5, 5],     // 中央線 白破線（線5m・間隔5m）
  minWidthForCenter: 5.5, // 中央線を引く最小道路幅
  solidCenterLanes: 4,    // この車線数以上は中央線を実線に
  laneWidth: 0.15,        // 車線境界線の線幅
  laneDash: [6, 9],       // 車線境界線 破線（線6m・間隔9m）
  stopWidth: 0.45,        // 停止線の太さ
  stopOffset: 2.0,        // 横断歩道手前のオフセット
  zebraStripe: 0.45,      // 横断歩道の縞幅
  zebraGap: 0.45,         // 縞の間隔
  zebraDepth: 4.0,        // 縞の長さ（＝車の進行方向の奥行き）
  arrowBefore: 7.0,       // 矢印を交差点端からどれだけ手前に置くか
  diamondBefore: 30.0,    // ダイヤマーク（横断歩道予告）の手前距離
  diamondEnabled: true,
  junctionTrimFactor: 1.15, // 交差点トリム = 相手道路の最大半幅×係数＋加算
  junctionTrimAdd: 0.5,
};

export const COLORS = {
  asphalt: '#41444b',
  asphaltMinor: '#4a4d54',
  casing: '#2b2d31',
  footway: '#9aa0a6',
  white: '#f2f2ec',
  yellow: '#e3a23c',
  building: '#d8d3cb',
  buildingLine: '#b9b3a8',
  ground: '#e9e7e1',
  green: '#7a9a6f',
};

// 建物用途 → 色（yotsuya_blender/build_yotsuya.py の配色を移植）
export const BUILDING_COLORS = {
  residential: '#d99e7a', house: '#e0ad85', apartments: '#c78c6b',
  detached: '#e0ad85', dormitory: '#c78c6b', terrace: '#d99e7a',
  office: '#527ab7', commercial: '#738cb2', retail: '#d9594c',
  supermarket: '#d9594c', shop: '#d9594c', kiosk: '#d9594c', hotel: '#8c6673',
  train_station: '#33384c', transportation: '#33384c',
  school: '#ebc773', university: '#d9a64c', kindergarten: '#f2cc80', college: '#d9a64c',
  hospital: '#f2f2f2', public: '#c7d98c', civic: '#c7d98c', government: '#a6b873',
  religious: '#73472e', temple: '#73472e', church: '#b3a694', shrine: '#733826', mosque: '#8c8066',
  industrial: '#666b7a', warehouse: '#596173', garage: '#73737a', garages: '#73737a',
  yes: '#9e998c', default: '#9e998c',
};
export const DEFAULT_BUILDING_HEIGHT = 9.0;
export const LEVELS_TO_METERS = 3.0;

// 手描き白線のプリセット
export const LINE_PRESETS = [
  { id: 'white15',   label: '白実線 15cm',              width: 0.15, color: 'white',  dash: null },
  { id: 'white15d5', label: '白破線 15cm（5m/5m）',      width: 0.15, color: 'white',  dash: [5, 5] },
  { id: 'white15d9', label: '白破線 15cm（6m/9m 車線）', width: 0.15, color: 'white',  dash: [6, 9] },
  { id: 'yellow15',  label: '黄実線 15cm',              width: 0.15, color: 'yellow', dash: null },
  { id: 'white30',   label: '白実線 30cm',              width: 0.30, color: 'white',  dash: null },
  { id: 'white45',   label: '白帯 45cm',                width: 0.45, color: 'white',  dash: null },
];

// 矢印などのステンシル形状（メートル単位、+Y方向＝進行方向、原点中心）
const TH = [[-0.15,-2.5],[0.15,-2.5],[0.15,1.0],[0.45,1.0],[0,2.5],[-0.45,1.0],[-0.15,1.0]];
const LEFT = [[-0.15,-2.5],[0.15,-2.5],[0.15,1.2],[-0.55,1.2],[-0.55,1.55],[-1.35,0.95],[-0.55,0.35],[-0.55,0.7],[-0.15,0.7]];
const RIGHT = LEFT.map(p => [-p[0], p[1]]);
const L_BRANCH = [[-0.15,0.7],[-0.55,0.7],[-0.55,0.35],[-1.35,0.95],[-0.55,1.55],[-0.55,1.2],[-0.15,1.2]];
const R_BRANCH = L_BRANCH.map(p => [-p[0], p[1]]);
export const STENCILS = {
  through: [TH],
  left: [LEFT],
  right: [RIGHT],
  through_left: [TH, L_BRANCH],
  through_right: [TH, R_BRANCH],
  diamond: [[[0, 4], [0.6, 0], [0, -4], [-0.6, 0]]],
};
export const STENCIL_LABELS = {
  through: '直進', left: '左折', right: '右折',
  through_left: '直進＋左折', through_right: '直進＋右折', diamond: 'ダイヤ',
};

// お試し範囲
export const TEST_BBOXES = {
  yotsuya:    { s: 35.6834, w: 139.7272, n: 35.6888, e: 139.7338 }, // 四ツ谷駅周辺
  kagurazaka: { s: 35.6995, w: 139.7370, n: 35.7045, e: 139.7430 }, // 神楽坂（坂）
  shibuya:    { s: 35.6575, w: 139.6980, n: 35.6615, e: 139.7030 }, // 渋谷スクランブル
};
