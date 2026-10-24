import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distToPolyline, polylineLength, densify, spacingStats, compareToReference, FEET
} from '../js/fidelity.js';
import {
  reconstruct, generateSyntheticRoute, SAMPLE_TRUE_ROUTE, SAMPLE_CURVE_ROUTE, pipeWidthInUnits
} from '../js/algorithm.js';

const OPTS = { farTol: FEET.far, sampleStep: 10, sparseTol: FEET.sparse };
const cmp = (ref, res, input = ref) => compareToReference(ref, res, { ...OPTS, inputPoints: input });
const L = pts => pts.map(p => ({ x: p.x, y: p.y }));

test('distToPolyline: perpendicular, end-cap and degenerate cases', () => {
  const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  assert.equal(distToPolyline({ x: 5, y: 3 }, line), 3);          // perpendicular to the segment
  assert.equal(distToPolyline({ x: 13, y: 4 }, line), 5);         // beyond the end: distance to the end point
  assert.equal(distToPolyline({ x: 3, y: 4 }, [{ x: 0, y: 0 }]), 5); // single-point "polyline"
});

test('densify: keeps end points and spaces samples evenly', () => {
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const d = densify(line, 10);
  assert.deepEqual(d[0], { x: 0, y: 0 });
  assert.deepEqual(d.at(-1), { x: 100, y: 0 });
  for (let i = 1; i < d.length - 1; i++) assert.ok(Math.abs(d[i].x - d[i - 1].x - 10) < 1e-9);
  assert.ok(Math.abs(polylineLength(d) - 100) < 1e-9);
});

test('densify: respects the sample cap on very long lines', () => {
  const d = densify([{ x: 0, y: 0 }, { x: 1e6, y: 0 }], 1, 500);
  assert.ok(d.length <= 505, String(d.length));
});

test('spacingStats: mean and max gap', () => {
  const s = spacingStats([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 40, y: 0 }]);
  assert.equal(s.mean, 20);
  assert.equal(s.max, 30);
});

test('compareToReference: identical lines give zero distance and a good verdict', () => {
  const line = L([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 20 }, { x: 90, y: 20 }]);
  const c = cmp(line, line);
  assert.equal(c.verdict, 'good');
  assert.ok(c.refToResult.max < 1e-9 && c.resultToRef.max < 1e-9);
  assert.ok(Math.abs(c.lengthDiffPct) < 1e-9);
});

test('compareToReference: a result that cuts a corner is caught (reference -> result)', () => {
  // L-shaped reference, but the "result" is the diagonal shortcut
  const ref = [{ x: 0, y: 0 }, { x: 0, y: 500 }, { x: 500, y: 500 }];
  const result = [{ x: 0, y: 0 }, { x: 500, y: 500 }];
  const c = cmp(ref, result);
  assert.equal(c.verdict, 'poor');
  assert.ok(c.refToResult.max > 300, `max ${c.refToResult.max}`);
  assert.ok(c.lengthDiffPct < -25);
});

test('compareToReference: a result that invents a detour is caught (result -> reference)', () => {
  const ref = [{ x: 0, y: 0 }, { x: 500, y: 0 }];
  const result = [{ x: 0, y: 0 }, { x: 250, y: 200 }, { x: 500, y: 0 }];
  const c = cmp(ref, result);
  assert.equal(c.verdict, 'poor');
  assert.ok(c.resultToRef.max > 190);                 // the invented apex
  assert.ok(c.refToResult.max < c.resultToRef.max);   // reference alone barely notices; the reverse direction does
});

test('compareToReference: sparse input is flagged even when the result looks fine', () => {
  const line = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 }];   // straight, points 1000 ft apart
  const c = cmp(line, line);
  assert.equal(c.sparse, true);
  assert.equal(c.verdict, 'check');
  assert.ok(c.reasons.some(r => /far apart/.test(r)));
});

test('compareToReference: tolerances scale with units (metres)', () => {
  const ref = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const res = [{ x: 0, y: 10 }, { x: 100, y: 10 }];                       // 10 units off everywhere
  assert.equal(compareToReference(ref, res, { ...OPTS, farTol: 25 }).verdict, 'good');    // 10 < 25
  assert.equal(compareToReference(ref, res, { ...OPTS, farTol: 5 }).verdict, 'poor');     // 10 > 5
});

// ---- regression: the cases that motivated the check -------------------------------------

test('dense survey-style samples come out GOOD', () => {
  const dense = [
    [SAMPLE_TRUE_ROUTE, 25, 1.5, 4, 8, 10, 5],
    [SAMPLE_TRUE_ROUTE, 25, 1.5, 11, 36, 10, 5],
    [SAMPLE_CURVE_ROUTE, 10, 1, 1, 8, 6, 5]
  ];
  for (const [route, spacing, noise, seed, widthIn, defl, minPts] of dense) {
    const raw = L(generateSyntheticRoute(route, spacing, noise, seed, 100, 0.01));
    const res = reconstruct(raw, pipeWidthInUnits(widthIn, 'ft'), defl, minPts);
    const c = cmp(raw, res.vertices);
    assert.equal(c.verdict, 'good', `${widthIn}in ${spacing}ft: ${c.verdict} ${c.reasons.join('; ')}`);
  }
});

test('a clean SPARSE route (corners only) comes out POOR — the failure the check exists to catch', () => {
  const clean = L(SAMPLE_TRUE_ROUTE);                       // 5 vertices, hundreds of feet apart
  const res = reconstruct(clean, pipeWidthInUnits(24, 'ft'), 10, 5);
  const c = cmp(clean, res.vertices);
  assert.equal(c.verdict, 'poor');
  assert.ok(c.lengthDiffPct < -10, `length diff ${c.lengthDiffPct}`);
  assert.equal(c.sparse, true);
});

test('simulated shots compared against the CLEAN line give the real recovery error', () => {
  const clean = L(SAMPLE_TRUE_ROUTE);
  const shots = L(generateSyntheticRoute(SAMPLE_TRUE_ROUTE, 25, 1.5, 4, 100, 0.01));
  const res = reconstruct(shots, pipeWidthInUnits(8, 'ft'), 10, 5);
  const c = cmp(clean, res.vertices, shots);                // reference = truth, input = noisy shots
  assert.equal(c.verdict, 'good');
  assert.ok(c.refToResult.mean < 5, `mean ${c.refToResult.mean}`);
});
