// Visor DICOM v1 — render directo a canvas con dicom-parser.
//
// Pipeline:
//   ?zip=<proxy URL> → fetch zip → JSZip extract .dcm
//   → para cada uno: dicomParser.parseDicom() → extraemos pixel data
//   → ordenamos por InstanceNumber → renderizamos al canvas aplicando
//     windowing.
//
// Soporta DICOM uncompressed (transfer syntax Implicit/Explicit Little
// Endian), que es lo que exporta Mimics/Horos/MicroDicom y los CTs de
// hospital normales. Compressed (JPEG/JPEG2000) NO — para esos hace
// falta una lib de decompresión.

const PRESETS = [
  { label: 'Bone',         ww: 1500, wc: 400  },
  { label: 'Soft Tissue',  ww: 400,  wc: 40   },
  { label: 'Brain',        ww: 80,   wc: 40   },
  { label: 'Lung',         ww: 1500, wc: -600 },
];

const state = {
  presetIdx: 0,
  slices: [],          // array de {rows, cols, pixelData, slope, intercept, instance}
  currentIdx: 0,
  canvas: null,
  ctx: null,
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
  renderCurrent();
}

function setSlice(idx) {
  if (!state.slices.length) return;
  idx = Math.max(0, Math.min(state.slices.length - 1, idx));
  state.currentIdx = idx;
  $('slice-label').textContent = `${idx + 1} / ${state.slices.length}`;
  $('slice-input').value = idx;
  renderCurrent();
}

// ─── Source fetch: zip OR folder manifest ─────────────────────────
async function fetchSource(url) {
  setLoading('Consultando manifest…', 3, '');
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Fetch network error\nURL: ${url}\n\n${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}\nURL: ${url}\n\n${body.slice(0, 300)}`);
  }
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const manifest = await res.json();
    return { kind: 'folder', manifest };
  }
  // Modo zip: stream con progress.
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = total ? 5 + (received / total) * 45 : 30;
    const mb = (received / 1024 / 1024).toFixed(1);
    const totalMb = total ? ` / ${(total / 1024 / 1024).toFixed(0)} MB` : '';
    setLoading('Descargando zip…', pct, `${mb} MB${totalMb}`);
  }
  return { kind: 'zip', blob: new Blob(chunks) };
}

// Folder mode con streaming: cada DICOM bajado va al callback onSlice.
// Quien llama decide si arrancar el viewer cuando hay un mínimo y seguir
// agregando cortes en background.
async function downloadFolderItemsStream(items, baseUrl, onSlice, onProgress) {
  let done = 0, ok = 0;
  const total = items.length;

  const CONCURRENCY = 16;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        const res = await fetch(`${baseUrl}&file=${encodeURIComponent(item.id)}`);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 132) {
            const sig = String.fromCharCode(...new Uint8Array(buf, 128, 4));
            if (sig === 'DICM') {
              ok++;
              onSlice({ name: item.name, buf });
            }
          }
        }
      } catch { /* skip */ }
      done++;
      onProgress(done, total, ok);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!ok) throw new Error(`Ningún archivo es DICOM (revisados ${total})`);
  return ok;
}

// ─── Unzip + collect DICOM (magic-checked) ────────────────────────
async function extractDicoms(zipBlob) {
  setLoading('Descomprimiendo…', 52, '');
  const zip = await JSZip.loadAsync(zipBlob);

  const candidates = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const lower = path.toLowerCase();
    if (lower.includes('__macosx') || lower.endsWith('.ds_store')) return;
    candidates.push(entry);
  });
  if (!candidates.length) throw new Error('El zip está vacío');

  setLoading(`Leyendo ${candidates.length} archivos…`, 55, '');
  const dcmBuffers = [];
  for (let i = 0; i < candidates.length; i++) {
    const buf = await candidates[i].async('arraybuffer');
    // DICOM Part 10: magic "DICM" en bytes 128..131.
    if (buf.byteLength > 132) {
      const sig = String.fromCharCode(...new Uint8Array(buf, 128, 4));
      if (sig === 'DICM') dcmBuffers.push({ name: candidates[i].name, buf });
    }
    if (i % 10 === 0) {
      const pct = 55 + ((i + 1) / candidates.length) * 15;
      setLoading('Leyendo archivos…', pct, `${i + 1}/${candidates.length}`);
    }
  }
  if (!dcmBuffers.length) {
    throw new Error(`Ningún archivo es DICOM (revisados ${candidates.length})`);
  }
  return dcmBuffers;
}

// ─── DICOM parse + pixel extract ──────────────────────────────────
function parseSlice(buf) {
  const ds = dicomParser.parseDicom(new Uint8Array(buf));

  const rows = ds.uint16('x00280010') || 0;
  const cols = ds.uint16('x00280011') || 0;
  const bitsAllocated = ds.uint16('x00280100') || 16;
  const pixelRepresentation = ds.uint16('x00280103') || 0;  // 0 unsigned, 1 signed
  const samplesPerPixel = ds.uint16('x00280002') || 1;
  const slope = parseFloat(ds.string('x00281053')) || 1;
  const intercept = parseFloat(ds.string('x00281052')) || 0;
  const instance = parseInt(ds.string('x00200013'), 10) || 0;
  const position = ds.string('x00200032');  // ImagePositionPatient
  // Para sortear si InstanceNumber no está, podemos usar Z de position.
  let zPos = 0;
  if (position) {
    const parts = position.split('\\');
    if (parts.length === 3) zPos = parseFloat(parts[2]);
  }
  // SeriesInstanceUID identifica cada serie (axial, coronal, bone window,
  // soft tissue, etc.). Agrupamos por esto para que el visor muestre una
  // sola serie a la vez en vez de mezclar 2500 cortes inutilizables.
  const seriesUID = ds.string('x0020000e') || '__default__';
  const seriesDesc = ds.string('x0008103e') || ds.string('x00081030') || 'Serie';

  const pixelDataElement = ds.elements.x7fe00010;
  if (!pixelDataElement) throw new Error('No tiene PixelData');

  let pixelData;
  if (bitsAllocated === 16) {
    if (pixelRepresentation === 1) {
      pixelData = new Int16Array(buf, pixelDataElement.dataOffset, pixelDataElement.length / 2);
    } else {
      pixelData = new Uint16Array(buf, pixelDataElement.dataOffset, pixelDataElement.length / 2);
    }
  } else if (bitsAllocated === 8) {
    if (pixelRepresentation === 1) {
      pixelData = new Int8Array(buf, pixelDataElement.dataOffset, pixelDataElement.length);
    } else {
      pixelData = new Uint8Array(buf, pixelDataElement.dataOffset, pixelDataElement.length);
    }
  } else {
    throw new Error(`bitsAllocated=${bitsAllocated} no soportado`);
  }

  return { rows, cols, pixelData, slope, intercept, instance, zPos, samplesPerPixel, seriesUID, seriesDesc };
}

// ─── Render con windowing ─────────────────────────────────────────
function renderCurrent() {
  if (!state.slices.length || !state.canvas) return;
  const s = state.slices[state.currentIdx];
  const { rows, cols, pixelData, slope, intercept } = s;
  const { ww, wc } = PRESETS[state.presetIdx];
  const lower = wc - ww / 2;

  // Resize canvas a las dimensiones del slice solo si cambia.
  if (state.canvas.width !== cols || state.canvas.height !== rows) {
    state.canvas.width = cols;
    state.canvas.height = rows;
  }
  const imageData = state.ctx.createImageData(cols, rows);
  const out = imageData.data;
  // Pre-cálculo
  const invWw = 255 / ww;
  for (let i = 0; i < pixelData.length; i++) {
    const hu = pixelData[i] * slope + intercept;
    let v = (hu - lower) * invWw;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    else v = v | 0;
    const j = i * 4;
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  state.ctx.putImageData(imageData, 0, 0);
}

// ─── Series rebuild + bootstrap ───────────────────────────────────
function rebuildAllSeries() {
  state.allSeries = Array.from(state.seriesMap.values())
    .sort((a, b) => b.slices.length - a.slices.length);
}
function getTotalAcrossSeries() {
  return state.allSeries.reduce((acc, s) => acc + s.slices.length, 0);
}
function bootstrapViewer() {
  state.bootstrapped = true;
  buildSeriesPicker();
  selectSeries(state.allSeries[0].uid);
  hideLoading();
}
function refreshSeriesPickerLabels() {
  const picker = document.getElementById('series-picker');
  if (!picker) return;
  // Si cambia la cantidad de series, re-construimos.
  if (picker.options.length !== state.allSeries.length) {
    buildSeriesPicker();
    if (state.currentSeriesUID) {
      document.getElementById('series-picker').value = state.currentSeriesUID;
    }
    return;
  }
  for (let i = 0; i < state.allSeries.length; i++) {
    const s = state.allSeries[i];
    picker.options[i].textContent = `${s.desc || 'Serie'} · ${s.slices.length} cortes`;
  }
}

// ─── Series picker ────────────────────────────────────────────────
function buildSeriesPicker() {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;
  let picker = document.getElementById('series-picker');
  if (picker) picker.remove();

  if (!state.allSeries || state.allSeries.length < 2) return;

  picker = document.createElement('select');
  picker.id = 'series-picker';
  picker.className = 'tb-btn';
  picker.style.cssText = 'padding:.35rem .6rem;max-width:240px;';
  for (const s of state.allSeries) {
    const opt = document.createElement('option');
    opt.value = s.uid;
    opt.textContent = `${s.desc || 'Serie'} · ${s.slices.length} cortes`;
    picker.appendChild(opt);
  }
  picker.addEventListener('change', (e) => selectSeries(e.target.value));
  // Insertar después de #meta.
  const meta = document.getElementById('meta');
  if (meta && meta.nextSibling) topbar.insertBefore(picker, meta.nextSibling);
  else topbar.appendChild(picker);
}

function selectSeries(uid) {
  const series = state.allSeries.find((s) => s.uid === uid);
  if (!series) return;
  state.slices = series.slices;
  state.currentSeriesUID = uid;
  state.currentIdx = Math.floor(series.slices.length / 2);

  const total = state.allSeries.reduce((acc, s) => acc + s.slices.length, 0);
  $('title').textContent = `DICOM · ${series.desc || 'Serie'}`;
  $('meta').textContent = `${series.slices.length} cortes` +
    (state.allSeries.length > 1 ? ` (de ${total})` : '');

  $('slice-input').max = series.slices.length - 1;
  setSlice(state.currentIdx);
  const picker = document.getElementById('series-picker');
  if (picker) picker.value = uid;
}

// ─── Main pipeline ────────────────────────────────────────────────
async function main() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('return')) $('back-btn').style.display = '';

  const zipUrl = params.get('zip');
  if (!zipUrl) {
    setError('Falta parámetro ?zip=<URL del zip DICOM>');
    return;
  }
  if (typeof JSZip === 'undefined') {
    setError('JSZip no cargó');
    return;
  }
  if (typeof dicomParser === 'undefined') {
    setError('dicomParser no cargó');
    return;
  }

  try {
    const source = await fetchSource(zipUrl);

    // Inicializamos estructuras de series. Se rellenan progresivamente.
    state.seriesMap = new Map();  // uid → { uid, desc, slices: [] }
    state.allSeries = [];          // mismo contenido, ordenado por size
    state.bootstrapped = false;
    const MIN_TO_BOOTSTRAP = 20;

    // Canvas + listeners listos desde ya — pero oculto hasta que tengamos algo.
    state.canvas = $('canvas');
    state.ctx = state.canvas.getContext('2d');
    $('slice-input').disabled = false;
    $('slice-input').addEventListener('input', (e) => setSlice(+e.target.value));

    // Scroll: rueda + swipe vertical. Activos desde el bootstrap.
    const wrap = document.getElementById('viewport-wrap');
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      setSlice(state.currentIdx + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });
    let touchStartY = null;
    wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) touchStartY = e.touches[0].clientY;
    }, { passive: true });
    wrap.addEventListener('touchmove', (e) => {
      if (touchStartY == null) return;
      const dy = touchStartY - e.touches[0].clientY;
      if (Math.abs(dy) > 12) {
        setSlice(state.currentIdx + Math.sign(dy));
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    const ingestBuffer = (buf) => {
      let slice;
      try { slice = parseSlice(buf); } catch { return; }
      let entry = state.seriesMap.get(slice.seriesUID);
      if (!entry) {
        entry = { uid: slice.seriesUID, desc: slice.seriesDesc, slices: [] };
        state.seriesMap.set(slice.seriesUID, entry);
      }
      // Insertar manteniendo orden (binary search no aporta a esta escala).
      entry.slices.push(slice);
      // Mini-sort puntual al final del array (los DICOMs llegan desordenados).
      for (let i = entry.slices.length - 1; i > 0; i--) {
        const a = entry.slices[i - 1], b = entry.slices[i];
        const cmp = (a.instance && b.instance) ? a.instance - b.instance : a.zPos - b.zPos;
        if (cmp > 0) { entry.slices[i - 1] = b; entry.slices[i] = a; }
        else break;
      }
      // Actualizar allSeries y bootstrappear si llegamos al threshold.
      rebuildAllSeries();
      if (!state.bootstrapped) {
        const totalSoFar = state.allSeries.reduce((acc, s) => acc + s.slices.length, 0);
        if (totalSoFar >= MIN_TO_BOOTSTRAP) bootstrapViewer();
      } else if (state.currentSeriesUID) {
        // Actualizar slider/contador si crece la serie actual.
        const cur = state.seriesMap.get(state.currentSeriesUID);
        if (cur) {
          $('slice-input').max = cur.slices.length - 1;
          $('meta').textContent = `${cur.slices.length} cortes`
            + (state.allSeries.length > 1 ? ` (de ${getTotalAcrossSeries()})` : '');
        }
        refreshSeriesPickerLabels();
      }
    };

    if (source.kind === 'folder') {
      const { manifest } = source;
      if (!manifest.items?.length) {
        throw new Error(`La carpeta no tiene archivos DICOM (revisados ${manifest.total_found})`);
      }
      setLoading(`Descargando ${manifest.items.length} archivos…`, 5,
        `0/${manifest.items.length}`);
      await downloadFolderItemsStream(
        manifest.items, zipUrl,
        ({ buf }) => ingestBuffer(buf),
        (done, total, ok) => {
          if (state.bootstrapped) return;  // ya estamos visualizando
          if (done % 5 === 0 || done === total) {
            const pct = 5 + (done / total) * 60;
            setLoading(`Descargando ${total} archivos…`, pct,
              `${done}/${total} · ${ok} DICOM`);
          }
        },
      );
    } else {
      const dcmBuffers = await extractDicoms(source.blob);
      setLoading('Parseando DICOMs…', 72, '');
      for (let i = 0; i < dcmBuffers.length; i++) {
        ingestBuffer(dcmBuffers[i].buf);
        if (i % 20 === 0) {
          const pct = 72 + ((i + 1) / dcmBuffers.length) * 25;
          setLoading('Parseando DICOMs…', pct, `${i + 1}/${dcmBuffers.length}`);
        }
      }
    }

    if (!state.bootstrapped) bootstrapViewer();  // por si quedaron < MIN
    $('preset-btn').style.display = '';
    applyPreset();
    hideLoading();
  } catch (e) {
    console.error(e);
    setError(e.message || 'Error desconocido', e.stack || '');
  }
}

main();
