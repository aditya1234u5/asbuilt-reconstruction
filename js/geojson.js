/* GeoJSON import helpers — pure functions, no DOM, unit-testable.
 *
 * GeoJSON stores longitude/latitude in degrees. The reconstruction algorithm
 * needs flat X/Y in feet or metres, so lines are projected with a Transverse
 * Mercator (UTM) projection first. */

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const K0 = 0.9996;

/** UTM zone number (1-60) for a longitude. */
export function utmZone(lon) {
  return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}

/** Central meridian (degrees) of a UTM zone. */
export function zoneCentralMeridian(zone) {
  return (zone - 1) * 6 - 180 + 3;
}

/** Project lon/lat (degrees) to UTM metres (Kruger series, accurate to well
 *  under a millimetre inside the zone). Northern hemisphere convention:
 *  false easting 500 km, no false northing. */
export function lonLatToUTM(lon, lat, lon0) {
  const n = WGS84_F / (2 - WGS84_F);
  const A = WGS84_A / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const alpha = [
    n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16,
    13 * n * n / 48 - 3 * n ** 3 / 5,
    61 * n ** 3 / 240
  ];
  const rad = Math.PI / 180;
  const phi = lat * rad;
  const dl = (lon - lon0) * rad;
  const c = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi1 = Math.atan2(t, Math.cos(dl));
  const eta1 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 3; j++) {
    xi += alpha[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += alpha[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return { x: 500000 + K0 * A * eta, y: K0 * A * xi };
}

/** Pull every line out of a GeoJSON object (FeatureCollection, Feature or bare
 *  geometry). MultiLineStrings are split into one entry per part. Returns
 *  [{ id, props, coords: [[lon, lat], ...] }]. Lines with < 2 vertices are skipped. */
export function extractLines(geo) {
  const out = [];
  const addGeom = (g, props, id) => {
    if (!g) return;
    if (g.type === 'LineString') {
      if (g.coordinates.length >= 2) out.push({ id, props, coords: g.coordinates });
    } else if (g.type === 'MultiLineString') {
      g.coordinates.forEach((part, k) => {
        if (part.length >= 2) out.push({ id: g.coordinates.length > 1 ? `${id}.${k + 1}` : String(id), props, coords: part });
      });
    } else if (g.type === 'GeometryCollection') {
      (g.geometries || []).forEach(sub => addGeom(sub, props, id));
    }
  };
  if (geo.type === 'FeatureCollection') {
    (geo.features || []).forEach((f, i) => addGeom(f.geometry, f.properties || {}, String(i + 1)));
  } else if (geo.type === 'Feature') {
    addGeom(geo.geometry, geo.properties || {}, '1');
  } else {
    addGeom(geo, {}, '1');
  }
  return out;
}

/** Project a lon/lat line to metres in the UTM zone of its midpoint.
 *  Consecutive duplicate vertices are dropped. */
export function projectLine(coords) {
  const mid = coords[Math.floor(coords.length / 2)];
  const zone = utmZone(mid[0]);
  const lon0 = zoneCentralMeridian(zone);
  const pts = [];
  for (const [lon, lat] of coords) {
    const p = lonLatToUTM(lon, lat, lon0);
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6) pts.push(p);
  }
  return { points: pts, zone };
}

export function polylineLength(points) {
  let L = 0;
  for (let i = 1; i < points.length; i++) L += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return L;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn a clean centreline into survey-style shots: one shot every
 *  minSpacing..maxSpacing along the line, each pushed sideways by a smooth,
 *  bounded meander of up to +/- halfWidth (the crew walks beside the pipe, not
 *  on its axis). All distances are in the same units as the points. */
export function simulateSurvey(points, { minSpacing, maxSpacing, halfWidth, seed = 7 }) {
  const rnd = mulberry32(seed);
  const segLen = [];
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segLen.push(d);
    cum.push(cum[i - 1] + d);
  }
  const total = cum[cum.length - 1];
  const stations = [0];
  while (stations[stations.length - 1] < total - maxSpacing) {
    stations.push(stations[stations.length - 1] + minSpacing + rnd() * (maxSpacing - minSpacing));
  }
  stations.push(total);

  const shots = [];
  let off = 0, k = 0;
  for (const s of stations) {
    while (k < segLen.length - 1 && s > cum[k + 1]) k++;
    const a = points[k], b = points[k + 1];
    const len = segLen[k] || 1;
    const t = Math.min(1, Math.max(0, (s - cum[k]) / len));
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    off = Math.max(-halfWidth, Math.min(halfWidth, 0.6 * off + (rnd() * 2 - 1) * halfWidth * 0.9));
    shots.push({ x: a.x + (b.x - a.x) * t + uy * off, y: a.y + (b.y - a.y) * t - ux * off });
  }
  return shots;
}
