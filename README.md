# Collision Telemetry Exhibit — MyGeotab Add-In

Turns a GO device's own records into the GPSFMS branded **Collision Telemetry Exhibit** (the PDF series built for PGS and Arvig claims) without leaving MyGeotab. Pick the vehicle and event time, and the add-in pulls the telemetry over the API, runs the analysis sequence from the workflow handoff, plots the event on a real satellite map, and produces a print-ready exhibit with editable narrative.

Status: **v0.1.0 — validated against the 20-V73 F350 (Arvig, 2026-09-30) case; not yet run against a live database.** See "Verify on first live run" below.

## What it replaces from the manual workflow

| Manual step | Add-in |
|---|---|
| Run Advanced Log Data & Collisions report, export xlsx, parse with pandas | `LogRecord`, `StatusData`, `FaultData`, `DebugData`, `Trip`, `DriverChange`, `ExceptionEvent` pulled directly for the device/window (xlsx import kept as a fallback) |
| Read timezone from report header | User's MyGeotab `timeZoneId`; selectable per case |
| Trips History screenshot + georeferencing (trail ICP / POI least-squares) | Leaflet map on Esri World Imagery; markers at true coordinates. No alignment error to disclose |
| Interpolating event positions, decel, pulse characterization, recon check, timeline | `analysis.js` (pure JS, same code runs in Node for regression tests) |
| Hand-written exhibit PDF | `exhibit.js` builds the print document; Chrome "Save as PDF" |
| Judgment prose | Templated defaults for every section, editable before export; "Save case (.json)" hands the full computed package to an analyst for a deep-dive write-up |

## Files

| File | Purpose |
|---|---|
| `config.json` | Dev manifest (relative file paths; use with a local server or MyGeotab's file upload) |
| `config.hosted.json` | Production manifest pointing at the jsDelivr-hosted standalone page |
| `config.packed.json` | Built: upload-and-go manifest with all files base64-inlined |
| `collisionExhibit.html` / `styles.css` | UI shell |
| `collisionExhibit.js` | Add-in glue: API fetch + normalization, xlsx import, map, charts, editable tables, export |
| `analysis.js` | Analysis engine (no DOM/API). `CollisionAnalysis.analyze(bundle, inputs, options)` |
| `camera.js` | media-services.geotab.com client (pairing lookup, existing requests, exception media, clip request + polling) |
| `exhibit.template.js` → `exhibit.js` | Exhibit document builder; build step inlines the logo |
| `collisionExhibit.standalone.html` | Built: single-file page for jsDelivr hosting |
| `tools/build.py` | Produces `exhibit.js`, the standalone page, and `config.packed.json` |
| `tools/xlsx_to_records.py` | Converts an Advanced Log export into the engine's bundle format (fixtures / offline) |
| `test/validate_20v73.mjs` | Node regression: 47 checks against the numbers in the delivered 20-V73 exhibit |
| `test/run_browser_test.py` | Headless Chromium end-to-end: mock API → UI → exhibit PDF (`test/out/`) |
| `test/fixture_20v73_f350.json` | Normalized 20-V73 case data |

## Install

**Local dev**

```bash
python3 tools/build.py
python3 -m http.server 8080
```
Then System Settings → Add-Ins → New Add-In with `config.json`, URL `http://localhost:8080/collisionExhibit.html`. The menu item lands under **Activity**. (https MyGeotab → http localhost may be blocked as mixed content; use `mkcert` or host on GitHub.)

**Hosted (same pattern as the other GPSFMS add-ins)** — push this folder to `github.com/Austin-GPSFMS/collision-exhibit-addin` and use `config.hosted.json` (jsDelivr URL `…@main/collisionExhibit.standalone.html`). Rebuild the standalone page after every change.

**Packed** — upload `config.packed.json`; no external hosting needed. Leaflet, Chart.js and SheetJS still load from cdnjs.

## Workflow

1. **Case** — vehicle, event date/time (local), time zone, window (default 60 min before / 120 after), client. *Load telemetry.* Status chips show what came back: forensic 1 Hz buffer found or not, collision fault, pulse composition, accelerometer unit detected.
2. **Case details** — vehicle description, driver (prefilled from the trip's Geotab Drive pairing), location label (prefilled by reverse geocode), conditions, claim narrative, impact configuration from scene evidence. Expand the Collision Reconstruction panel when a recon was generated and type the printed values (trigger time, ft/s² per axis, speed, accuracy margins, side depicted; optional screenshot of its point-of-impact graphic). Add scene photos; for Timemark-stamped photos enter the GPS stamp so they plot as independent anchors.
3. **Analysis** — key facts, satellite map (pan/zoom to frame the figure; the exhibit captures the current view), pulse and speed charts, editable timeline and summary tables, editable narrative blocks. Every edit survives re-analysis; "Reset to computed" restores the templated text.
4. **Camera footage (Geotab-native cameras)** — on load the add-in asks media-services for a camera paired to the GO serial (`/DeviceMappings/serialNumber/{serial}`). If one exists it lists existing footage requests in −30/+60 min of the pulse (`/Video/Requests`), shows exception events near the pulse with *Get media* / *Request ±10 s* (`/Media/Exception/{id}`), and *Request clip from camera* queues a custom clip around the pulse (`POST /Media`, then `/Media/{id}` polled every 10 s until `ResponseReady`, then `/Media/{id}/Resources`). Ready clips play inline with **Download** (fetch → blob; falls back to opening the storage URL if it lacks CORS) and **Open**. VisionTrack cameras are deliberately out of scope here — use the VisionTrack add-in's Collision Center. Footage is review material in the add-in; nothing camera-related is placed in the exhibit automatically.
5. **Export** — *Open exhibit* opens the print document in a new tab (pop-ups must be allowed for the MyGeotab domain) → Print → Save as PDF. Also: case `.json` (telemetry + inputs + edits + analysis — reopen later or hand off), forensic buffer `.csv`, exhibit `.html`.

## How the analysis works (summary)

- **Event time** — stated by the user; otherwise the `DiagnosticAccidentLevelAccelerationEventId` fault; otherwise the largest accelerometer excursion.
- **Forensic buffer** — the API's `LogRecord` has no log reason, so the 1 Hz accident buffer is detected by cadence (run of ≥8 fixes at 0.5–2.5 s spacing nearest the event). Near-duplicate timestamps (curve + buffer record for the same fix) are collapsed for cadence but kept in the appendix.
- **Pulse** — samples with deviation ≥ threshold (default 0.5 g; vertical measured from the median baseline) clustered at ≤0.5 s gaps; the pulse core is the part at ≥50 % of the peak deviation (reported duration), the full above-threshold span is kept as the excursion window. Composition classified from per-axis peak ratios (longitudinal / lateral / lateral+vertical / longitudinal-lateral / tri-axial / mixed) with the handoff's interpretation text.
- **Approach** — speed peak in the prior 60 s, braking onset = first fix below peak−1 mph, two-segment piecewise-linear fit of speed vs time (reported only when it beats one segment by >40 % SSE and slopes differ by >0.8 mph/s), per-crumb decel for hard-braking flags (≥0.35 g), lateral excursion ≥0.3 g before the pulse flagged as possible evasive input.
- **Post-event** — rest = first sustained ≤0.6 mph fix; roll-out = path length from the interpolated pulse position through the crumbs to rest; movement intervals after rest from GPS or engine road speed (repositioning <150 ft vs relocation); ignition off from `DiagnosticIgnitionId` (else trip stop); movement after ignition off (tow).
- **Faults** — classified pre-event / at-impact (±5 s) / post-event and by category (collision, power, TPMS, network, emissions).
- **Recon check** — printed ft/s² ÷ 32.174 → g; compared with the sample at the trigger timestamp and the raw per-axis peaks; lag = trigger − peak; `missedPeak` when a stated axis value is <60 % of the raw peak on that axis. Drives the discrepancy section and the shaded band on the pulse chart.
- **Timezone** — all API times are UTC; rendering uses `Intl.DateTimeFormat` with the selected IANA zone.

## Verify on first live run

These are the assumptions that could not be checked without a live database. Each has a guard, but confirm them on the first real case:

1. **Accelerometer units.** The API is expected to return the three acceleration diagnostics in m/s². The normalizer reads the diagnostic's `unitOfMeasure` and, failing that, checks whether the vertical axis sits near 9.8 or near 1.0, then converts to g. The status chip reports which path was taken ("accel m/s² (converted to g)" or "accel g"). If the chip disagrees with the numbers, the division is wrong.
2. **Buffer detection by cadence.** Confirm the detected buffer bounds match the report's `Accident`-reason records on a case where you also have the xlsx (import the xlsx with the same case and compare chips).
3. **`DebugData` permission.** Fetched best-effort; if the account cannot read it the post-event timeline just lacks the debug reasons.
4. **Pop-ups.** The exhibit opens with `window.open`; MyGeotab's domain needs pop-ups allowed, otherwise use *Exhibit (.html)* and open the download.
5. **Satellite tiles.** Esri World Imagery is used with attribution and `crossOrigin` so the view can be captured to the exhibit. If a client's browser policy blocks arcgisonline, switch to the Streets layer or use the *Map image override* (Trips History screenshot) — the exhibit then carries the screenshot without markers, as before.
6. **Device description.** `Device` carries VIN but not year/make/model; the vehicle description is a free-text field.
7. **media-services from the browser.** Auth is the four `X-MyGeotab-*` headers from `api.getSession` (`path` falls back to `location.host`). The add-in runs on the MyGeotab origin like the built-in Cameras view, so same-site calls are expected to pass CORS; from a localhost dev host they may not. Response shapes for `/Video/Requests`, `/Media/{id}/Resources` and `/Video/Resources/{id}` were taken from the OpenAPI summary and handled defensively (array vs `{items|data|results}`, `mediaUrl|url|uri`). The "media-services call log" panel keeps the raw JSON of the last 12 calls — check it on the first live camera case and tighten `normalizeItem()` in `camera.js` if a field is named differently. Roles needed on the user: `ListAssets`, `ViewRecordedVideo`.

## Known differences from the hand-built 20-V73 exhibit

- Roll-out distance computes to ~48 ft (path) / 46 ft (straight-line) from the 5-decimal export coordinates; the delivered exhibit said ~70 ft. Full-precision API coordinates will give a more defensible figure either way — recheck on the live run.
- Phase slopes come out 1.1 / 3.2 mph/s versus the exhibit's ~1.2 / ~3.5 (fit over the whole phase vs eyeballed segments). The breakpoint (08:22:05) and braking onset (08:21:57) match exactly.
- Everything else the exhibit states — buffer bounds, peak values and timestamps to the millisecond, pulse duration, composition, rest time, repositioning, ignition-off, 21 minutes running, TPMS fault, recon lag 0.9 s, 19 mi trip — is reproduced by `test/validate_20v73.mjs`.

## Tests

```bash
node test/validate_20v73.mjs                     # engine vs. delivered exhibit numbers
python3 test/run_browser_test.py --xlsx <export> # headless E2E (needs playwright; vendored libs in test/vendor)
```
The browser test serves Leaflet/Chart.js/SheetJS from `test/vendor` and a placeholder tile, so it runs without internet.
