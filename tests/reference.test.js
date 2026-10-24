import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestOnPolyline, clipToSpan, rankLinesByProximity } from '../js/reference.js';
import { polylineLength } from '../js/fidelity.js';

const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];   // east 100, then north 100

test('nearestOnPolyline: distance, position along the line, and the second leg', () => {
  const a = nearestOnPolyline({ x: 40, y: 7 }, line);
  assert.equal(a.dist, 7); assert.equal(a.along, 40); assert.equal(a.seg, 0);
  const b = nearestOnPolyline({ x: 108, y: 60 }, line);
  assert.equal(b.dist, 8); assert.equal(b.along, 160); assert.equal(b.seg, 1);
});

test('clipToSpan: keeps only the stretch between the two points, corner included', () => {
  const clipped = clipToSpan(line, { x: 30, y: 5 }, { x: 105, y: 40 });
  assert.deepEqual(clipped[0], { x: 30, y: 0 });
  assert.deepEqual(clipped.at(-1), { x: 100, y: 40 });
  assert.ok(clipped.some(p => p.x === 100 && p.y === 0), 'the corner must be kept');
  assert.ok(Math.abs(polylineLength(clipped) - (70 + 40)) < 1e-9);
});

test('clipToSpan: gives the same stretch when the track runs the other way', () => {
  const fwd = clipToSpan(line, { x: 30, y: 5 }, { x: 105, y: 40 });
  const back = clipToSpan(line, { x: 105, y: 40 }, { x: 30, y: 5 });
  assert.deepEqual(fwd, back);
});

test('clipToSpan: a track covering only part of a long line does not drag in the rest', () => {
  const long = [{ x: 0, y: 0 }, { x: 10000, y: 0 }];
  const c = clipToSpan(long, { x: 2000, y: 3 }, { x: 2600, y: -2 });
  assert.ok(Math.abs(polylineLength(c) - 600) < 1e-9);
});

test('rankLinesByProximity: puts the line the track actually follows first', () => {
  const track = Array.from({ length: 50 }, (_, i) => ({ x: i * 10, y: 4 + (i % 2) }));   // wobbles ~4 m north of y=0
  const lines = [
    { name: 'far',    points: [{ x: 0, y: 500 }, { x: 500, y: 500 }] },
    { name: 'right',  points: [{ x: -50, y: 0 }, { x: 600, y: 0 }] },
    { name: 'across', points: [{ x: 250, y: -300 }, { x: 250, y: 300 }] }
  ];
  const ranked = rankLinesByProximity(track, lines);
  assert.equal(ranked[0].name, 'right');
  assert.ok(ranked[0].medianDist < 6);
  assert.ok(ranked[1].medianDist > ranked[0].medianDist);
});
