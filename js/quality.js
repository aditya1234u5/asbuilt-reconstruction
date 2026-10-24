/* Survey-quality presets — pure, no DOM.
 *
 * The reconstruction treats "pipe width / 2" as its noise tolerance, which
 * suits survey-grade shots (errors of an inch or two). A phone or handheld GPS
 * is typically 3-5 m (10-16 ft) off, so with the pipe-width tolerance alone the
 * noise would be read as real bends. Each preset adds a noise floor: the
 * effective tolerance is the larger of the pipe-width tolerance and the preset's.
 * The fidelity check's "off the line" distance scales with it too. */

export const QUALITY = {
  survey:  { label: 'Survey grade (RTK / total station) — pipe width only', tolFt: 0 },
  mapping: { label: 'Mapping-grade GNSS (about 1 ft)', tolFt: 1 },
  phone:   { label: 'Phone / handheld GPS (about 15 ft)', tolFt: 15 }
};

/** Pipe width (in survey units) to hand to reconstruct(): at least twice the
 *  preset's tolerance, since reconstruct() uses width / 2 as its tolerance. */
export function effectiveWidth(pipeWidthUnits, qualityKey, feetToUnit = 1) {
  const q = QUALITY[qualityKey] || QUALITY.survey;
  return Math.max(pipeWidthUnits, 2 * q.tolFt * feetToUnit);
}

/** "Off the line" distance in feet for the fidelity check: 25 ft, or 3x the
 *  preset's tolerance if that is larger. */
export function farToleranceFt(qualityKey, baseFarFt = 25) {
  const q = QUALITY[qualityKey] || QUALITY.survey;
  return Math.max(baseFarFt, 3 * q.tolFt);
}
