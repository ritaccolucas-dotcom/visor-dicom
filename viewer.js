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

// Folder mode: bajamos cada DICOM individualmente, en paralelo (8 a la vez).
async function downloadFolderItems(items, baseUrl) {
  const dcmBuffers = [];
  let done = 0;
  const total = items.length;
  setLoading(`Descargando ${total} archivos…`, 5, `0/${total}`);

  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        const res = await fetch(`${baseUrl}&file=${encodeURIComponent(item.id)}`);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        // Magic check antes de agregar.
        if (buf.byteLength > 132) {
          const sig = String.fromCharCode(...new Uint8Array(buf, 128, 4));
          if (sig === 'DICM') dcmBuffers.push({ name: item.name, buf });
        }
      } catch { /* skip */ }
      done++;
      if (done % 5 === 0 || done === total) {
        const pct = 5 + (done / total) * 60;
        setLoading(`Descargando ${total} archivos…`, pct, `${done}/${total} · ${dcmBuffers.length} DICOM`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!dcmBuffers.length) {
    throw new Error(`Ningún archivo es DICOM (revisados ${total})`);
  }
  return dcmBuffers;
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

  return { rows, cols, pixelData, slope, intercept, instance, zPos, samplesPerPixel };
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
    let dcmBuffers;
    if (source.kind === 'folder') {
      const { manifest } = source;
      setLoading('Manifest recibido', 4,
        `${manifest.items?.length || 0} candidatos en carpeta`);
      if (!manifest.items?.length) {
        throw new Error(`La carpeta no tiene archivos DICOM (revisados ${manifest.total_found})`);
      }
      dcmBuffers = await downloadFolderItems(manifest.items, zipUrl);
    } else {
      dcmBuffers = await extractDicoms(source.blob);
    }

    setLoading('Parseando DICOMs…', 72, '');
    const slices = [];
    let skipped = 0;
    for (let i = 0; i < dcmBuffers.length; i++) {
      try {
        slices.push(parseSlice(dcmBuffers[i].buf));
      } catch (e) {
        skipped++;
      }
      if (i % 10 === 0) {
        const pct = 72 + ((i + 1) / dcmBuffers.length) * 25;
        setLoading('Parseando DICOMs…', pct, `${i + 1}/${dcmBuffers.length}`);
      }
    }
    if (!slices.length) {
      throw new Error(`Ningún DICOM tiene pixel data legible (${dcmBuffers.length} probados)`);
    }

    // Sort por InstanceNumber; fallback a zPos.
    slices.sort((a, b) => {
      if (a.instance && b.instance) return a.instance - b.instance;
      return a.zPos - b.zPos;
    });
    state.slices = slices;

    // Canvas setup.
    state.canvas = $('canvas');
    state.ctx = state.canvas.getContext('2d');

    // Slider.
    $('slice-input').max = slices.length - 1;
    $('slice-input').disabled = false;
    $('slice-input').addEventListener('input', (e) => setSlice(+e.target.value));

    // Scroll: rueda + swipe vertical.
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

    $('preset-btn').style.display = '';
    $('title').textContent = `DICOM · ${slices.length} cortes${skipped ? ` (${skipped} omitidos)` : ''}`;
    applyPreset();
    setSlice(Math.floor(slices.length / 2));
    hideLoading();
  } catch (e) {
    console.error(e);
    setError(e.message || 'Error desconocido', e.stack || '');
  }
}

main();
