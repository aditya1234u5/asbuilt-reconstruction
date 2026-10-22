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
   long-radius sweeps rather than mitered elbows. This is a post-process over
   whatever vertices the main pipeline already produced — if a high
   "min points per segment" setting already merged part of a curve into an
   adjacent straight run, the detected arc can bleed slightly into it.
   Lowering that setting before reconstructing preserves more bend
   resolution for a tighter fit. Off by default; enable with the "Detect
   long-radius curves" checkbox.

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
│   └── app.js                CSV import, parameters, canvas rendering, tables, export buttons
├── tests/
│   └── algorithm.test.js    unit tests (Node's built-in test runner, no dependency)
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

14 tests covering bearing/deflection math, RDP, PCA line fit, point
conservation (no raw shot is ever duplicated or lost across the whole
pipeline), pipe-width sensitivity, stationing, elevation fit, circle fit,
arc-detection (including that it never fires on a route of isolated sharp
corners), and both export formats.

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
`Description`) and lets you remap them if it guesses wrong. Coordinates are
assumed to be in **feet** (the pipe-width slider, in inches, is converted to
feet internally) — adjust `js/app.js`'s `widthFt` conversion if your survey
uses a different unit.

Two ready-made CSVs are in `sample-data/` if you want to test without your
own data, or just click **Sample route** in the app itself.

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

## Deployment

The app is fully static, so GitHub Pages hosts it for free: repo **Settings → Pages → Deploy from branch → `main` → `/ (root)`**. It goes live at `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Background

Originally solved in LISP inside AutoCAD/Civil3D for as-built survey
reduction on a large engineering firm's pipeline projects; this is a from-
scratch JavaScript/browser reimplementation of the same algorithm for a
university mini project.

## License

MIT — see [LICENSE](LICENSE).
