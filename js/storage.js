// プロジェクトの保存・読み込み（JSONファイル＋localStorage自動保存）
const AUTOSAVE_KEY = 'machitrace_autosave_v1';

export function downloadFile(name, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function buildProject(state) {
  return {
    app: 'machi-trace', version: 1,
    bbox: state.bbox || null,
    photoOffset: state.photoOffset || { dx: 0, dy: 0 },
    traces: state.traces || [],
    settings: state.settings || {},
  };
}

export function saveProjectFile(state) {
  const json = JSON.stringify(buildProject(state), null, 1);
  downloadFile('machi-trace-project.json', json, 'application/json');
}

export function readProjectFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const obj = JSON.parse(r.result);
        if (obj.app !== 'machi-trace') throw new Error('machi-traceのプロジェクトファイルではありません');
        resolve(obj);
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(new Error('ファイルが読めませんでした'));
    r.readAsText(file);
  });
}

let saveTimer = null;
export function autosave(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildProject(state)));
    } catch (e) { /* 容量超過などは黙って無視（手動保存を促すのはmain側） */ }
  }, 1500);
}

export function loadAutosave() {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}
