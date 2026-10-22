import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lonLatToUTM, utmZone, zoneCentralMeridian, extractLines, projectLine,
  polylineLength, simulateSurvey
} from '../js/geojson.js';

// Reference values from pyproj (EPSG:32610, UTM zone 10N).
test('lonLatToUTM matches pyproj to < 1 mm', () => {
  const cases = [
    [-120.04152269739845, 56.06247023257609, [684185.2130421725, 6216978.968569943]],
    [-123.0, 49.0, [500000.0, 5427455.7811991675]],
    [-125.5, 54.2, [336928.9574100864, 6008660.392147212]]
  ];
  for (const [lon, lat, [x, y]] of cases) {
    const p = lonLatToUTM(lon, lat, -123);
    assert.ok(Math.abs(p.x - x) < 0.001, `x ${p.x} vs ${x}`);
    assert.ok(Math.abs(p.y - y) < 0.001, `y ${p.y} vs ${y}`);
  }
});

test('utmZone / central meridian', () => {
  assert.equal(utmZone(-120.5), 10);
  assert.equal(zoneCentralMeridian(10), -123);
  assert.equal(utmZone(-117.1), 11);
});

test('extractLines: FeatureCollection with LineString, MultiLineString and a Point', () => {
  const geo = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { a: 1 }, geometry: { type: 'LineString', coordinates: [[-120, 56], [-120.01, 56.01]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[-120, 56], [-120.1, 56.1]], [[-121, 56], [-121.1, 56.1]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-120, 56] } }
    ]
  };
  const lines = extractLines(geo);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => l.id), ['1', '2.1', '2.2']);
});

test('projectLine: drops duplicate vertices and measures plausible length', () => {
  const { points } = projectLine([[-123, 49], [-123, 49], [-123, 49.01]]);
  assert.equal(points.length, 2);
  // 0.01 deg of latitude is about 1.11 km
  const L = polylineLength(points);
  assert.ok(L > 1100 && L < 1120, String(L));
});

test('simulateSurvey: spacing, bounded meander, deterministic', () => {
  const line = [{ x: 0, y: 0 }, { x: 0, y: 1000 }];
  const a = simulateSurvey(line, { minSpacing: 20, maxSpacing: 40, halfWidth: 1 });
  const b = simulateSurvey(line, { minSpacing: 20, maxSpacing: 40, halfWidth: 1 });
  assert.deepEqual(a, b);
  assert.ok(a.length > 1000 / 40 && a.length < 1000 / 20 + 2);
  for (const p of a) assert.ok(Math.abs(p.x) <= 1.0001, 'lateral offset within half width');
  for (let i = 1; i < a.length - 1; i++) {
    const d = a[i].y - a[i - 1].y;
    assert.ok(d > 15 && d < 45, 'spacing ' + d);
  }
});
