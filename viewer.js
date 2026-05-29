// Visor DICOM v1 — stack legacy cornerstone-core, sin bundler.
// Pipeline: ?zip=<proxy URL> → fetch zip → JSZip extract .dcm
//        → registramos cada .dcm como imageId wadouri:// → cornerstone display.

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
  element: null,
};

const $ = (id) => document.getElementById(id);

function setLoading(text, pct, detail) {
  $('loading').style.display = 'flex';
  if (text !== undefined) $('loading-text').textContent = text;
  if (pct !== undefined) $('loading-bar').style.width = `${pct}%`;
  if (detail !== undefined) $('loading-detail').textContent = detail;
}
function hideLoading() { $('loading').style.display = 'none'; }

function setError(msg, detail) {
  $('loading').style.display = 'flex';
  $('loading').innerHTML = `
    <div class="error-card">
      <div style="font-size:2rem">⚠️</div>
      <h2 style="font-size:1rem;margin:.5rem 0">${msg}</h2>
      ${detail ? `<pre style="font-size:.7rem;color:#94a3b8;white-space:pre-wrap;word-break:break-word;text-align:left;background:#0d1117;padding:.5rem;border-radius:6px;max-height:200px;overflow:auto;">${detail}</pre>` : ''}
      <a href="javascript:goBack()" style="color:var(--accent);font-size:.85rem;text-decoration:none;display:inline-block;margin-top:.5rem;">← Volver</a>
    </div>`;
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
  if (!state.element) return;
  const viewport = cornerstone.getViewport(state.element);
  if (!viewport) return;
  viewport.voi.windowWidth = p.ww;
  viewport.voi.windowCenter = p.wc;
  cornerstone.setViewport(state.element, viewport);
}

function setSlice(idx) {
  if (!state.imageIds.length) return;
  idx = Math.max(0, Math.min(state.imageIds.length - 1, idx));
  state.currentIdx = idx;
  cornerstone.loadImage(state.imageIds[idx]).then((image) => {
    cornerstone.displayImage(state.element, image);
    // Reaplicamos windowing del preset actual.
    const p = PRESETS[state.presetIdx];
    const viewport = cornerstone.getViewport(state.element);
    viewport.voi.windowWidth = p.ww;
    viewport.voi.windowCenter = p.wc;
    cornerstone.setViewport(state.element, viewport);
  }).catch((e) => {
    console.error('loadImage failed', e);
  });
  $('slice-label').textContent = `${idx + 1} / ${state.imageIds.length}`;
  $('slice-input').value = idx;
}

// ─── Drive zip download with progress ─────────────────────────────
async function downloadZip(url) {
  setLoading('Descargando zip…', 5, '');
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
    const pct = total ? 5 + (received / total) * 55 : 30;
    const mb = (received / 1024 / 1024).toFixed(1);
    const totalMb = total ? ` / ${(total / 1024 / 1024).toFixed(0)} MB` : '';
    setLoading('Descargando zip…', pct, `${mb} MB${totalMb}`);
  }
  return new Blob(chunks);
}

// ─── Unzip + collect .dcm files ───────────────────────────────────
async function extractDicoms(zipBlob) {
  setLoading('Descomprimiendo…', 62, '');
  const zip = await JSZip.loadAsync(zipBlob);

  // Filtramos por extensión + por magic number DICM al offset 128.
  const candidates = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const lower = path.toLowerCase();
    // Ignoramos archivos de macOS, READMEs, etc.
    if (lower.includes('__macosx') || lower.endsWith('.ds_store')) return;
    candidates.push(entry);
  });

  if (!candidates.length) {
    throw new Error('El zip está vacío');
  }

  setLoading(`Leyendo ${candidates.length} archivos…`, 65, '');
  const dcmFiles = [];
  for (let i = 0; i < candidates.length; i++) {
    const entry = candidates[i];
    const buf = await entry.async('arraybuffer');
    // Magic check: bytes 128-131 deben ser "DICM" para DICOM Part 10.
    if (buf.byteLength > 132) {
      const sig = String.fromCharCode(
        ...new Uint8Array(buf, 128, 4),
      );
      if (sig === 'DICM') {
        dcmFiles.push({ name: entry.name, buf });
      }
    }
    if (i % 10 === 0) {
      const pct = 65 + ((i + 1) / candidates.length) * 25;
      setLoading(`Leyendo archivos…`, pct, `${i + 1}/${candidates.length}`);
    }
  }

  if (!dcmFiles.length) {
    throw new Error(`Ningún archivo en el zip es DICOM (revisados ${candidates.length})`);
  }
  return dcmFiles;
}

// ─── Cornerstone init ──────────────────────────────────────────────
function initCornerstone() {
  // Wire external deps que el image loader espera.
  cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
  cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
  // Configuración mínima — sin web workers para evitar problemas de path.
  cornerstoneWADOImageLoader.configure({
    useWebWorkers: false,
    decodeConfig: { convertFloatPixelDataToInt: false },
  });
}

// Convierte cada DICOM en blob URL y arma imageIds con scheme wadouri:
function registerImageIds(dcmFiles) {
  return dcmFiles.map(({ buf }) => {
    const blob = new Blob([buf], { type: 'application/dicom' });
    const url = URL.createObjectURL(blob);
    return `wadouri:${url}`;
  });
}

// Ordena los imageIds por InstanceNumber leyendo metadata de cada uno.
async function sortByInstanceNumber(imageIds) {
  const withMeta = await Promise.all(imageIds.map(async (id) => {
    try {
      const image = await cornerstone.loadAndCacheImage(id);
      const ds = image.data;
      // InstanceNumber está en (0020,0013).
      const inst = ds?.intString?.('x00200013') ?? 0;
      return { id, inst };
    } catch {
      return { id, inst: 0 };
    }
  }));
  withMeta.sort((a, b) => a.inst - b.inst);
  return withMeta.map((x) => x.id);
}

async function renderFromDicoms(dcmFiles) {
  setLoading('Inicializando visor…', 92, '');
  initCornerstone();
  state.element = $('viewport');
  cornerstone.enable(state.element);

  setLoading('Indexando cortes…', 95, '');
  const rawIds = registerImageIds(dcmFiles);
  state.imageIds = await sortByInstanceNumber(rawIds);

  $('slice-input').max = state.imageIds.length - 1;
  $('slice-input').disabled = false;
  $('slice-input').addEventListener('input', (e) => setSlice(+e.target.value));

  // Scroll de slices con rueda + touch swipe vertical.
  state.element.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    setSlice(state.currentIdx + dir);
  }, { passive: false });

  let touchStartY = null;
  state.element.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) touchStartY = e.touches[0].clientY;
  }, { passive: true });
  state.element.addEventListener('touchmove', (e) => {
    if (touchStartY == null) return;
    const dy = touchStartY - e.touches[0].clientY;
    if (Math.abs(dy) > 18) {
      setSlice(state.currentIdx + Math.sign(dy));
      touchStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  $('preset-btn').style.display = '';
  $('title').textContent = `DICOM · ${state.imageIds.length} cortes`;
  applyPreset();
  setSlice(Math.floor(state.imageIds.length / 2));
  hideLoading();
}

// ─── Main ──────────────────────────────────────────────────────────
(async function main() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('return')) $('back-btn').style.display = '';

  const zipUrl = params.get('zip');
  if (!zipUrl) {
    setError('Falta parámetro ?zip=<URL del zip DICOM>');
    return;
  }

  // Sanity check de que las libs cargaron desde CDN.
  const missing = [];
  if (typeof JSZip === 'undefined') missing.push('JSZip');
  if (typeof dicomParser === 'undefined') missing.push('dicomParser');
  if (typeof cornerstone === 'undefined') missing.push('cornerstone');
  // El loader expone window.cornerstoneWADOImageLoader.
  if (typeof cornerstoneWADOImageLoader === 'undefined') missing.push('cornerstoneWADOImageLoader');
  if (missing.length) {
    const globals = Object.keys(window).filter((k) =>
      /cornerstone|dicom|jszip/i.test(k)).join(', ') || '(ninguno)';
    setError(
      `No cargaron: ${missing.join(', ')}`,
      `Globals presentes que matchean: ${globals}\n\nProbá hard-refresh o avisame si el CDN está caído.`,
    );
    return;
  }

  try {
    const zipBlob = await downloadZip(zipUrl);
    const dcmFiles = await extractDicoms(zipBlob);
    await renderFromDicoms(dcmFiles);
  } catch (e) {
    console.error(e);
    setError(e.message || 'Error desconocido', e.stack || '');
  }
})();
