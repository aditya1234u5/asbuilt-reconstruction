// End to end: a synthetic phone-GPS walk -> GPX text -> parse -> project -> reconstruct -> compare to a reference line.
// The error model is the realistic one: 1 Hz fixes while walking, position error that DRIFTS (autocorrelated), ~3 m sigma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGPX, trackCoordinates } from '../js/gpx.js';
import { projectLine } from '../js/geojson.js';
import { clipToSpan } from '../js/reference.js';
import { effectiveWidth, farToleranceFt } from '../js/quality.js';
import { reconstruct, pipeWidthInUnits } from '../js/algorithm.js';
import { compareToReference } from '../js/fidelity.js';
import { autoTune } from '../js/autotune.js';

const M2FT = 1 / 0.3048;
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

// the "true" path, in lon/lat: ~2.2 km with a long gentle bend and a sharp turn (zone 10, near Vancouver)
const lat0 = 49.2, mlat = 111320, mlon = 111320 * Math.cos(lat0 * Math.PI / 180);
const metresPath = [[0, 0], [0, 600], [300, 900], [900, 900], [900, 1500]];
const TRUTH = metresPath.map(([e, n]) => [-123.0 + e / mlon, lat0 + n / mlat]);

function phoneWalk(seed, sigmaM = 3) {
  const r = rng(seed), rho = 0.95, s = sigmaM * Math.sqrt(1 - rho * rho);
  const seg = [], cum = [0];
  for (let i = 1; i < metresPath.length; i++) cum.push(cum[i - 1] + Math.hypot(metresPath[i][0] - metresPath[i - 1][0], metresPath[i][1] - metresPath[i - 1][1]));
  const out = []; let ex = 0, ey = 0, k = 0;
  for (let d = 0; d <= cum.at(-1); d += 1.4) {
    while (k < cum.length - 2 && cum[k + 1] < d) k++;
    const t = (d - cum[k]) / (cum[k + 1] - cum[k]);
    const e = metresPath[k][0] + (metresPath[k + 1][0] - metresPath[k][0]) * t, n = metresPath[k][1] + (metresPath[k + 1][1] - metresPath[k][1]) * t;
    ex = rho * ex + s * gauss(r); ey = rho * ey + s * gauss(r);
    out.push([-123.0 + (e + ex) / mlon, lat0 + (n + ey) / mlat]);
  }
  return out;
}
const toGPX = pts => `<?xml version="1.0"?><gpx version="1.1"><trk><name>Walk</name><trkseg>${pts.map(([lon, lat]) => `<trkpt lat="${lat.toFixed(8)}" lon="${lon.toFixed(8)}"></trkpt>`).join('')}</trkseg></trk></gpx>`;

function run(gpxText, quality) {
  const track = parseGPX(gpxText).tracks[0];
  const { points, zone } = projectLine(trackCoordinates(track));
  const shots = points.map(p => ({ x: p.x * M2FT, y: p.y * M2FT }));
  const ref = projectLine(TRUTH, zone).points.map(p => ({ x: p.x * M2FT, y: p.y * M2FT }));
  const refClip = clipToSpan(ref, shots[0], shots.at(-1));
  const width = effectiveWidth(pipeWidthInUnits(24, 'ft'), quality, 1);
  const opts = { farTol: farToleranceFt(quality), sampleStep: 10, sparseTol: 100, inputPoints: shots };
  return { shots, refClip, width, opts };
}

test('GPX walk: the track parses, projects, and the reference trims to the walked stretch', () => {
  const { shots, refClip } = run(toGPX(phoneWalk(5)), 'phone');
  assert.ok(shots.length > 1000);
  const len = pts => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
  const truth = (600 + Math.hypot(300, 300) + 600 + 600) * M2FT;   // 2,224 m of path
  assert.ok(Math.abs(len(refClip) - truth) / truth < 0.01, `reference length ${len(refClip)} vs ${truth}`);
});

test('survey-grade tolerance reads GPS drift as real bends; the phone preset does not', () => {
  const g = toGPX(phoneWalk(5));
  const s = run(g, 'survey'), p = run(g, 'phone');
  const vSurvey = reconstruct(s.shots, s.width, 10, 5).vertices.length;
  const vPhone = reconstruct(p.shots, p.width, 10, 5).vertices.length;
  assert.ok(vPhone < vSurvey / 2, `phone ${vPhone} vs survey ${vSurvey}`);
  const cSurvey = compareToReference(s.refClip, reconstruct(s.shots, s.width, 10, 5).vertices, s.opts);
  assert.notEqual(cSurvey.verdict, 'good');       // the drift shows up as a longer, wigglier line
});

test('with the phone preset, auto-tune gets a GOOD fit against the reference line', () => {
  for (const seed of [5, 9, 14]) {
    const p = run(toGPX(phoneWalk(seed)), 'phone');
    const { best } = autoTune(p.shots, p.refClip, { widthUnits: p.width, farTol: p.opts.farTol, sampleStep: 10, sparseTol: 100 });
    assert.equal(best.acceptable, true, `seed ${seed}: ${best.verdict}, ${(100 * best.cmp.worstFar).toFixed(0)}% off`);
    assert.ok(best.cmp.refToResult.mean < 25, `seed ${seed}: mean ${best.cmp.refToResult.mean} ft`);
  }
});
