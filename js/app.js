import {
  bearingOfVector, deflection, reconstruct, fitElevation, generateSyntheticRoute, SAMPLE_TRUE_ROUTE,
  detectArcs, toDXF, toLandXML,
  SAMPLE_CURVE_ROUTE, UNITS, pipeWidthInUnits
} from './algorithm.js';
import { extractLines, projectLine, polylineLength, simulateSurvey } from './geojson.js';
import { compareToReference, FEET } from './fidelity.js';

/* ---------------- state ---------------- */
let rawPoints = [];   // {x,y,z,pt,desc}
let parsedRows = [];
let headers = [];
let geoLines = [];    // lines found in an imported GeoJSON file
let geoActive = false; // true while the loaded data came from GeoJSON
let referenceLine = null; // clean GeoJSON centreline in survey units (ground truth for the fidelity check)
let result = null;
let elements = [];        // line/arc elements from detectArcs(), used for rendering + export
let draggedVertexIndex = -1;

/* ---------------- DOM refs ---------------- */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const filenameEl = document.getElementById('filename');
const mappingEl = document.getElementById('mapping');
const mapX = document.getElementById('mapX'), mapY = document.getElementById('mapY'),
      mapZ = document.getElementById('mapZ'), mapPt = document.getElementById('mapPt'),
      mapDesc = document.getElementById('mapDesc');
const widthSlider = document.getElementById('widthSlider'), widthVal = document.getElementById('widthVal');
const deflSlider = document.getElementById('deflSlider'), deflVal = document.getElementById('deflVal');
const minPtsSlider = document.getElementById('minPtsSlider'), minPtsVal = document.getElementById('minPtsVal');
const reconstructBtn = document.getElementById('reconstructBtn');
const statIn = document.getElementById('statIn'), statOut = document.getElementById('statOut'),
      statReduction = document.getElementById('statReduction'), statMaxResidual = document.getElementById('statMaxResidual'),
      statOutliers = document.getElementById('statOutliers'), statLength = document.getElementById('statLength');
const plotCanvas = document.getElementById('plot');
const plotCtx = plotCanvas.getContext('2d');
const profileCanvas = document.getElementById('profile');
const profileCtx = profileCanvas.getContext('2d');
const emptyState = document.getElementById('emptyState');
const vertexBody = document.getElementById('vertexBody');
const qaBody = document.getElementById('qaBody');
const downloadVerticesBtn = document.getElementById('downloadVerticesBtn');
const downloadDXFBtn = document.getElementById('downloadDXFBtn');
const downloadXMLBtn = document.getElementById('downloadXMLBtn');
const printBtn = document.getElementById('printBtn');
const sample8Btn = document.getElementById('sample8');
const sample36Btn = document.getElementById('sample36');
const sampleCurveBtn = document.getElementById('sampleCurve');
const unitSelect = document.getElementById('unitSelect');
const arcToggle = document.getElementById('arcToggle');
const autoTuneBtn = document.getElementById('autoTuneBtn');
const geoPicker = document.getElementById('geoPicker'), geoSelect = document.getElementById('geoSelect'),
      geoFilter = document.getElementById('geoFilter'), geoNoise = document.getElementById('geoNoise'),
      geoInfo = document.getElementById('geoInfo');

/* ---------------- CSV / GeoJSON import ---------------- */
dropzone.addEventListener('click', () => fileInput.click());
['dragover', 'dragenter'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
fileInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); });

function handleFile(file) {
  filenameEl.textContent = file.name;
  filenameEl.classList.add('show');
  if (/\.(geojson|json)$/i.test(file.name) || /json/i.test(file.type)) { handleGeoJSON(file); return; }
  geoActive = false;
  geoPicker.style.display = 'none';
  window.Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: res => {
      headers = res.meta.fields || [];
      parsedRows = res.data;
      populateMapping();
      mappingEl.style.display = 'block';
      reconstructBtn.disabled = false;
      autoTuneBtn.disabled = false;
    },
    error: err => alert('Could not parse that CSV: ' + err.message)
  });
}

/* ---- GeoJSON: lon/lat lines -> projected X/Y in the chosen survey unit ---- */
const FT_PER_UNIT = { ft: 1, m: 1 / 0.3048 };   // feet in one survey unit
const M_TO_UNIT = { ft: 1 / 0.3048, m: 1 };

async function handleGeoJSON(file) {
  let geo;
  try { geo = JSON.parse(await file.text()); }
  catch (err) { alert('Could not parse that GeoJSON: ' + err.message); return; }
  const lines = extractLines(geo);
  if (!lines.length) { alert('No LineString features found in that file.'); return; }
  // Project once, up front, so each line's length is known for the picker.
  geoLines = lines.map(l => {
    const { points, zone } = projectLine(l.coords);
    const lenFt = polylineLength(points) / 0.3048;
    const p = l.props || {};
    const label = `#${l.id} · ${p.PROPONENT || p.name || 'line'}${p.LINE_TYPE_DESC ? ' · ' + p.LINE_TYPE_DESC : ''}${p.STATUS ? ' · ' + p.STATUS : ''} · ${Math.round(lenFt).toLocaleString()} ft · ${points.length} pts`;
    return { id: l.id, label, points, zone, lenFt };
  }).filter(l => l.points.length >= 2);
  headers = []; parsedRows = [];
  mappingEl.style.display = 'none';
  geoActive = true;
  geoPicker.style.display = 'block';
  geoFilter.value = '';
  // Default to a mid-length line drawn as straight runs and corners (few vertices
  // per foot, not a dense curve): long enough to have several bends, short enough
  // to read on the plan view.
  const pick = geoLines.filter(l => l.lenFt >= 3000 && l.lenFt < 20000 && l.points.length <= 60)
    .sort((a, b) => b.lenFt - a.lenFt)[0]
    || geoLines.filter(l => l.lenFt < 20000).sort((a, b) => b.lenFt - a.lenFt)[0] || geoLines[0];
  fillGeoSelect(pick.id);
  reconstructBtn.disabled = false;
  autoTuneBtn.disabled = false;
  refreshRawPoints();
  runReconstruction();
}

// Lists up to 500 lines (longest first) matching the filter box. `selectId` is
// always included and selected, even if it isn't among the longest 500.
function fillGeoSelect(selectId = null) {
  const q = geoFilter.value.trim().toLowerCase();
  const matches = geoLines.filter(l => !q || l.label.toLowerCase().includes(q)).sort((a, b) => b.lenFt - a.lenFt);
  const shown = matches.slice(0, 500);
  const want = selectId || geoSelect.value;
  const wanted = matches.find(l => l.id === want);
  if (wanted && !shown.includes(wanted)) shown.unshift(wanted);
  geoSelect.innerHTML = '';
  shown.forEach(l => { const o = document.createElement('option'); o.value = l.id; o.textContent = l.label; geoSelect.appendChild(o); });
  if (wanted) geoSelect.value = wanted.id;
}

function buildGeoPoints() {
  const line = geoLines.find(l => l.id === geoSelect.value);
  if (!line) { rawPoints = []; return; }
  const unit = unitSelect.value;
  let pts = line.points.map(p => ({ x: p.x * M_TO_UNIT[unit], y: p.y * M_TO_UNIT[unit] }));
  referenceLine = pts.map(p => ({ x: p.x, y: p.y }));   // compare the result against this, even when shots are simulated
  if (geoNoise.checked) {
    const widthU = pipeWidthInUnits(parseFloat(widthSlider.value), unit);
    const ftU = 1 / FT_PER_UNIT[unit];           // one foot, in survey units
    pts = simulateSurvey(pts, { minSpacing: 20 * ftU, maxSpacing: 40 * ftU, halfWidth: widthU / 2 });
  }
  rawPoints = pts.map((p, i) => ({ x: p.x, y: p.y, z: null, pt: String(i + 1), desc: 'CL PIPE' }));
  geoInfo.textContent = `UTM zone ${line.zone}N · ${rawPoints.length} ${geoNoise.checked ? 'simulated shots' : 'GeoJSON vertices'} · ${Math.round(line.lenFt).toLocaleString()} ft`;
}

geoFilter.addEventListener('input', () => { fillGeoSelect(); if (geoSelect.value) { refreshRawPoints(); runReconstruction(); } });
geoSelect.addEventListener('change', () => { refreshRawPoints(); runReconstruction(); });
geoNoise.addEventListener('change', () => { refreshRawPoints(); runReconstruction(); });

// Pulls fresh points from whichever source is active (GeoJSON line or mapped CSV columns).
function refreshRawPoints() {
  if (geoActive) buildGeoPoints();
  else if (headers.length) buildRawPointsFromMapping();
}

function guessHeader(patterns) {
  for (const p of patterns) {
    const hit = headers.find(h => h.trim().toLowerCase() === p);
    if (hit) return hit;
  }
  for (const p of patterns) {
    const hit = headers.find(h => h.trim().toLowerCase().includes(p));
    if (hit) return hit;
  }
  return '';
}

function populateMapping() {
  const fill = (sel, guess, optional) => {
    sel.innerHTML = '';
    if (optional) { const o = document.createElement('option'); o.value = ''; o.textContent = '(none)'; sel.appendChild(o); }
    headers.forEach(h => { const o = document.createElement('option'); o.value = h; o.textContent = h; sel.appendChild(o); });
    if (guess) sel.value = guess;
  };
  fill(mapX, guessHeader(['x', 'easting', 'east']), false);
  fill(mapY, guessHeader(['y', 'northing', 'north']), false);
  fill(mapZ, guessHeader(['z', 'elev', 'elevation']), true);
  fill(mapPt, guessHeader(['pt', 'point', 'point #', 'point no', 'num']), true);
  fill(mapDesc, guessHeader(['desc', 'description', 'code']), true);
}

function buildRawPointsFromMapping() {
  const xk = mapX.value, yk = mapY.value, zk = mapZ.value, ptk = mapPt.value, dk = mapDesc.value;
  rawPoints = parsedRows
    .map(row => ({
      x: parseFloat(row[xk]),
      y: parseFloat(row[yk]),
      z: zk ? parseFloat(row[zk]) : null,
      pt: ptk ? row[ptk] : '',
      desc: dk ? row[dk] : ''
    }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/* ---------------- sample routes ---------------- */
const unitLabel = () => UNITS[unitSelect.value].label;

// Each preset also sets the sliders it was tuned with, so clicking a sample
// always gives a predictable result regardless of earlier slider changes.
const SAMPLE_DEFAULTS = {
  route: SAMPLE_TRUE_ROUTE, spacing: 25, noise: 1.5, defl: 10, minPts: 5, arcs: false, name: 'test route'
};
sample8Btn.addEventListener('click', () => loadSample({ widthIn: 8, seed: 4 }));
sample36Btn.addEventListener('click', () => loadSample({ widthIn: 36, seed: 11 }));
sampleCurveBtn.addEventListener('click', () => loadSample({
  widthIn: 8, seed: 1, route: SAMPLE_CURVE_ROUTE, spacing: 10, noise: 1,
  defl: 3, minPts: 3, arcs: true, name: 'curved route (90\u00b0 sweep, R = 400 ft)'
}));
function loadSample(opts) {
  const o = { ...SAMPLE_DEFAULTS, ...opts };
  // crew meander is roughly constant regardless of pipe diameter (it's positioning
  // error, not physical width) — the 8"/36" samples use the same noise amplitude, so
  // the vertex-count difference you'll see comes purely from the pipe-width tolerance.
  unitSelect.value = 'ft'; // sample coordinates are generated in feet
  const pts = generateSyntheticRoute(o.route, o.spacing, o.noise, o.seed, 100, 0.01);
  rawPoints = pts.map((p, i) => ({ x: p.x, y: p.y, z: p.z, pt: String(i + 1), desc: 'CL PIPE' }));
  parsedRows = []; headers = [];
  geoActive = false;
  geoPicker.style.display = 'none';
  mappingEl.style.display = 'none';
  filenameEl.textContent = `synthetic ${o.widthIn}" ${o.name} (${pts.length} shots)`;
  filenameEl.classList.add('show');
  widthSlider.value = o.widthIn;
  deflSlider.value = o.defl;
  minPtsSlider.value = o.minPts;
  arcToggle.checked = o.arcs;
  updateParamLabels();
  reconstructBtn.disabled = false;
  autoTuneBtn.disabled = false;
  runReconstruction();
}

/* ---------------- parameters ---------------- */
function updateParamLabels() {
  widthVal.textContent = widthSlider.value + ' in';
  deflVal.textContent = deflSlider.value + '\u00b0';
  minPtsVal.textContent = minPtsSlider.value;
}
[widthSlider, deflSlider, minPtsSlider].forEach(el => el.addEventListener('input', updateParamLabels));
updateParamLabels();

/* ---------------- units ---------------- */
// Changing units changes how the (inch) pipe width converts to coordinate units,
// so re-run if a dataset is already loaded.
unitSelect.addEventListener('change', () => {
  if (!rawPoints.length) return;
  refreshRawPoints();
  runReconstruction();
});

/* ---------------- run ---------------- */
reconstructBtn.addEventListener('click', () => {
  refreshRawPoints();
  runReconstruction();
});

function runReconstruction() {
  if (!rawPoints.length) { alert('No valid X/Y points found — check your column mapping.'); return; }
  const widthFt = pipeWidthInUnits(parseFloat(widthSlider.value), unitSelect.value); // inches -> survey units (ft or m)
  const deflDeg = parseFloat(deflSlider.value);
  const minPts = parseInt(minPtsSlider.value, 10);
  result = reconstruct(rawPoints, widthFt, deflDeg, minPts);

  statIn.textContent = rawPoints.length;
  statOut.textContent = result.vertices.length;
  const reduction = 100 * (1 - result.vertices.length / rawPoints.length);
  statReduction.textContent = (reduction >= 0 ? reduction.toFixed(0) : '0') + '%';
  const maxResidual = result.qa.length ? Math.max(...result.qa.map(q => q.maxResidual)) : 0;
  statMaxResidual.textContent = maxResidual.toFixed(2) + ' ' + unitLabel();
  statOutliers.textContent = result.outlierCount;
  statLength.textContent = result.stations[result.stations.length - 1].toFixed(0) + ' ' + unitLabel();

  elements = arcToggle.checked ? detectArcs(result) : result.vertices.slice(0, -1).map((v, i) => ({ type: 'line', from: v, to: result.vertices[i + 1] }));

  emptyState.style.display = 'none';
  downloadVerticesBtn.disabled = false;
  downloadDXFBtn.disabled = false;
  downloadXMLBtn.disabled = false;
  printBtn.disabled = false;
  renderVertexTable();
  renderQATable();
  updateFidelity();
  resetView();
  draw();
  drawProfile();
}

/* ---------------- fidelity check ---------------- */
// Does the result actually follow the line it was built from? Compared in both
// directions, sampled along the lines (see js/fidelity.js). In GeoJSON mode the
// reference is the original clean line, so with simulated shots this is the
// real recovery error; otherwise it is the input shots joined in order.
const fidelityEl = document.getElementById('fidelity');
const FEET_TO_UNIT = { ft: 1, m: 0.3048 };
const FID_TEXT = {
  good:  ['GOOD FIT',  'The result follows the input line.'],
  check: ['CHECK',     'The result deviates in places. Inspect the plan view before using it.'],
  poor:  ['POOR FIT',  'The result does NOT follow the input line. Do not use it as it is.']
};
function updateFidelity() {
  const useGeo = geoActive && referenceLine && referenceLine.length >= 2;
  const reference = useGeo ? referenceLine : rawPoints.map(p => ({ x: p.x, y: p.y }));
  if (!result || reference.length < 2 || result.vertices.length < 2) { fidelityEl.hidden = true; return; }

  const unit = unitSelect.value, f = FEET_TO_UNIT[unit], u = unitLabel();
  const c = compareToReference(reference, result.vertices, {
    farTol: FEET.far * f, sampleStep: 10 * f, sparseTol: FEET.sparse * f,
    inputPoints: rawPoints.map(p => ({ x: p.x, y: p.y }))
  });

  const dist = x => (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + u;
  const pct = x => (100 * x).toFixed(0) + '%';
  fidelityEl.className = 'fidelity ' + c.verdict;
  document.getElementById('fidBadge').textContent = FID_TEXT[c.verdict][0];
  document.getElementById('fidTitle').textContent = FID_TEXT[c.verdict][1];
  const reasons = document.getElementById('fidReasons');
  reasons.innerHTML = '';
  // the sparse-input reason is shown below in a fuller form, so skip the short version here
  c.reasons.filter(r => !/far apart/.test(r)).forEach(r => { const li = document.createElement('li'); li.textContent = '\u2022 ' + r; reasons.appendChild(li); });
  if (c.sparse) {
    const li = document.createElement('li');
    li.textContent = `\u2022 Input points are about ${Math.round(c.spacing.mean / f).toLocaleString()} ft apart; this method expects shots every ~20\u201340 ft. Use denser data, or plain line simplification for sparse centrelines.`;
    reasons.appendChild(li);
  }
  document.getElementById('fidMeanA').textContent = dist(c.refToResult.mean);
  document.getElementById('fidMeanB').textContent = dist(c.resultToRef.mean);
  document.getElementById('fidMaxA').textContent = dist(c.refToResult.max);
  document.getElementById('fidMaxB').textContent = dist(c.resultToRef.max);
  document.getElementById('fidFarLabel').textContent = `Beyond ${FEET.far} ft`;
  document.getElementById('fidFarA').textContent = pct(c.refToResult.farFrac);
  document.getElementById('fidFarB').textContent = pct(c.resultToRef.farFrac);
  document.getElementById('fidLenRef').textContent =
    `${Math.round(c.referenceLength).toLocaleString()} ${u} \u2192 ${Math.round(c.resultLength).toLocaleString()} ${u} (${c.lengthDiffPct >= 0 ? '+' : ''}${c.lengthDiffPct.toFixed(1)}%)`;
  document.getElementById('fidSpacing').textContent = `${dist(c.spacing.mean)} (max ${dist(c.spacing.max)})`;
  document.getElementById('fidBasis').textContent = useGeo
    ? (geoNoise.checked
        ? 'Reference = the original GeoJSON line (not the simulated shots), so this is the recovery error on synthetic noise.'
        : 'Reference = the GeoJSON line you loaded.')
    : `Reference = the ${rawPoints.length.toLocaleString()} input shots joined in order.`;
  fidelityEl.hidden = false;
}

/* ---------------- vertex table ---------------- */
function renderVertexTable() {
  vertexBody.innerHTML = '';
  const verts = result.vertices;
  const sameV = (a, b) => a === b || (a.x === b.x && a.y === b.y);

  // which interior vertex indices are absorbed into an arc (don't get their own row),
  // and which index starts an arc (gets an ARC-typed row instead of a LINE row)
  const skip = new Set();
  const arcStartsAt = new Map();
  elements.forEach(el => {
    if (el.type !== 'arc') return;
    const startIdx = verts.findIndex(v => sameV(v, el.from));
    const endIdx = verts.findIndex(v => sameV(v, el.to));
    if (startIdx < 0 || endIdx < 0) return;
    arcStartsAt.set(startIdx, el);
    for (let k = startIdx + 1; k < endIdx; k++) skip.add(k);
  });

  let prevBearing = null;
  let rowNum = 0;
  for (let i = 0; i < verts.length; i++) {
    if (skip.has(i)) continue;
    rowNum++;
    const tr = document.createElement('tr');
    let bearingCell = '\u2014', deflCell = '\u2014', lenCell = '\u2014', typeCell = '\u2014';
    const arcHere = arcStartsAt.get(i);
    if (arcHere) {
      typeCell = 'ARC';
      const brg = bearingOfVector(arcHere.to.x - arcHere.from.x, arcHere.to.y - arcHere.from.y);
      bearingCell = brg.toFixed(1) + '\u00b0 (chord)';
      lenCell = "R=" + arcHere.radius.toFixed(1) + "'";
      if (prevBearing !== null) deflCell = deflection(prevBearing, brg).toFixed(1) + '\u00b0';
      prevBearing = brg;
    } else if (i < verts.length - 1 && !skip.has(i + 1)) {
      typeCell = 'LINE';
      const a = verts[i], b = verts[i + 1];
      const brg = bearingOfVector(b.x - a.x, b.y - a.y);
      lenCell = Math.hypot(b.x - a.x, b.y - a.y).toFixed(1) + "'";
      bearingCell = brg.toFixed(1) + '\u00b0';
      if (prevBearing !== null) deflCell = deflection(prevBearing, brg).toFixed(1) + '\u00b0';
      prevBearing = brg;
    }
    const station = result.stations[i] || 0;
    tr.innerHTML = `<td>V${rowNum}</td><td>${typeCell}</td><td>${station.toFixed(1)}</td><td>${verts[i].x.toFixed(2)}</td><td>${verts[i].y.toFixed(2)}</td><td>${bearingCell}</td><td>${deflCell}</td><td>${lenCell}</td>`;
    vertexBody.appendChild(tr);
  }
}

function renderQATable() {
  qaBody.innerHTML = '';
  result.qa.forEach(q => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>S${q.segment}</td><td>${q.points}</td><td>${q.maxResidual.toFixed(2)}'</td><td>${q.rms.toFixed(2)}'</td><td>${q.outliers}</td>`;
    qaBody.appendChild(tr);
  });
}

downloadVerticesBtn.addEventListener('click', () => {
  if (!result) return;
  let csv = 'Point,Station,X,Y\n';
  result.vertices.forEach((v, i) => { csv += `V${i + 1},${(result.stations[i] || 0).toFixed(2)},${v.x.toFixed(3)},${v.y.toFixed(3)}\n`; });
  downloadCSV(csv, 'asbuilt_vertices.csv');
});

downloadDXFBtn.addEventListener('click', () => {
  if (!result) return;
  const dxf = toDXF(elements);
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'asbuilt_reconstruction.dxf';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

downloadXMLBtn.addEventListener('click', () => {
  if (!result) return;
  const xml = toLandXML(elements, result.vertices, unitSelect.value);
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'asbuilt_reconstruction.xml';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

printBtn.addEventListener('click', () => window.print());

/* ---------------- auto-tune ---------------- */
autoTuneBtn.addEventListener('click', () => {
  refreshRawPoints();
  if (!rawPoints.length) { alert('No valid X/Y points found — check your column mapping.'); return; }
  const widthFt = pipeWidthInUnits(parseFloat(widthSlider.value), unitSelect.value);
  const minPtsOptions = [3, 4, 5, 6, 7, 8];
  const deflOptions = [6, 8, 10, 12, 15, 20];
  let best = null;
  for (const mp of minPtsOptions) {
    for (const dd of deflOptions) {
      const r = reconstruct(rawPoints, widthFt, dd, mp);
      if (!r.qa.length) continue;
      const avgRms = r.qa.reduce((s, q) => s + q.rms, 0) / r.qa.length;
      // score: reward low residual, mildly penalize an unreasonable vertex count
      // (too few = probably over-merged; too many = probably still noisy)
      const vertexPenalty = r.vertices.length <= 2 ? 5 : (r.vertices.length > rawPoints.length * 0.3 ? 3 : 0);
      const score = avgRms + vertexPenalty;
      if (!best || score < best.score) best = { minPts: mp, deflDeg: dd, score, vertices: r.vertices.length, avgRms };
    }
  }
  if (best) {
    minPtsSlider.value = best.minPts;
    deflSlider.value = best.deflDeg;
    updateParamLabels();
    runReconstruction();
  }
});

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------- plan view: pan/zoom ---------------- */
let view = { scale: 1, offX: 0, offY: 0 };
let dragging = false, dragStart = { x: 0, y: 0 }, offStart = { x: 0, y: 0 };

function dataBounds() {
  if (!rawPoints.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  rawPoints.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
  return { minX, maxX, minY, maxY };
}

function resetView() {
  const b = dataBounds();
  if (!b) return;
  const rect = plotCanvas.getBoundingClientRect();
  const w = rect.width || 600, h = rect.height || 460;
  const dw = Math.max(b.maxX - b.minX, 1), dh = Math.max(b.maxY - b.minY, 1);
  const pad = 60;
  view.scale = Math.min((w - pad * 2) / dw, (h - pad * 2) / dh);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  view.offX = w / 2 - cx * view.scale;
  view.offY = h / 2 + cy * view.scale;
}

function toScreen(p) { return { x: p.x * view.scale + view.offX, y: -p.y * view.scale + view.offY }; }

function resizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => {
  resizeCanvas(plotCanvas, plotCtx); draw();
  resizeCanvas(profileCanvas, profileCtx); drawProfile();
});

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function niceSpacing(targetPx) {
  const rawSpacing = targetPx / view.scale;
  const mag = Math.pow(10, Math.floor(Math.log10(rawSpacing)));
  const norm = rawSpacing / mag;
  if (norm < 2) return mag;
  if (norm < 5) return 2 * mag;
  return 5 * mag;
}

function draw() {
  const rect = plotCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  plotCtx.clearRect(0, 0, w, h);
  if (!rawPoints.length) return;

  const gridColor = cssVar('--blue'), inkColor = cssVar('--ink'),
        graphiteColor = cssVar('--graphite'), redColor = cssVar('--red'), amberColor = cssVar('--amber');
  const spacing = niceSpacing(60);

  plotCtx.save();
  plotCtx.strokeStyle = gridColor;
  plotCtx.globalAlpha = 0.18;
  plotCtx.lineWidth = 1;
  const worldXmin = (0 - view.offX) / view.scale, worldXmax = (w - view.offX) / view.scale;
  const worldYmin = (view.offY - h) / view.scale, worldYmax = view.offY / view.scale;
  let count = 0;
  for (let gx = Math.floor(worldXmin / spacing) * spacing; gx <= worldXmax && count < 400; gx += spacing, count++) {
    const sx = gx * view.scale + view.offX;
    plotCtx.beginPath(); plotCtx.moveTo(sx, 0); plotCtx.lineTo(sx, h); plotCtx.stroke();
  }
  count = 0;
  for (let gy = Math.floor(worldYmin / spacing) * spacing; gy <= worldYmax && count < 400; gy += spacing, count++) {
    const sy = -gy * view.scale + view.offY;
    plotCtx.beginPath(); plotCtx.moveTo(0, sy); plotCtx.lineTo(w, sy); plotCtx.stroke();
  }
  plotCtx.restore();

  // raw points
  plotCtx.fillStyle = graphiteColor;
  plotCtx.globalAlpha = 0.75;
  rawPoints.forEach(p => { const s = toScreen(p); plotCtx.beginPath(); plotCtx.arc(s.x, s.y, 2.6, 0, Math.PI * 2); plotCtx.fill(); });
  plotCtx.globalAlpha = 1;

  // rejected outliers, highlighted
  if (result && result.lines) {
    plotCtx.fillStyle = amberColor;
    result.lines.forEach(line => (line.outliers || []).forEach(p => {
      const s = toScreen(p);
      plotCtx.beginPath(); plotCtx.arc(s.x, s.y, 4, 0, Math.PI * 2); plotCtx.fill();
    }));
  }

  // reconstructed centerline — lines in red, detected arcs in blue
  if (result && elements.length) {
    const blueColor = cssVar('--blue');
    elements.forEach(el => {
      if (el.type === 'line') {
        const a = toScreen(el.from), b = toScreen(el.to);
        plotCtx.strokeStyle = redColor; plotCtx.lineWidth = 2.4; plotCtx.lineJoin = 'round';
        plotCtx.beginPath(); plotCtx.moveTo(a.x, a.y); plotCtx.lineTo(b.x, b.y); plotCtx.stroke();
      } else {
        const center = toScreen(el.center);
        const a0 = Math.atan2(el.from.y - el.center.y, el.from.x - el.center.x);
        const a1 = Math.atan2(el.to.y - el.center.y, el.to.x - el.center.x);
        // canvas y is flipped vs world y, so angles/winding flip too — draw both
        // candidate sweeps and pick the one whose length matches the fitted radius
        plotCtx.strokeStyle = blueColor; plotCtx.lineWidth = 2.4;
        plotCtx.beginPath();
        plotCtx.arc(center.x, center.y, el.radius * view.scale, -a0, -a1, false);
        plotCtx.stroke();
      }
    });
    // vertices (draggable handles) at the start/end of every element
    plotCtx.fillStyle = inkColor;
    const seen = new Set();
    const markVertex = v => {
      const key = v.x.toFixed(3) + ',' + v.y.toFixed(3);
      if (seen.has(key)) return;
      seen.add(key);
      const s = toScreen(v);
      plotCtx.beginPath(); plotCtx.arc(s.x, s.y, 3.6, 0, Math.PI * 2); plotCtx.fill();
    };
    elements.forEach(el => { markVertex(el.from); markVertex(el.to); });
  }
}

/* ---------------- elevation profile ---------------- */
function drawProfile() {
  const rect = profileCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  profileCtx.clearRect(0, 0, w, h);
  if (!result || !rawPoints.some(p => Number.isFinite(p.z))) {
    profileCtx.fillStyle = cssVar('--ink-soft');
    profileCtx.font = '11px IBM Plex Mono, monospace';
    profileCtx.fillText(rawPoints.length ? 'No elevation (Z) data in this import' : '', 14, h / 2);
    return;
  }
  // station of each raw point: distance along its assigned line from that line's
  // own start (its minimum projected extent), plus that line's starting station
  // in the overall reconstructed chain — so this lines up with the plan view.
  result.lines.forEach(line => {
    let localMin = Infinity;
    line.points.forEach(p => { const s = (p.x - line.centroid.x) * line.dir.x + (p.y - line.centroid.y) * line.dir.y; if (s < localMin) localMin = s; });
    line._minS = localMin;
  });
  const stationed = [];
  let cum = 0;
  result.lines.forEach((line, li) => {
    line.points.forEach(p => {
      if (!Number.isFinite(p.z)) return;
      const s = (p.x - line.centroid.x) * line.dir.x + (p.y - line.centroid.y) * line.dir.y;
      stationed.push({ station: cum + (s - line._minS), z: p.z });
    });
    cum = result.stations[li + 1] ?? cum;
  });

  if (!stationed.length) return;
  const minSt = 0, maxSt = result.stations[result.stations.length - 1];
  const zs = stationed.map(p => p.z);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const padL = 46, padR = 14, padT = 14, padB = 18;
  const sx = st => padL + (st - minSt) / Math.max(maxSt - minSt, 1) * (w - padL - padR);
  const sy = z => h - padB - (z - minZ) / Math.max(maxZ - minZ, 0.1) * (h - padT - padB);

  profileCtx.strokeStyle = cssVar('--line-strong');
  profileCtx.lineWidth = 1;
  profileCtx.beginPath(); profileCtx.moveTo(padL, padT); profileCtx.lineTo(padL, h - padB); profileCtx.lineTo(w - padR, h - padB); profileCtx.stroke();
  profileCtx.fillStyle = cssVar('--ink-soft');
  profileCtx.font = '10px IBM Plex Mono, monospace';
  profileCtx.fillText(maxZ.toFixed(1), 4, padT + 8);
  profileCtx.fillText(minZ.toFixed(1), 4, h - padB);
  profileCtx.fillText('ELEVATION PROFILE', padL, 11);

  // raw z points
  profileCtx.fillStyle = cssVar('--graphite');
  profileCtx.globalAlpha = 0.7;
  stationed.forEach(p => { profileCtx.beginPath(); profileCtx.arc(sx(p.station), sy(p.z), 2, 0, Math.PI * 2); profileCtx.fill(); });
  profileCtx.globalAlpha = 1;

  // fitted elevation per segment, drawn as connected red line at segment boundaries
  profileCtx.strokeStyle = cssVar('--red');
  profileCtx.lineWidth = 2;
  profileCtx.beginPath();
  let started = false;
  cum = 0;
  result.lines.forEach((line, li) => {
    const fit = fitElevation(line.points, line.centroid, line.dir);
    if (!fit) { cum = result.stations[li + 1] ?? cum; return; }
    const sStart = cum, sEnd = result.stations[li + 1] ?? cum;
    const zStart = fit.evalAtS(0), zEnd = fit.evalAtS(sEnd - sStart);
    const p1 = { x: sx(sStart), y: sy(zStart) }, p2 = { x: sx(sEnd), y: sy(zEnd) };
    if (!started) { profileCtx.moveTo(p1.x, p1.y); started = true; } else { profileCtx.lineTo(p1.x, p1.y); }
    profileCtx.lineTo(p2.x, p2.y);
    cum = sEnd;
  });
  profileCtx.stroke();
}

/* ---------------- manual vertex nudge ---------------- */
function nearestVertexIndex(screenX, screenY, maxPx = 10) {
  if (!result) return -1;
  let best = -1, bestDist = maxPx;
  result.vertices.forEach((v, i) => {
    const s = toScreen(v);
    const d = Math.hypot(s.x - screenX, s.y - screenY);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// Nudging edits result.vertices directly and recomputes everything DERIVED
// from them (stations, bearings, table, arc element endpoints) without
// re-running the full reconstruct() pipeline — so it's a pure visual/output
// correction, not a re-fit. Re-clicking "Reconstruct" discards any nudge.
function recomputeAfterNudge() {
  let station = 0;
  const stations = [0];
  for (let i = 1; i < result.vertices.length; i++) {
    station += Math.hypot(result.vertices[i].x - result.vertices[i - 1].x, result.vertices[i].y - result.vertices[i - 1].y);
    stations.push(station);
  }
  result.stations = stations;
  statLength.textContent = stations[stations.length - 1].toFixed(0) + ' ' + unitLabel();
  // keep element endpoints in sync by position (arcs keep their fitted center/radius —
  // nudging a vertex on an arc just moves where the arc visually starts/ends)
  elements = arcToggle.checked ? elements : result.vertices.slice(0, -1).map((v, i) => ({ type: 'line', from: v, to: result.vertices[i + 1] }));
  renderVertexTable();
  updateFidelity();
}

plotCanvas.addEventListener('pointerdown', e => {
  const rect = plotCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const vIdx = nearestVertexIndex(mx, my);
  if (vIdx >= 0) {
    draggedVertexIndex = vIdx;
  } else {
    dragging = true; dragStart = { x: e.clientX, y: e.clientY }; offStart = { x: view.offX, y: view.offY };
  }
  plotCanvas.setPointerCapture(e.pointerId);
});
plotCanvas.addEventListener('pointermove', e => {
  const rect = plotCanvas.getBoundingClientRect();
  if (draggedVertexIndex >= 0) {
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const worldX = (mx - view.offX) / view.scale, worldY = -(my - view.offY) / view.scale;
    const v = result.vertices[draggedVertexIndex];
    // keep arc element objects pointing at the SAME object so edits propagate
    v.x = worldX; v.y = worldY;
    recomputeAfterNudge();
    draw();
    return;
  }
  if (!dragging) return;
  view.offX = offStart.x + (e.clientX - dragStart.x);
  view.offY = offStart.y + (e.clientY - dragStart.y);
  draw();
});
plotCanvas.addEventListener('pointerup', () => { dragging = false; draggedVertexIndex = -1; });
plotCanvas.addEventListener('pointercancel', () => { dragging = false; draggedVertexIndex = -1; });
plotCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = plotCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const factor = Math.pow(1.0013, -e.deltaY);
  const worldX = (mx - view.offX) / view.scale, worldY = -(my - view.offY) / view.scale;
  view.scale *= factor;
  view.offX = mx - worldX * view.scale;
  view.offY = my + worldY * view.scale;
  draw();
}, { passive: false });

/* ---------------- init ---------------- */
resizeCanvas(plotCanvas, plotCtx);
resizeCanvas(profileCanvas, profileCtx);
