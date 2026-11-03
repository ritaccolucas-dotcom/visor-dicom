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

const PLANOS = [
  { id: 'axial',    label: 'Axial'    },
  { id: 'coronal',  label: 'Coronal'  },
  { id: 'sagital',  label: 'Sagital'  },
];

const state = {
  presetIdx: 0,
  slices: [],          // array de {rows, cols, pixelData, slope, intercept, instance}
  currentIdx: 0,
  plane: 'axial',
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
  // El total depende del plano: en coronal recorre filas y en sagital
  // columnas, no la cantidad de cortes.
  const total = geomPlano().count;
  idx = Math.max(0, Math.min(total - 1, idx));
  state.currentIdx = idx;
  $('slice-label').textContent = `${idx + 1} / ${total}`;
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

  // PixelSpacing viene como "<entre filas>\<entre columnas>", en mm. Sin esto
  // las reconstrucciones coronal y sagital salen deformadas, porque la
  // separación entre cortes casi nunca coincide con el tamaño del píxel
  // dentro del corte.
  let rowSpacing = 1, colSpacing = 1;
  const ps = ds.string('x00280030');
  if (ps) {
    const p = ps.split('\\');
    if (p.length === 2) {
      rowSpacing = parseFloat(p[0]) || 1;
      colSpacing = parseFloat(p[1]) || 1;
    }
  }

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

  return { rows, cols, pixelData, slope, intercept, instance, zPos, samplesPerPixel, seriesUID, seriesDesc, rowSpacing, colSpacing };
}

// ─── Reconstrucción multiplanar (MPR) ─────────────────────────────
// Coronal y sagital se arman muestreando los mismos cortes en otro eje:
// no hace falta descargar nada extra ni construir un volumen aparte.

/**
 * Separación entre cortes, en mm, sacada de las posiciones Z.
 * Usa la mediana y no el promedio para que un hueco en la serie no
 * estire toda la reconstrucción.
 */
function separacionCortes(slices) {
  if (slices.length < 2) return 1;
  const ds = [];
  for (let i = 1; i < slices.length; i++) {
    const d = Math.abs(slices[i].zPos - slices[i - 1].zPos);
    if (d > 1e-4) ds.push(d);
  }
  if (!ds.length) return 1;
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)];
}

const MAX_LADO = 2048;  // techo de seguridad para el canvas

/**
 * Dimensiones del plano actual, ya corregidas para que el píxel de salida
 * sea cuadrado. Remuestreamos acá en vez de deformar con CSS: así el canvas
 * conserva su aspecto real y el `image-rendering: pixelated` sigue siendo
 * fiel al dato original.
 */
function geomPlano() {
  const s = state.slices[0];
  const n = state.slices.length;
  const esp = separacionCortes(state.slices);
  const alto = (extensionMm, unidadMm) =>
    Math.max(1, Math.min(MAX_LADO, Math.round(extensionMm / unidadMm)));

  if (state.plane === 'coronal') {
    // Fijamos una fila; el ancho recorre columnas y el alto recorre cortes.
    return { count: s.rows, w: s.cols, h: alto(n * esp, s.colSpacing), nz: n };
  }
  if (state.plane === 'sagital') {
    // Fijamos una columna; el ancho recorre filas y el alto recorre cortes.
    return { count: s.cols, w: s.rows, h: alto(n * esp, s.rowSpacing), nz: n };
  }
  return { count: n, w: s.cols, h: alto(s.rows * s.rowSpacing, s.colSpacing), nz: n };
}

// ─── Render con windowing ─────────────────────────────────────────
function renderCurrent() {
  if (!state.slices.length || !state.canvas) return;
  const { w, h, nz } = geomPlano();
  const { ww, wc } = PRESETS[state.presetIdx];
  const lower = wc - ww / 2;
  const invWw = 255 / ww;
  const idx = state.currentIdx;
  const slices = state.slices;

  if (state.canvas.width !== w || state.canvas.height !== h) {
    state.canvas.width = w;
    state.canvas.height = h;
  }
  const imageData = state.ctx.createImageData(w, h);
  const out = imageData.data;

  // Z de la fila de pantalla v. Se invierte para que la cabeza quede
  // arriba: los cortes están ordenados con Z creciente.
  const zDe = (v) => {
    const z = Math.round((h - 1 - v) * (nz - 1) / Math.max(1, h - 1));
    return z < 0 ? 0 : (z >= nz ? nz - 1 : z);
  };

  // El plano se decide una vez y no por píxel: son cientos de miles de
  // iteraciones y la rama adentro del bucle se nota.
  let j = 0;
  if (state.plane === 'axial') {
    const s = slices[idx];
    const { pixelData, slope, intercept, cols, rows } = s;
    for (let v = 0; v < h; v++) {
      const y = Math.min(rows - 1, Math.round(v * (rows - 1) / Math.max(1, h - 1)));
      const fila = y * cols;
      for (let u = 0; u < w; u++) {
        let g = (pixelData[fila + u] * slope + intercept - lower) * invWw;
        g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = 255; j += 4;
      }
    }
  } else if (state.plane === 'coronal') {
    for (let v = 0; v < h; v++) {
      const s = slices[zDe(v)];
      const fila = idx * s.cols;
      const { pixelData, slope, intercept } = s;
      for (let u = 0; u < w; u++) {
        let g = (pixelData[fila + u] * slope + intercept - lower) * invWw;
        g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = 255; j += 4;
      }
    }
  } else {
    for (let v = 0; v < h; v++) {
      const s = slices[zDe(v)];
      const { pixelData, slope, intercept, cols } = s;
      for (let u = 0; u < w; u++) {
        let g = (pixelData[u * cols + idx] * slope + intercept - lower) * invWw;
        g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = 255; j += 4;
      }
    }
  }
  state.ctx.putImageData(imageData, 0, 0);
}

/**
 * Muestra el selector de plano y marca el activo.
 *
 * Con menos de 3 cortes no hay volumen que reconstruir, así que coronal y
 * sagital quedan ocultos en vez de ofrecer una imagen de una o dos líneas.
 */
function mostrarBotonesDePlano(slices) {
  const reconstruible = slices.length >= 3;
  for (const p of PLANOS) {
    const b = $(`plano-${p.id}`);
    if (!b) continue;
    b.style.display = (p.id === 'axial' || reconstruible) ? '' : 'none';
    b.classList.toggle('activo', p.id === state.plane);
  }
  const grupo = $('planos');
  if (grupo) grupo.style.display = reconstruible ? '' : 'none';
}

window.setPlano = function (id) {
  if (state.plane === id || !state.slices.length) return;
  state.plane = id;
  for (const p of PLANOS) {
    const b = $(`plano-${p.id}`);
    if (b) b.classList.toggle('activo', p.id === id);
  }
  // Arrancamos al medio: en coronal y sagital los extremos suelen ser aire.
  const { count } = geomPlano();
  $('slice-input').max = count - 1;
  setSlice(Math.floor(count / 2));
};

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
  // Al cambiar de serie volvemos a axial: el plano anterior pudo quedar
  // sin sentido si la serie nueva tiene otra geometría.
  state.plane = 'axial';

  const total = state.allSeries.reduce((acc, s) => acc + s.slices.length, 0);
  $('title').textContent = `DICOM · ${series.desc || 'Serie'}`;
  $('meta').textContent = `${series.slices.length} cortes` +
    (state.allSeries.length > 1 ? ` (de ${total})` : '');

  mostrarBotonesDePlano(series.slices);
  const { count } = geomPlano();
  $('slice-input').max = count - 1;
  setSlice(Math.floor(count / 2));
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
