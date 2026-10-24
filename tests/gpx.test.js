import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGPX, trackCoordinates } from '../js/gpx.js';

const P = (lat, lon, extra = '') => `<trkpt lat="${lat}" lon="${lon}">${extra}</trkpt>`;
const gpx = body => `<?xml version="1.0"?><gpx version="1.1" creator="t">${body}</gpx>`;

test('parseGPX: reads a track with elevation and time', () => {
  const g = gpx(`<trk><name>Walk</name><trkseg>${P(49.1, -123.2, '<ele>12.5</ele><time>2026-10-01T10:00:00Z</time>')}${P(49.2, -123.3)}</trkseg></trk>`);
  const { tracks } = parseGPX(g);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'Walk');
  assert.equal(tracks[0].points.length, 2);
  assert.deepEqual(tracks[0].points[0], { lat: 49.1, lon: -123.2, ele: 12.5, time: '2026-10-01T10:00:00Z' });
  assert.equal(tracks[0].points[1].ele, null);
});

test('parseGPX: joins segments of one track, in order', () => {
  const g = gpx(`<trk><trkseg>${P(1, 1)}${P(2, 2)}</trkseg><trkseg>${P(3, 3)}</trkseg></trk>`);
  assert.deepEqual(parseGPX(g).tracks[0].points.map(p => p.lat), [1, 2, 3]);
});

test('parseGPX: attribute order, quote style and self-closing points', () => {
  const g = gpx(`<trk><trkseg><trkpt lon='-123.5' lat='49.5'/><trkpt lat="49.6" lon="-123.6"></trkpt></trkseg></trk>`);
  const pts = parseGPX(g).tracks[0].points;
  assert.deepEqual(pts.map(p => [p.lat, p.lon]), [[49.5, -123.5], [49.6, -123.6]]);
});

test('parseGPX: a truncated file (no closing tags) still yields the points recorded so far', () => {
  const body = `<trk><name>Crashed</name><trkseg>${P(1, 1)}${P(2, 2)}${P(3, 3)}`;
  assert.equal(parseGPX(`<gpx>${body}`).tracks[0].points.length, 3);                 // cut off mid-segment
  assert.equal(parseGPX(`<gpx>${body}</trkseg></gpx>`).tracks[0].points.length, 3);  // missing </trk>
});

test('parseGPX: several tracks, the first one unclosed', () => {
  const g = `<gpx><trk><name>A</name><trkseg>${P(1, 1)}${P(2, 2)}</trkseg><trk><name>B</name><trkseg>${P(3, 3)}</trkseg></trk></gpx>`;
  const t = parseGPX(g).tracks;
  assert.deepEqual(t.map(x => [x.name, x.points.length]), [['A', 2], ['B', 1]]);
});

test('parseGPX: routes are read too, and waypoints are ignored', () => {
  const g = gpx(`<wpt lat="9" lon="9"><name>pin</name></wpt><rte><name>Plan</name><rtept lat="5" lon="6"/><rtept lat="7" lon="8"/></rte>`);
  const t = parseGPX(g).tracks;
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'route');
  assert.equal(t[0].points.length, 2);
});

test('parseGPX: skips points with impossible or missing coordinates', () => {
  const g = gpx(`<trk><trkseg>${P(49, -123)}${P(95, -123)}<trkpt lat="x" lon="y"/>${P(49.1, -200)}${P(49.2, -123.1)}</trkseg></trk>`);
  assert.equal(parseGPX(g).tracks[0].points.length, 2);
});

test('parseGPX: rejects a file that is not GPX', () => {
  assert.throws(() => parseGPX('{"type":"FeatureCollection"}'), /GPX/);
  assert.throws(() => parseGPX('a,b,c\n1,2,3'), /GPX/);
});

test('trackCoordinates: [lon, lat] order, and a stationary logger does not repeat fixes', () => {
  const { tracks } = parseGPX(gpx(`<trk><trkseg>${P(49, -123)}${P(49, -123)}${P(49, -123)}${P(49.1, -123.1)}</trkseg></trk>`));
  assert.deepEqual(trackCoordinates(tracks[0]), [[-123, 49], [-123.1, 49.1]]);
});
