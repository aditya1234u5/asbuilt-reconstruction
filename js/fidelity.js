/* Fidelity check — pure functions, no DOM, unit-testable.
 *
 * Answers one question: "does the reconstructed line actually follow the line
 * it was built from?" It measures distance in BOTH directions (reference ->
 * result and result -> reference), so a result that cuts corners AND a result
 * that invents corners are both caught. Distances are sampled along the lines,
 * not just at vertices, because a sparse line can deviate most mid-segment.
 *
 * All distances are in the same units as the points. Tolerances are passed in
 * by the caller (the app converts feet -> its current survey unit). */

/** Default tolerances, in FEET. */
export const FEET = {
  far: 25,       // a point further than this from the other line counts as "off the line"
  sparse: 100    // average input spacing above this is too sparse for this method
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p, poly) {
  if (poly.length === 1) return dist(p, poly[0]);
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distToSegment(p, poly[i], poly[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

export function polylineLength(poly) {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += dist(poly[i - 1], poly[i]);
  return L;
}

/** Points along a polyline at roughly `step` spacing (always includes the end
 *  points). The step grows if needed so there are never more than `maxSamples`. */
export function densify(poly, step, maxSamples = 3000) {
  if (poly.length < 2) return poly.slice();
  const total = polylineLength(poly);
  const s = Math.max(step, total / maxSamples) || step;
  const out = [poly[0]];
  let carry = 0; // distance already walked since the last sample
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], segLen = dist(a, b);
    if (segLen === 0) continue;
    let pos = s - carry;
    while (pos <= segLen) {
      const t = pos / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      pos += s;
    }
    carry = segLen - (pos - s);
  }
  out.push(poly[poly.length - 1]);
  return out;
}

function summarize(samples, poly, farTol) {
  const d = samples.map(p => distToPolyline(p, poly)).sort((a, b) => a - b);
  const n = d.length;
  const mean = d.reduce((s, x) => s + x, 0) / n;
  return {
    mean,
    p95: d[Math.min(n - 1, Math.floor(0.95 * n))],
    max: d[n - 1],
    farFrac: d.filter(x => x > farTol).length / n
  };
}

/** Average / maximum gap between consecutive input points. */
export function spacingStats(points) {
  if (points.length < 2) return { mean: 0, max: 0 };
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(dist(points[i - 1], points[i]));
  return { mean: gaps.reduce((s, x) => s + x, 0) / gaps.length, max: Math.max(...gaps) };
}

/**
 * Compare a reconstructed polyline against a reference polyline.
 *
 * @param reference      [{x,y}] the line the result should follow
 * @param resultVertices [{x,y}] the reconstructed vertices
 * @param opts.farTol    distance (in point units) beyond which a sample is "off the line"
 * @param opts.sampleStep spacing (in point units) for sampling along the lines
 * @param opts.inputPoints optional [{x,y}] the actual input shots, for the sparse-input check
 * @param opts.sparseTol average input spacing above this triggers the sparse warning
 */
export function compareToReference(reference, resultVertices, opts) {
  const { farTol, sampleStep, inputPoints = reference, sparseTol } = opts;
  const refSamples = densify(reference, sampleStep);
  const resSamples = densify(resultVertices, sampleStep);
  const refToResult = summarize(refSamples, resultVertices, farTol);
  const resultToRef = summarize(resSamples, reference, farTol);
  const referenceLength = polylineLength(reference);
  const resultLength = polylineLength(resultVertices);
  const lengthDiffPct = referenceLength ? (resultLength / referenceLength - 1) * 100 : 0;
  const spacing = spacingStats(inputPoints);
  const sparse = spacing.mean > sparseTol;

  const worstFar = Math.max(refToResult.farFrac, resultToRef.farFrac);
  const reasons = [];
  if (worstFar >= POOR.farFrac) reasons.push(`${pct(worstFar)} of the line is more than the tolerance from the other line`);
  else if (worstFar >= CHECK.farFrac) reasons.push(`${pct(worstFar)} of the line is more than the tolerance from the other line`);
  if (Math.abs(lengthDiffPct) >= POOR.lengthPct) reasons.push(`total length differs by ${lengthDiffPct.toFixed(1)}%`);
  else if (Math.abs(lengthDiffPct) >= CHECK.lengthPct) reasons.push(`total length differs by ${lengthDiffPct.toFixed(1)}%`);
  if (sparse) reasons.push('the input points are very far apart for this method');

  let verdict = 'good';
  if (worstFar >= CHECK.farFrac || Math.abs(lengthDiffPct) >= CHECK.lengthPct || sparse) verdict = 'check';
  if (worstFar >= POOR.farFrac || Math.abs(lengthDiffPct) >= POOR.lengthPct) verdict = 'poor';

  return {
    verdict, reasons, sparse, spacing,
    referenceLength, resultLength, lengthDiffPct,
    refToResult, resultToRef, farTol
  };
}

const pct = f => (100 * f).toFixed(0) + '%';

/** Verdict thresholds. These are heuristics, set by running the check over
 *  known-good inputs (the sample routes and dense BCER lines: all <= 2% of the
 *  line off-tolerance and <= 1.1% length difference) and known-bad ones (sparse
 *  BCER line #3121 and a 47 km gently curving line: 60-97% off-tolerance).
 *  The raw numbers are always shown so a user can judge for themselves. */
export const CHECK = { farFrac: 0.03, lengthPct: 2 };
export const POOR = { farFrac: 0.10, lengthPct: 5 };
