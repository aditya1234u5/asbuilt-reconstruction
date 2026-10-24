/* Reference-line helpers — pure, no DOM.
 *
 * A reference line (e.g. the official centreline of the road or pipe you
 * surveyed) is usually longer than your track and sits among many other
 * lines. These helpers find the right one and trim it to the stretch you
 * actually covered, so the fidelity check compares like with like. */

function nearestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx, y = a.y + t * dy;
  return { t, x, y, dist: Math.hypot(p.x - x, p.y - y) };
}

/** Closest point on a polyline: { dist, seg, t, x, y, along } where `along` is
 *  the distance from the polyline's start. */
export function nearestOnPolyline(p, poly) {
  let best = null, acc = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const segLen = Math.hypot(poly[i + 1].x - poly[i].x, poly[i + 1].y - poly[i].y);
    const c = nearestOnSegment(p, poly[i], poly[i + 1]);
    if (!best || c.dist < best.dist) best = { dist: c.dist, seg: i, t: c.t, x: c.x, y: c.y, along: acc + c.t * segLen };
    acc += segLen;
  }
  return best;
}

/** The part of `poly` between the points where `from` and `to` meet it,
 *  in the polyline's own direction. */
export function clipToSpan(poly, from, to) {
  if (poly.length < 2) return poly.slice();
  let a = nearestOnPolyline(from, poly), b = nearestOnPolyline(to, poly);
  if (a.along > b.along) [a, b] = [b, a];
  const out = [{ x: a.x, y: a.y }];
  for (let i = a.seg + 1; i <= b.seg; i++) out.push({ x: poly[i].x, y: poly[i].y });
  out.push({ x: b.x, y: b.y });
  // drop zero-length repeats
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > 1e-9);
}

/** Rank candidate lines by how close they run to a track. For each line, the
 *  median distance from ~`samples` evenly spaced track points to the line.
 *  @param track  [{x,y}]
 *  @param lines  [{ points:[{x,y}], ... }]
 *  @returns the same line objects, plus `medianDist`, sorted nearest first. */
export function rankLinesByProximity(track, lines, samples = 150) {
  const step = Math.max(1, Math.floor(track.length / samples));
  const probe = track.filter((_, i) => i % step === 0);
  return lines
    .map(l => {
      const d = probe.map(p => nearestOnPolyline(p, l.points).dist).sort((x, y) => x - y);
      return { ...l, medianDist: d[Math.floor(d.length / 2)] };
    })
    .sort((a, b) => a.medianDist - b.medianDist);
}
