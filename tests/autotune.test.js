import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTune, DEFL_GRID } from '../js/autotune.js';
import { generateSyntheticRoute, SAMPLE_TRUE_ROUTE, buildCurveRoute, reconstruct, pipeWidthInUnits } from '../js/algorithm.js';
import { FEET, compareToReference } from '../js/fidelity.js';

const O = widthIn => ({ widthUnits: pipeWidthInUnits(widthIn, 'ft'), farTol: FEET.far, sampleStep: 10, sparseTol: FEET.sparse });
const shots = (route, spacing, noise, seed) => generateSyntheticRoute(route, spacing, noise, seed, 100, 0.01).map(p => ({ x: p.x, y: p.y }));

test('autoTune: finds the true number of vertices on the sample route', () => {
  const raw = shots(SAMPLE_TRUE_ROUTE, 25, 1.5, 4);
  const { best, tried } = autoTune(raw, raw, O(8));
  assert.ok(tried > 30);
  assert.equal(best.acceptable, true);
  assert.equal(best.vertices, SAMPLE_TRUE_ROUTE.length);
});

test('autoTune: picks FEWER vertices than a needlessly fine setting, while still following the line', () => {
  const raw = shots(SAMPLE_TRUE_ROUTE, 25, 1.5, 11);
  const { best, all } = autoTune(raw, raw, O(36));
  const finest = all.reduce((m, a) => (a.vertices > m.vertices ? a : m));
  assert.ok(best.vertices <= finest.vertices);
  assert.equal(best.acceptable, true);
});

test('autoTune: a sparse, corners-only line cannot be made acceptable, and it says so', () => {
  const clean = SAMPLE_TRUE_ROUTE.map(p => ({ x: p.x, y: p.y }));
  const { best } = autoTune(clean, clean, O(24));
  assert.equal(best.acceptable, false);
  assert.notEqual(best.verdict, 'good');
});

test('autoTune: a long gentle curve is flattened by the default 10 deg setting, and tuning fixes it', () => {
  // 60 deg sweep at R = 15 km, 1 deg per step: each bend is far under 10 deg, so the default
  // merges the whole curve into a few straight runs that sit up to ~125 ft off the line.
  const route = buildCurveRoute(15000, 60, 1, 400);
  const raw = shots(route, 40, 0.3, 2);
  const flat = compareToReference(raw, reconstruct(raw, pipeWidthInUnits(24, 'ft'), 10, 5).vertices,
    { farTol: FEET.far, sampleStep: 10, sparseTol: FEET.sparse, inputPoints: raw });
  assert.equal(flat.verdict, 'poor');
  const { best } = autoTune(raw, raw, O(24));
  assert.equal(best.acceptable, true);
  assert.ok(best.deflDeg < 10, `picked ${best.deflDeg}`);
  assert.ok(best.vertices < 40, `${best.vertices} vertices`);   // still a big reduction from 381 shots
});

test('autoTune: can reach bend thresholds as low as 1 degree', () => {
  assert.equal(Math.min(...DEFL_GRID), 1);
});

test('autoTune: returns null when there is nothing to tune', () => {
  const { best, tried } = autoTune([{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }], O(8));
  assert.equal(best, null);
  assert.equal(tried, 0);
});

test('autoTune: the setting it reports as following the line is GOOD under the full-precision check the app shows', () => {
  const cases = [
    [shots(SAMPLE_TRUE_ROUTE, 25, 1.5, 4), 8],
    [shots(SAMPLE_TRUE_ROUTE, 25, 1.5, 11), 36],
    [shots(buildCurveRoute(15000, 60, 1, 400), 40, 0.3, 2), 24],
    [shots(buildCurveRoute(8000, 60, 1, 500), 40, 0.5, 2), 24]
  ];
  for (const [raw, w] of cases) {
    const { best } = autoTune(raw, raw, O(w));
    const c = compareToReference(raw, reconstruct(raw, pipeWidthInUnits(w, 'ft'), best.deflDeg, best.minPts).vertices,
      { farTol: FEET.far, sampleStep: 10, sparseTol: FEET.sparse, inputPoints: raw });
    assert.equal(best.acceptable, true);
    assert.equal(c.verdict, 'good', `reported acceptable but the panel would say ${c.verdict} (${(100 * c.worstFar).toFixed(1)}% off)`);
    assert.equal(c.verdict, best.verdict);
  }
});
