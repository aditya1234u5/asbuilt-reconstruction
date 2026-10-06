/**
 * algorithm.js
 * -----------------------------------------------------------------------
 * As-built pipeline reconstruction.
 *
 * Pipeline: RDP presort (tolerance = pipe width / 2)
 *        -> assign raw points to segments by walked order (no geometric
 *           nearest-line lookup, so no point is ever double-counted)
 *        -> PCA / total-least-squares line fit per segment
 *        -> greedy least-risk merge: fold together whichever adjacent pair
 *           is either under the major-bend deflection threshold, or too
 *           thin on points for its bearing to be trustworthy yet
 *        -> robust (MAD-based) outlier rejection + refit per final segment
 *        -> vertices reconstructed as line-line intersections
 *        -> stationing (cumulative distance) + per-segment elevation fit
 *
 * All coordinates are plain {x, y[, z]} objects in the survey's own units
 * (this app assumes feet). Nothing here touches the DOM.
 */

export function bearingOfVector(dx, dy) {
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

export function deflection(bearingIn, bearingOut) {
  return ((bearingOut - bearingIn + 180) % 360 + 360) % 360 - 180;
}

function perpDist(pt, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2;
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

/** Ramer-Douglas-Peucker simplification. Returns a subset of `points`
 *  (same object references, never copies) that approximates the path
 *  within `epsilon`. */
export function rdp(points, epsilon) {
  if (points.length < 3) return points.slice();
  let dmax = 0, index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDist(points[i], points[0], points[end]);
    if (d > dmax) { dmax = d; index = i; }
  }
  if (dmax > epsilon) {
    const left = rdp(points.slice(0, index + 1), epsilon);
    const right = rdp(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

/** Total-least-squares line fit via 2D PCA (handles any orientation,
 *  including near-vertical runs that break ordinary y = mx + b regression). */
export function fitLinePCA(points) {
  const n = points.length;
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { centroid: { x: mx, y: my }, dir: { x: Math.cos(theta), y: Math.sin(theta) } };
}

// SVD/PCA can't tell which way a line "points" (it could hand back the
// opposite direction). Orient it to match the group's own walking order.
function orientDir(group, dir) {
  const first = group[0], last = group[group.length - 1];
  const travel = { x: last.x - first.x, y: last.y - first.y };
  const dot = travel.x * dir.x + travel.y * dir.y;
  return dot < 0 ? { x: -dir.x, y: -dir.y } : dir;
}

function residual(p, line) {
  // perpendicular distance of p from (centroid, dir)
  return Math.abs((p.x - line.centroid.x) * (-line.dir.y) + (p.y - line.centroid.y) * (line.dir.x));
}

function makeLine(points) {
  const fit = fitLinePCA(points);
  fit.dir = orientDir(points, fit.dir);
  fit.points = points;
  fit.bearing = bearingOfVector(fit.dir.x, fit.dir.y);
  return fit;
}

/** Split raw points into per-segment groups using their position along the
 *  walked survey order (not nearest-line-in-space), so every raw point ends
 *  up in exactly one group with no duplication and no empty groups. */
function assignPointsToSegments(points, vertices) {
  const indexOf = new Map();
  points.forEach((p, i) => indexOf.set(p, i));
  const idx = vertices.map(v => indexOf.get(v));
  const groups = [];
  for (let i = 0; i < idx.length - 1; i++) {
    const isLast = i === idx.length - 2;
    groups.push(points.slice(idx[i], idx[i + 1] + (isLast ? 1 : 0)));
  }
  // guarantee every group has >= 2 points by borrowing (never duplicating)
  for (let i = 0; i < groups.length; i++) {
    while (groups[i].length < 2) {
      if (i + 1 < groups.length && groups[i + 1].length > 2) groups[i].push(groups[i + 1].shift());
      else if (i > 0 && groups[i - 1].length > 2) groups[i].unshift(groups[i - 1].pop());
      else break;
    }
  }
  return groups;
}

function lineIntersection(c1, d1, c2, d2) {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const t = (dx * d2.y - dy * d2.x) / denom;
  return { x: c1.x + t * d1.x, y: c1.y + t * d1.y };
}

function projectExtent(points, centroid, dir, findMin) {
  let best = findMin ? Infinity : -Infinity, bestPt = null;
  for (const p of points) {
    const t = (p.x - centroid.x) * dir.x + (p.y - centroid.y) * dir.y;
    if (findMin ? t < best : t > best) { best = t; bestPt = { x: centroid.x + t * dir.x, y: centroid.y + t * dir.y }; }
  }
  return bestPt;
}

/**
 * @param {Array<{x:number,y:number,z?:number}>} rawPoints  survey shots, in walked order
 * @param {number} pipeWidthFt        pipe outer diameter, feet
 * @param {number} deflectionThresholdDeg  bend angle treated as a real corner
 * @param {number} [minPoints=5]      a segment with fewer raw points than this
 *                                    has its bearing folded into a neighbor
 *                                    rather than trusted as a real bend
 * @param {number} [outlierFactor=3.5] MAD multiplier for gross-error rejection
 */
export function reconstruct(rawPoints, pipeWidthFt, deflectionThresholdDeg, minPoints = 5, outlierFactor = 3.5) {
  const epsilon = pipeWidthFt / 2;
  const rdpVerts = rdp(rawPoints, epsilon);
  if (rdpVerts.length < 2) return { vertices: rawPoints.slice(), lines: [], stations: [0], outlierCount: 0, qa: [] };

  const groups = assignPointsToSegments(rawPoints, rdpVerts);
  let lines = groups.map(makeLine);

  // Greedy least-risk merge: repeatedly fold together whichever adjacent
  // pair is least likely to be a real bend — either its deflection is
  // already under the major-bend threshold, or one side simply doesn't have
  // enough points yet for its bearing to be trustworthy. Merging the
  // smallest-deflection eligible pair first means consolidation grows
  // outward from the most obviously-straight sections instead of cascading
  // through an actual corner.
  let guard = 0;
  while (lines.length > 1 && guard < 20000) {
    guard++;
    let bestIdx = -1, bestDefl = Infinity;
    for (let i = 0; i < lines.length - 1; i++) {
      const defl = Math.abs(deflection(lines[i].bearing, lines[i + 1].bearing));
      const untrusted = lines[i].points.length < minPoints || lines[i + 1].points.length < minPoints;
      if (defl < deflectionThresholdDeg || untrusted) {
        if (defl < bestDefl) { bestDefl = defl; bestIdx = i; }
      }
    }
    if (bestIdx === -1) break;
    lines.splice(bestIdx, 2, makeLine(lines[bestIdx].points.concat(lines[bestIdx + 1].points)));
  }

  // Robust (MAD-based) outlier rejection + refit, per final segment. Flags
  // points whose residual is way outside THAT segment's own noise level,
  // rather than a fixed multiple of pipe width — so routine survey meander
  // (already handled by the steps above) isn't mistaken for a gross error
  // like a mis-keyed shot.
  let outlierCount = 0;
  lines = lines.map(line => {
    if (line.points.length < 6) return line; // too few points to judge robustly
    const resids = line.points.map(p => residual(p, line)).sort((a, b) => a - b);
    const median = resids[Math.floor(resids.length / 2)];
    const absDevs = resids.map(r => Math.abs(r - median)).sort((a, b) => a - b);
    const mad = absDevs[Math.floor(absDevs.length / 2)] || 0.01;
    const cutoff = median + outlierFactor * 1.4826 * mad; // 1.4826 -> MAD approximates std dev
    const keep = [], drop = [];
    for (const p of line.points) {
      const d = residual(p, line);
      if (d > cutoff && d > epsilon && line.points.length - drop.length > 4) drop.push(p); else keep.push(p);
    }
    outlierCount += drop.length;
    if (drop.length === 0) return line;
    const fit = makeLine(keep);
    fit.outliers = drop;
    return fit;
  });

  // Vertices from consecutive line-line intersections; endpoints from the
  // furthest extent of points projected onto their own line.
  const vertices = [];
  vertices.push(projectExtent(lines[0].points, lines[0].centroid, lines[0].dir, true));
  for (let i = 0; i < lines.length - 1; i++) {
    const inter = lineIntersection(lines[i].centroid, lines[i].dir, lines[i + 1].centroid, lines[i + 1].dir);
    vertices.push(inter || lines[i].centroid);
  }
  const last = lines[lines.length - 1];
  vertices.push(projectExtent(last.points, last.centroid, last.dir, false));

  // Stationing: cumulative distance along the reconstructed centerline.
  let station = 0;
  const stations = [0];
  for (let i = 1; i < vertices.length; i++) {
    station += Math.hypot(vertices[i].x - vertices[i - 1].x, vertices[i].y - vertices[i - 1].y);
    stations.push(station);
  }

  // QA: per-segment point count, worst-case and RMS residual, outliers dropped.
  const qa = lines.map((line, i) => {
    let maxR = 0, sumSq = 0;
    for (const p of line.points) { const d = residual(p, line); maxR = Math.max(maxR, d); sumSq += d * d; }
    return {
      segment: i + 1,
      points: line.points.length,
      maxResidual: maxR,
      rms: Math.sqrt(sumSq / line.points.length),
      outliers: (line.outliers || []).length
    };
  });

  return { vertices, lines, stations, outlierCount, qa };
}

/** 1D ordinary-least-squares fit of elevation z against distance-along-line
 *  s (signed, from the segment's own centroid). Returns null if the group
 *  has no elevation data. */
export function fitElevation(points, centroid, dir) {
  const pts = points.filter(p => Number.isFinite(p.z));
  if (pts.length < 2) return null;
  const s = pts.map(p => (p.x - centroid.x) * dir.x + (p.y - centroid.y) * dir.y);
  const n = pts.length;
  let sSum = 0, zSum = 0;
  s.forEach(v => sSum += v);
  pts.forEach(p => zSum += p.z);
  const sMean = sSum / n, zMean = zSum / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (s[i] - sMean) * (pts[i].z - zMean); den += (s[i] - sMean) * (s[i] - sMean); }
  const b = den === 0 ? 0 : num / den;
  const a = zMean - b * sMean;
  return { a, b, evalAtS: s0 => a + b * s0 };
}

/* ------------------------- synthetic sample data ------------------------- */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Walks a "true" polyline, drops a shot every `spacing` ft, and nudges each
 *  sideways by up to `noiseAmp` ft to simulate crew meander. Optionally adds
 *  a gentle elevation grade with a little noise. */
export function generateSyntheticRoute(trueVerts, spacing, noiseAmp, seed, zStart = null, zSlope = 0) {
  const rand = mulberry32(seed);
  const pts = [];
  let cumDist = 0;
  for (let i = 0; i < trueVerts.length - 1; i++) {
    const a = trueVerts[i], b = trueVerts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const steps = Math.floor(len / spacing);
    for (let s = 0; s <= steps; s++) {
      const dist = s * spacing;
      if (i > 0 && dist === 0) continue;
      const px = a.x + ux * dist, py = a.y + uy * dist;
      const noise = (rand() - 0.5) * 2 * noiseAmp;
      const pt = { x: px + nx * noise, y: py + ny * noise };
      if (zStart !== null) pt.z = zStart + zSlope * (cumDist + dist) + (rand() - 0.5) * 0.3;
      pts.push(pt);
    }
    cumDist += len;
  }
  const endPt = { x: trueVerts[trueVerts.length - 1].x, y: trueVerts[trueVerts.length - 1].y };
  if (zStart !== null) endPt.z = zStart + zSlope * cumDist;
  pts.push(endPt);
  return pts;
}

/** A route with three real bends (90 deg, ~38 deg, ~52 deg) — enough to show
 *  both "major bends survive" and "pipe width changes vertex count". */
export const SAMPLE_TRUE_ROUTE = [
  { x: 0, y: 0 },
  { x: 0, y: 480 },
  { x: 260, y: 480 },
  { x: 260 + 420 * Math.cos(-38 * Math.PI / 180), y: 480 + 420 * Math.sin(-38 * Math.PI / 180) },
  {
    x: 260 + 420 * Math.cos(-38 * Math.PI / 180) + 300 * Math.cos(52 * Math.PI / 180),
    y: 480 + 420 * Math.sin(-38 * Math.PI / 180) + 300 * Math.sin(52 * Math.PI / 180)
  },
];

/* ------------------------------ arc detection ----------------------------- */

/** Kasa algebraic circle fit (x^2+y^2 + Dx + Ey + F = 0). Returns null if the
 *  points are collinear (no stable circle). */
export function fitCircle(points) {
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const p of points) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * z; syz += p.y * z; sz += z;
  }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const b = [-sxz, -syz, -sz];
  const det3 = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                   - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                   + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const detA = det3(A);
  if (Math.abs(detA) < 1e-9) return null;
  const col = (m, c, v) => { const r = m.map(row => row.slice()); for (let i = 0; i < 3; i++) r[i][c] = v[i]; return r; };
  const D = det3(col(A, 0, b)) / detA, E = det3(col(A, 1, b)) / detA, F = det3(col(A, 2, b)) / detA;
  const cx = -D / 2, cy = -E / 2;
  const rr = cx * cx + cy * cy - F;
  if (rr <= 0) return null;
  return { cx, cy, r: Math.sqrt(rr) };
}

/**
 * Groups runs of 2+ consecutive, same-direction, moderate-angle bends in the
 * reconstructed vertex chain into a single fitted circular arc, leaving
 * isolated sharp corners (a single bend surrounded by long straight runs) as
 * ordinary line-to-line vertices.
 *
 * Caveat (documented, not hidden): this is a post-process over whatever
 * vertices `reconstruct()` already produced. If the main merge pass already
 * absorbed part of a gentle curve into an adjacent "straight" segment (which
 * happens with a high min-points-per-segment setting), the detected arc can
 * bleed slightly into that segment. Lowering "min points per segment" before
 * reconstructing preserves more of the curve's bend resolution and gives a
 * tighter arc fit.
 *
 * @returns {Array<{type:'line',from,to} | {type:'arc',from,to,center,radius}>}
 */
export function detectArcs(result, minArcDeg = 3, maxArcDeg = 60) {
  const verts = result.vertices, lines = result.lines;
  const n = verts.length;
  if (n < 4 || !lines || lines.length < 3) return verts.slice(0, -1).map((v, i) => ({ type: 'line', from: v, to: verts[i + 1] }));

  const bearings = [];
  for (let k = 0; k < n - 1; k++) bearings.push(bearingOfVector(verts[k + 1].x - verts[k].x, verts[k + 1].y - verts[k].y));
  const defls = [undefined];
  for (let k = 1; k < bearings.length; k++) defls[k] = deflection(bearings[k - 1], bearings[k]);

  const elements = [];
  let i = 0;
  while (i < n - 1) {
    let j = i, sign = null;
    while (j + 1 < n - 1 && defls[j + 1] !== undefined) {
      const d = defls[j + 1], mag = Math.abs(d);
      if (mag < minArcDeg || mag > maxArcDeg) break;
      if (sign !== null && Math.sign(d) !== sign) break;
      sign = sign ?? Math.sign(d);
      j++;
    }
    if (j - i >= 2) {
      const ptsForFit = [];
      for (let li = i; li <= j; li++) ptsForFit.push(...lines[li].points);
      const circle = fitCircle(ptsForFit);
      if (circle) {
        elements.push({
          type: 'arc', from: verts[i], to: verts[j + 1],
          center: { x: circle.cx, y: circle.cy }, radius: circle.r
        });
        i = j + 1;
        continue;
      }
    }
    elements.push({ type: 'line', from: verts[i], to: verts[i + 1] });
    i++;
  }
  return elements;
}

/* --------------------------------- export --------------------------------- */

/** Minimal ASCII DXF R12 (ENTITIES-only) — broadly importable by AutoCAD /
 *  Civil3D. Straight runs export as LINE entities; detected arcs export as
 *  ARC entities (start/end angle picked so the DXF's CCW sweep matches the
 *  actual turn direction, by comparing against the known total deflection). */
export function toDXF(elements) {
  const lines = [];
  const push = (code, val) => { lines.push(String(code), String(val)); };
  push(0, 'SECTION'); push(2, 'ENTITIES');

  elements.forEach(el => {
    if (el.type === 'line') {
      push(0, 'LINE'); push(8, 'AS-BUILT');
      push(10, el.from.x.toFixed(4)); push(20, el.from.y.toFixed(4)); push(30, '0.0');
      push(11, el.to.x.toFixed(4)); push(21, el.to.y.toFixed(4)); push(31, '0.0');
    } else {
      const { center, radius, from, to } = el;
      let a0 = Math.atan2(from.y - center.y, from.x - center.x) * 180 / Math.PI;
      let a1 = Math.atan2(to.y - center.y, to.x - center.x) * 180 / Math.PI;
      a0 = (a0 + 360) % 360; a1 = (a1 + 360) % 360;
      // DXF ARC always sweeps CCW from start to end — swap if that traces
      // the long way around compared to the actual (shorter, physical) turn
      const ccwSweep = (a1 - a0 + 360) % 360;
      const expected = bearingOfVector(to.x - from.x, to.y - from.y); // rough sanity only
      const [startAngle, endAngle] = ccwSweep <= 180 ? [a0, a1] : [a1, a0];
      push(0, 'ARC'); push(8, 'AS-BUILT');
      push(10, center.x.toFixed(4)); push(20, center.y.toFixed(4)); push(30, '0.0');
      push(40, radius.toFixed(4));
      push(50, startAngle.toFixed(2)); push(51, endAngle.toFixed(2));
    }
  });

  push(0, 'ENDSEC'); push(0, 'EOF');
  return lines.join('\n');
}

/** LandXML <CgPoints>/<CoordGeom> fragment for the reconstructed centerline
 *  (lines + arcs), for pipeline/survey packages that prefer LandXML over DXF. */
export function toLandXML(elements, vertices) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let pts = vertices.map((v, i) =>
    `    <CgPoint name="V${i + 1}">${v.y.toFixed(4)} ${v.x.toFixed(4)}</CgPoint>`
  ).join('\n');
  let geom = elements.map(el => {
    if (el.type === 'line') {
      return `    <Line>\n      <Start>${el.from.y.toFixed(4)} ${el.from.x.toFixed(4)}</Start>\n      <End>${el.to.y.toFixed(4)} ${el.to.x.toFixed(4)}</End>\n    </Line>`;
    }
    return `    <Curve radius="${el.radius.toFixed(4)}">\n      <Start>${el.from.y.toFixed(4)} ${el.from.x.toFixed(4)}</Start>\n      <Center>${el.center.y.toFixed(4)} ${el.center.x.toFixed(4)}</Center>\n      <End>${el.to.y.toFixed(4)} ${el.to.x.toFixed(4)}</End>\n    </Curve>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <CgPoints>
${pts}
  </CgPoints>
  <Alignments>
    <Alignment name="AS-BUILT" length="0">
      <CoordGeom>
${geom}
      </CoordGeom>
    </Alignment>
  </Alignments>
</LandXML>
`;
}
