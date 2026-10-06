import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingOfVector, deflection, rdp, fitLinePCA, reconstruct,
  fitElevation, fitCircle, detectArcs, toDXF, toLandXML,
  generateSyntheticRoute, SAMPLE_TRUE_ROUTE
} from '../js/algorithm.js';

test('bearingOfVector: north/east/south/west', () => {
  assert.equal(bearingOfVector(0, 1), 0);    // north
  assert.equal(bearingOfVector(1, 0), 90);   // east
  assert.equal(bearingOfVector(0, -1), 180); // south
  assert.equal(bearingOfVector(-1, 0), 270); // west
});

test('deflection: wraps correctly across 0/360', () => {
  assert.equal(deflection(350, 10), 20);
  assert.equal(deflection(10, 350), -20);
  assert.equal(deflection(0, 0), 0);
});

test('rdp: collapses a straight noisy line to its two endpoints', () => {
  const pts = [];
  for (let x = 0; x <= 100; x += 10) pts.push({ x, y: (x % 20 === 0) ? 0.1 : -0.1 });
  const simplified = rdp(pts, 1); // tolerance 1 >> 0.1 noise
  assert.equal(simplified.length, 2);
  assert.equal(simplified[0], pts[0]);       // same reference, not a copy
  assert.equal(simplified[1], pts[pts.length - 1]);
});

test('rdp: keeps a real corner above tolerance', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  const simplified = rdp(pts, 1);
  assert.equal(simplified.length, 3);
});

test('fitLinePCA: recovers direction of points on a known line', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }];
  const fit = fitLinePCA(pts);
  // direction should be parallel to (1,2)
  const cross = fit.dir.x * 2 - fit.dir.y * 1;
  assert.ok(Math.abs(cross) < 1e-9, `expected direction parallel to (1,2), got ${JSON.stringify(fit.dir)}`);
});

test('reconstruct: point accounting is exact (no point ever duplicated or lost)', () => {
  const raw = generateSyntheticRoute(SAMPLE_TRUE_ROUTE, 25, 1.5, 7, 100, 0.01);
  const r = reconstruct(raw, 24 / 12, 10, 5);
  const kept = r.lines.reduce((s, l) => s + l.points.length, 0);
  assert.equal(kept + r.outlierCount, raw.length);
});

test('reconstruct: true route (3 real bends) survives as 5 vertices at every pipe width', () => {
  for (const widthIn of [8, 24, 36]) {
    const raw = generateSyntheticRoute(SAMPLE_TRUE_ROUTE, 25, 1.5, 7, 100, 0.01);
    const r = reconstruct(raw, widthIn / 12, 10, 5);
    assert.equal(r.vertices.length, 5, `expected 5 vertices at ${widthIn}"`);
  }
});

test('reconstruct: wider pipe is at least as forgiving as narrower pipe under heavy noise', () => {
  const raw = generateSyntheticRoute(SAMPLE_TRUE_ROUTE, 25, 6, 7); // exaggerated meander
  const r8 = reconstruct(raw, 8 / 12, 10, 5);
  const r36 = reconstruct(raw, 36 / 12, 10, 5);
  assert.ok(r36.vertices.length <= r8.vertices.length,
    `36" (${r36.vertices.length}) should produce <= vertices than 8" (${r8.vertices.length})`);
});

test('reconstruct: stationing is monotonically non-decreasing and matches total path length', () => {
  const raw = generateSyntheticRoute(SAMPLE_TRUE_ROUTE, 25, 1.5, 7, 100, 0.01);
  const r = reconstruct(raw, 24 / 12, 10, 5);
  for (let i = 1; i < r.stations.length; i++) assert.ok(r.stations[i] >= r.stations[i - 1]);
  let manualLen = 0;
  for (let i = 1; i < r.vertices.length; i++) {
    manualLen += Math.hypot(r.vertices[i].x - r.vertices[i - 1].x, r.vertices[i].y - r.vertices[i - 1].y);
  }
  assert.ok(Math.abs(manualLen - r.stations[r.stations.length - 1]) < 1e-6);
});

test('fitElevation: recovers a known grade', () => {
  const centroid = { x: 0, y: 0 }, dir = { x: 1, y: 0 };
  const pts = [];
  for (let s = 0; s <= 100; s += 10) pts.push({ x: s, y: 0, z: 100 + 0.02 * s });
  const fit = fitElevation(pts, centroid, dir);
  assert.ok(Math.abs(fit.b - 0.02) < 1e-6);
});

test('fitCircle: recovers a known center and radius', () => {
  const cx0 = 10, cy0 = 5, r0 = 20;
  const pts = [];
  for (let a = 0; a <= 90; a += 10) {
    const rad = a * Math.PI / 180;
    pts.push({ x: cx0 + r0 * Math.cos(rad), y: cy0 + r0 * Math.sin(rad) });
  }
  const fit = fitCircle(pts);
  assert.ok(Math.abs(fit.cx - cx0) < 1e-6);
  assert.ok(Math.abs(fit.cy - cy0) < 1e-6);
  assert.ok(Math.abs(fit.r - r0) < 1e-6);
});

test('detectArcs: never fires on a route of isolated sharp corners', () => {
  const raw = generateSyntheticRoute(SAMPLE_TRUE_ROUTE, 25, 1.5, 7, 100, 0.01);
  const r = reconstruct(raw, 24 / 12, 10, 5);
  const elements = detectArcs(r);
  assert.ok(elements.every(e => e.type === 'line'), 'sharp-corner route should produce no arcs');
});

test('toDXF: produces a well-formed minimal ENTITIES section', () => {
  const elements = [
    { type: 'line', from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
    { type: 'arc', from: { x: 10, y: 0 }, to: { x: 10, y: 10 }, center: { x: 5, y: 5 }, radius: 7.07 }
  ];
  const dxf = toDXF(elements);
  assert.ok(dxf.startsWith('0\nSECTION\n2\nENTITIES'));
  assert.ok(dxf.includes('LINE'));
  assert.ok(dxf.includes('ARC'));
  assert.ok(dxf.trim().endsWith('0\nEOF'));
});

test('toLandXML: produces parseable-looking XML with matching point count', () => {
  const raw = generateSyntheticRoute(SAMPLE_TRUE_ROUTE, 25, 1.5, 7, 100, 0.01);
  const r = reconstruct(raw, 24 / 12, 10, 5);
  const elements = detectArcs(r);
  const xml = toLandXML(elements, r.vertices);
  assert.ok(xml.startsWith('<?xml'));
  const pointMatches = xml.match(/<CgPoint name=/g) || []; // not <CgPoints> container
  assert.equal(pointMatches.length, r.vertices.length);
});
