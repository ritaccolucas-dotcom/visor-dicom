// Visor DICOM v1 mínimo.
// Pipeline: ?zip=<proxy URL> → fetch zip → JSZip extrae .dcm → cornerstone3D
// renderiza axial + slider. Sin MPR ni mediciones todavía.
//
// Cornerstone3D, image-loader y tools vienen como ESM directo desde el CDN
// de jsdelivr — Three.js style "sin bundler".

import * as cornerstone from 'https://cdn.jsdelivr.net/npm/@cornerstonejs/core@1.86.0/+esm';
import * as cornerstoneTools from 'https://cdn.jsdelivr.net/npm/@cornerstonejs/tools@1.86.0/+esm';
import * as csImageLoader from 'https://cdn.jsdelivr.net/npm/@cornerstonejs/dicom-image-loader@1.86.0/+esm';

const { RenderingEngine, Enums, init: csInit, imageLoader, metaData, volumeLoader } = cornerstone;
const { ViewportType } = Enums;

const PRESETS = [
  { label: 'Bone',         ww: 1500, wc: 400  },
  { label: 'Soft Tissue',  ww: 400,  wc: 40   },
  { label: 'Brain',        ww: 80,   wc: 40   },
  { label: 'Lung',         ww: 1500, wc: -600 },
];

const state = {
  presetIdx: 0,
  imageIds: [],
  currentIdx: 0,
  viewportId: 'CT_AXIAL',
  renderingEngineId: 'RE_MAIN',
  viewport: null,
  renderingEngine: null,
};

// ─── Wiring UI ───────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function setLoading(text, pct, detail) {
  $('loading').style.display = 'flex';
  if (text) $('loading-text').textContent = text;
  if (pct !== undefined) $('loading-bar').style.width = `${pct}%`;
  if (detail !== undefined) $('loading-detail').textContent = detail;
}
function hideLoading() { $('loading').style.display = 'none'; }
function setError(msg) {
  $('loading').innerHTML = `<div class="error-card"><div style="font-size:2rem">⚠️</div><h2 style="font-size:1rem;margin:.5rem 0">${msg}</h2><a href="/" style="color:var(--accent);font-size:.85rem;text-decoration:none">← Volver</a></div>`;
}

window.goBack = function () {
  const url = new URLSearchParams(window.location.search).get('return');
  if (url) window.location.href = decodeURIComponent(url);
  else history.back();
};

window.cyclePreset = function () {
  state.presetIdx = (state.presetIdx + 1) % PRESETS.length;
  applyPreset();
};

function applyPreset() {
  const p = PRESETS[state.presetIdx];
  $('preset-btn').textContent = p.label;
  $('wl-label').textContent = `W ${p.ww} · L ${p.wc}`;
  if (state.viewport) {
    state.viewport.setProperties({ voiRange: { lower: p.wc - p.ww / 2, upper: p.wc + p.ww / 2 } });
    state.viewport.render();
  }
}

function setSlice(idx) {
  if (!state.viewport || !state.imageIds.length) return;
  idx = Math.max(0, Math.min(state.imageIds.length - 1, idx));
  state.currentIdx = idx;
  state.viewport.setImageIdIndex(idx);
  $('slice-label').textContent = `${idx + 1} / ${state.imageIds.length}`;
  $('slice-input').value = idx;
}

// ─── Drive zip download with progress ───────────────────────────────
async function downloadZip(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Descarga falló: HTTP ${res.status}`);
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = total ? (received / total) * 60 : 30;
    const mb = (received / 1024 / 1024).toFixed(1);
    const totalMb = total ? `/ ${(total / 1024 / 1024).toFixed(0)}MB` : '';
    setLoading('Descargando zip…', pct, `${mb}MB ${totalMb}`);
  }
  const blob = new Blob(chunks);
  return blob;
}

// ─── Unzip + collect .dcm files ─────────────────────────────────────
async function extractDicoms(zipBlob) {
  setLoading('Descomprimiendo…', 65);
  const zip = await JSZip.loadAsync(zipBlob);
  const dcmFiles = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    // Aceptamos .dcm explícito o sin extensión (DICOM sin .dcm es común).
    const lower = path.toLowerCase();
    const ext = lower.split('.').pop();
    if (ext === 'dcm' || ext === 'ima' || !/\.[a-z]+$/.test(lower)) {
      dcmFiles.push(entry);
    }
  });
  if (!dcmFiles.length) throw new Error('El zip no contiene archivos DICOM');

  setLoading(`Cargando ${dcmFiles.length} imágenes…`, 70);
  const dataArr = [];
  for (let i = 0; i < dcmFiles.length; i++) {
    const buf = await dcmFiles[i].async('arraybuffer');
    dataArr.push({ name: dcmFiles[i].name, buf });
    const pct = 70 + ((i + 1) / dcmFiles.length) * 25;
    if (i % 10 === 0) setLoading(`Cargando ${dcmFiles.length} imágenes…`, pct, `${i + 1}/${dcmFiles.length}`);
  }
  return dataArr;
}

// ─── Cornerstone3D init + render ────────────────────────────────────
async function setupCornerstone() {
  await csInit();
  await csImageLoader.init({ maxWebWorkers: 1 });
  // Asociamos dicomParser (lo trajo el script de dicom-parser CDN).
  csImageLoader.external.dicomParser = window.dicomParser;
}

async function renderFromDicoms(dicoms) {
  setLoading('Inicializando visor…', 96);
  await setupCornerstone();

  // Registramos cada DICOM como un blob URL servido por wadouri.
  const imageIds = dicoms.map(({ name, buf }) => {
    const blob = new Blob([buf], { type: 'application/dicom' });
    const url = URL.createObjectURL(blob);
    return `wadouri:${url}`;
  });

  // Ordenamos por InstanceNumber (Cornerstone3D ya lo hace si la metadata
  // está bien, pero por las dudas no asumimos orden de archivo).
  // En v1 dejamos el orden del zip.
  state.imageIds = imageIds;

  // Creamos rendering engine + viewport stack (axial básico).
  state.renderingEngine = new RenderingEngine(state.renderingEngineId);
  const element = $('viewport');
  const viewportInput = {
    viewportId: state.viewportId,
    type: ViewportType.STACK,
    element,
  };
  state.renderingEngine.enableElement(viewportInput);
  state.viewport = state.renderingEngine.getViewport(state.viewportId);
  await state.viewport.setStack(imageIds, 0);

  // Aplicamos preset inicial (Bone — el más útil para STL alignment).
  applyPreset();

  // Habilitamos el slider.
  $('slice-input').max = imageIds.length - 1;
  $('slice-input').disabled = false;
  $('slice-input').addEventListener('input', (e) => setSlice(+e.target.value));

  // Mouse wheel = cambiar slice. Pinch/drag = scroll.
  element.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    setSlice(state.currentIdx + dir);
  }, { passive: false });

  // Touch swipe vertical = scroll slices.
  let touchStartY = null;
  element.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) touchStartY = e.touches[0].clientY;
  }, { passive: true });
  element.addEventListener('touchmove', (e) => {
    if (touchStartY == null) return;
    const dy = touchStartY - e.touches[0].clientY;
    if (Math.abs(dy) > 18) {
      const step = Math.sign(dy);
      setSlice(state.currentIdx + step);
      touchStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  $('preset-btn').style.display = '';
  $('title').textContent = `DICOM · ${imageIds.length} cortes`;
  $('meta').textContent = '';
  setSlice(Math.floor(imageIds.length / 2));  // arrancamos en el medio
  hideLoading();
}

// ─── Main ────────────────────────────────────────────────────────────
(async function main() {
  // Botón de volver al dashboard si vinimos con ?return=.
  const params = new URLSearchParams(window.location.search);
  if (params.get('return')) $('back-btn').style.display = '';

  const zipUrl = params.get('zip');
  if (!zipUrl) {
    setError('Falta parámetro ?zip=<URL del zip DICOM>');
    return;
  }

  try {
    const zipBlob = await downloadZip(zipUrl);
    const dicoms = await extractDicoms(zipBlob);
    await renderFromDicoms(dicoms);
  } catch (e) {
    console.error(e);
    setError(e.message || 'Error desconocido');
  }
})();
