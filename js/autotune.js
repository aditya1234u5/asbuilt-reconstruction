/* Auto-tune — pure, no DOM, unit-testable.
 *
 * Tries a grid of (bend threshold, min points per segment) settings and picks
 * the one that gives the FEWEST vertices while still following the line,
 * judged by the same fidelity measure the app shows (js/fidelity.js).
 *
 * This replaces an older objective (lowest average segment residual) that
 * rewards over-segmentation: tiny 1-2 shot segments always fit perfectly, so it
 * could pick settings that looked tidy but did not follow the line at all. */
import { reconstruct, rdp } from './algorithm.js';
import { compareToReference, CHECK } from './fidelity.js';

export const DEFL_GRID = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
export const MINPTS_GRID = [3, 4, 5, 6, 7, 8];

/**
 * @param rawPoints   [{x,y}] input shots
 * @param reference   [{x,y}] line the result should follow
 * @param opts        { widthUnits, farTol, sampleStep, sparseTol, judgeLength? }  (all in point units)
 * @returns { best, tried, all } where best = { deflDeg, minPts, vertices, verdict, acceptable, cmp }
 */
export function autoTune(rawPoints, reference, opts, { deflGrid = DEFL_GRID, minPtsGrid = MINPTS_GRID } = {}) {
  const judgeLength = opts.judgeLength !== false;
  const isOk = c => c.worstFar < CHECK.farFrac && (!c.judgeLength || Math.abs(c.lengthDiffPct) < CHECK.lengthPct);
  const precise = verts => compareToReference(reference, verts, {
    farTol: opts.farTol, sampleStep: opts.sampleStep, sparseTol: opts.sparseTol, inputPoints: rawPoints, judgeLength
  });

  // Stage 1: score every setting quickly. The 60+ candidates are compared against a
  // thinned reference (<= farTol/20 of error) with fewer samples, which is fast but coarse.
  const ref = rdp(reference, opts.farTol / 20);
  const all = [];
  for (const deflDeg of deflGrid) {
    for (const minPts of minPtsGrid) {
      const r = reconstruct(rawPoints, opts.widthUnits, deflDeg, minPts);
      if (r.vertices.length < 2) continue;
      const cmp = compareToReference(ref, r.vertices, {
        farTol: opts.farTol, sampleStep: opts.sampleStep, sparseTol: opts.sparseTol,
        inputPoints: rawPoints, maxSamples: 800, judgeLength
      });
      all.push({ deflDeg, minPts, vertices: r.vertices.length, verts: r.vertices, verdict: cmp.verdict, acceptable: isOk(cmp), cmp });
    }
  }
  if (!all.length) return { best: null, tried: 0, all };

  // Stage 2: confirm with the SAME full-precision measurement the app displays, so the
  // setting reported as "following the line" really does. Try the candidates with the
  // fewest vertices first; fall back to the next if one fails the precise check.
  const byVertices = (a, b) => a.vertices - b.vertices || a.cmp.refToResult.mean - b.cmp.refToResult.mean;
  const shortlist = all.filter(a => a.acceptable).sort(byVertices).slice(0, 8);
  const checked = [];
  for (const a of shortlist) {
    const cmp = precise(a.verts);
    const entry = { ...a, cmp, verdict: cmp.verdict, acceptable: isOk(cmp) };
    checked.push(entry);
    if (entry.acceptable) return { best: strip(entry), tried: all.length, all: all.map(strip) };
  }
  // Nothing verified. Report the least bad: among the shortlist if there was one, else among all.
  const pool = checked.length ? checked : all.slice().sort((a, b) => (a.cmp.worstFar - b.cmp.worstFar) || (Math.abs(a.cmp.lengthDiffPct) - Math.abs(b.cmp.lengthDiffPct))).slice(0, 4)
    .map(a => { const cmp = precise(a.verts); return { ...a, cmp, verdict: cmp.verdict, acceptable: isOk(cmp) }; });
  const best = pool.reduce((b, a) => (a.cmp.worstFar < b.cmp.worstFar || (a.cmp.worstFar === b.cmp.worstFar && Math.abs(a.cmp.lengthDiffPct) < Math.abs(b.cmp.lengthDiffPct))) ? a : b);
  return { best: strip(best), tried: all.length, all: all.map(strip) };
}

const strip = ({ verts, ...rest }) => rest;   // callers don't need the vertex arrays
