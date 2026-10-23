# As-Built Pipeline Reconstruction

A survey crew walks an installed pipeline taking a shot every 20-40 ft. Those
shots meander left and right of true centerline — even on straight runs —
because the crew is walking alongside pipe that's 8-36+ inches wide, not a
single infinitesimal line. Turning that noisy point chain back into a clean
polyline of straight runs and bends is normally 4-8 hours of manual work in
CAD. This does it in a browser tab.

[![Tests](https://github.com/aditya1234u5/asbuilt-reconstruction/actions/workflows/test.yml/badge.svg)](https://github.com/aditya1234u5/asbuilt-reconstruction/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Live demo](https://aditya1234u5.github.io/asbuilt-reconstruction/)** — runs entirely in your browser, no upload, no backend. Click **Sample route** to try it instantly.

![As-Built Pipeline Reconstruction — 59 raw shots reduced to 5 vertices on the 8-inch sample route](docs/screenshot.png)

*The 8″ sample route: 59 raw survey shots reduced to 5 vertices (92% reduction), max residual 2.87 ft, with the elevation profile underneath.*

![Curved sample route — straight lead-in, a fitted 90° arc (blue), straight lead-out](docs/screenshot-curve.png)

*The **Curved route** sample: a true R = 400 ft sweep is recovered as line + arc + line.*

## How it works

1. **RDP presort** — Ramer-Douglas-Peucker simplification with a tolerance of
   half the pipe width. Wider pipe forgives more meander before a wiggle
   looks like a real bend; narrower pipe keeps tighter tolerance.
2. **Line fit** — each candidate segment is fit with total-least-squares
   (2D PCA), not ordinary `y = mx + b` regression, so it handles any
   orientation including near-vertical runs.
3. **Bend merge** — neighboring segments are folded together, least-risky
   pair first, whenever their deflection is under the major-bend threshold
   (default 10°) **or** a segment doesn't yet have enough raw points for its
   bearing to be trustworthy. That second condition is the fix for narrow
   pipe: a 2-3 point segment can have a bearing that's wrong by 20-30°
   purely from survey noise, and would otherwise get mistaken for a real
   corner.
4. **Outlier rejection** — a robust, MAD-based check per segment flags shots
   sitting far outside *that segment's own* noise level (equipment error,
   not routine meander) and refits without them.
5. **Vertices** — reconstructed as the geometric intersections of
   consecutive fitted lines, not as any single raw survey shot, then
   stationed (cumulative distance along the route).
6. **Elevation** — if your CSV has a Z column, each segment also gets a
   1D least-squares elevation fit, plotted as a profile under the plan view.
7. **Curve detection (optional)** — groups 2+ consecutive, same-direction,
   moderate-angle bends into one fitted circular arc (Kasa algebraic circle
   fit) instead of a chain of sharp corners, for routes with genuine
   long-radius sweeps rather than mitered elbows. Straight lead-in/lead-out
   runs are trimmed off the arc (a tangent is much longer than the chords of
   a real curve), so they stay straight lines instead of being folded into
   the fit. This is a post-process over whatever vertices the main pipeline
   already produced — if a high "min points per segment" setting already
   merged part of a curve into an adjacent straight run, the detected arc can
   still bleed slightly into it. Lowering that setting before reconstructing
   preserves more bend resolution for a tighter fit. Off by default; enable
   with the "Detect long-radius curves" checkbox, or click **Curved route**
   to see it work.

Bearing and deflection follow surveying convention: bearing is azimuth from
north (`atan2(dx, dy)`, not the usual `atan2(dy, dx)`), and deflection is the
signed turn between two bearings, wrapped correctly across the 0°/360°
boundary.

## Project structure

```
.
├── index.html              entry point
├── css/
│   └── style.css           survey/CAD-styled UI (light vellum + dark cyanotype) + print stylesheet
├── js/
│   ├── algorithm.js         reconstruction, arc detection, DXF/LandXML export — no DOM, unit-testable
│   ├── geojson.js           GeoJSON line extraction, lon/lat → UTM projection, survey simulator — no DOM
│   ├── fidelity.js          compares the result with the input line (both directions) — no DOM
│   └── app.js                CSV import, parameters, canvas rendering, tables, export buttons
├── tests/
│   ├── algorithm.test.js    unit tests (Node's built-in test runner, no dependency)
│   ├── geojson.test.js      GeoJSON import tests
│   └── fidelity.test.js     fidelity-check tests
├── eval/
│   └── evaluate.js          accuracy evaluation on synthetic routes with known ground truth
├── docs/
│   ├── EVALUATION.md        generated results (npm run eval)
│   └── screenshot*.png
├── sample-data/
│   ├── sample_8in_pipe.csv   synthetic as-built route, narrow pipe
│   └── sample_36in_pipe.csv  same route, wide pipe — fewer surviving vertices
├── package.json
├── LICENSE
└── README.md
```

`algorithm.js` has no dependency on the DOM or any UI library — you can
import it into a Node script, a test file, or a different front end without
changes.

## Running the tests

```bash
npm test
```

37 tests covering bearing/deflection math, RDP, PCA line fit, point
conservation (no raw shot is ever duplicated or lost across the whole
pipeline), pipe-width sensitivity, stationing, elevation fit, circle fit,
arc detection (it never fires on a route of isolated sharp corners, and on a
true 400 ft-radius sweep it returns line + arc + line with the radius within
5%), feet/metre conversion, both export formats, and the GeoJSON import
(UTM projection checked against pyproj to under 1 mm, line extraction, and
the deterministic survey simulator), and the fidelity check below.

## Accuracy

`npm run eval` runs the pipeline on synthetic routes with known ground truth
across noise levels, pipe widths, injected gross outliers and a curved route,
and writes the results to [`docs/EVALUATION.md`](docs/EVALUATION.md). It is
synthetic-data only (see the caveats in that file), but it is a measured
comparison rather than a claim. One finding worth knowing about: a correct
vertex *count* does not guarantee correct geometry — see the
"Which bends get missed?" table.

## Fidelity check

Under the result numbers the app shows a **GOOD FIT / CHECK / POOR FIT** badge
answering one question: does the reconstructed line actually follow the line it
was built from? It measures the distance between the two lines in **both
directions** (a result that cuts corners *and* one that invents corners are
both caught), sampled along the lines every ~10 ft rather than only at
vertices, and shows mean distance, max distance, the share of the line more
than 25 ft off, the length difference, and the average spacing of the input.

- **What it compares against.** For a GeoJSON line, the original clean line
  (so with simulated shots it reports the real recovery error on synthetic
  noise). For CSV and the samples, the input shots joined in order.
- **Why it exists.** The method needs shots every ~20–40 ft. Fed a sparse line
  (one point every few hundred feet) it mistakes real corners for noise and
  produces a confident-looking but wrong result — e.g. one BCER line with 33
  vertices came back 7.5% short with the line up to 1,057 ft off. That now
  shows as **POOR FIT** with the numbers.
- **The thresholds are heuristics**, set by running the check over the sample
  routes and dense BCER lines (all within 2% of the line off-tolerance and 1.1%
  length difference) and over known-bad inputs (60–97% off-tolerance). CHECK
  starts at 3% off-tolerance or 2% length difference; POOR at 10% or 5%. The
  raw numbers are always shown so you can judge for yourself.
- **Not ground truth for real data.** For real survey input it measures
  fidelity to what you gave it, not accuracy against the real pipe.

## Running it locally

Because `app.js` is loaded as an ES module, opening `index.html` directly via
`file://` will hit CORS restrictions in most browsers. Serve it instead:

```bash
# any static server works, e.g.:
python3 -m http.server 8000
# or
npx serve .
```

Then open `http://localhost:8000`.

## CSV format

Any CSV with X and Y columns works — the app auto-guesses common header
names (`X`/`Easting`, `Y`/`Northing`, `Z`/`Elevation`, `Point #`,
`Description`) and lets you remap them if it guesses wrong. Choose the units
of your X/Y coordinates (**US feet** or **meters**) in the *Survey units*
control; the pipe-width slider stays in inches and is converted for you. The
chosen unit labels the results and is written into the LandXML export.

Two ready-made CSVs are in `sample-data/` if you want to test without your
own data, or just click a sample route in the app itself (the two corner
routes, or the **Curved route** that shows arc detection). Samples are
generated in feet.

## GeoJSON import

You can also drop a **GeoJSON** file of pipeline lines (for example a download from a government open-data portal). The app finds every `LineString` / `MultiLineString` feature, lets you pick one from a searchable list, and projects its longitude/latitude to UTM (`js/geojson.js`) in your chosen unit (feet or metres).

GeoJSON holds the clean *centreline*, not noisy survey shots, so by default the app simulates a survey: one shot every 20-40 ft, each pushed up to half the pipe width off the line. Untick **Simulate survey shots** to feed the raw GeoJSON vertices in directly.

## Parameters

| Control | What it does |
|---|---|
| **Pipe width** | Sets the RDP tolerance (half the width). Wider pipe → more forgiving. |
| **Major bend threshold** | Deflection at or above this angle is kept as a real corner. |
| **Min. points per segment** | A segment built from fewer shots than this doesn't get to "vote" on a bend — it's folded into whichever neighbor is the smaller deflection away. |
| **Detect long-radius curves** | Optional. Groups consecutive moderate bends into a fitted arc instead of sharp corners — see "Curve detection" above. |
| **Auto-tune parameters** | Grid-searches min-points × bend-threshold combinations and applies whichever gives the lowest average per-segment residual (with a mild penalty for an unreasonably low or high vertex count), instead of you hand-tuning sliders. |

## Other features

- **Manual vertex nudge** — drag any white vertex handle on the plan view to
  move it slightly. This edits the output directly (recomputes stationing,
  bearings, and the table) without re-running the fit — for the rare case
  the algorithm is a hair off and you want to true it up by eye. Pressing
  **Reconstruct** again discards any nudge.
- **Export** — vertices as CSV, or the full centerline (lines + any detected
  arcs) as **DXF** (AutoCAD/Civil3D) or **LandXML**.
- **Print / Save PDF** — a dedicated print stylesheet lays out the plan view,
  elevation profile, and both tables as a clean report; use the browser's
  "Save as PDF" destination in the print dialog.

## Limitations

- **Short runs between bends can be absorbed.** In the evaluation, ~10% of
  trials lost the corner at each end of the route's shortest (260 ft) run at
  default settings, even though the vertex count was still right. Check the
  geometry, not just the vertex count, on routes with short runs between
  bends.
- **Arc detection is a heuristic.** The tangent trim uses a length rule
  (an end run more than 2× the median chord is treated as a tangent). On the
  curved demo with noise of ±1 ft, about 84% of trials gave the ideal
  line + arc + line, and the worst fitted radius was 20% off.
- Single route, 2D plan geometry (elevation is fitted per segment but does not
  affect bend detection), no loops or branches.
- Validated on synthetic data only; no field data has been run through it.

## Deployment

The app is fully static, so GitHub Pages hosts it for free: repo **Settings → Pages → Deploy from branch → `main` → `/ (root)`**. It goes live at `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Background

Originally solved in LISP inside AutoCAD/Civil3D for as-built survey
reduction on a large engineering firm's pipeline projects; this is a from-
scratch JavaScript/browser reimplementation of the same algorithm for a
university mini project.

## License

MIT — see [LICENSE](LICENSE).
