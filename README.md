# The Judge — Pre-Submission Diagnostic

Node/Express host plus a responsive web client that runs **The Judge** 4-phase
grading formula (ported from `The Judge.swift`) before a card is submitted to
a physical lab.

## What changed in this pass

1. **`services/grading_engine.js`** is now the isolated scoring module.
   Image metrology (centering contrast scans, surface residuals, edge
   whitening, corner fray) feeds **the same numbers** as
   `TheJudge.evaluateMultiPhaseCondition`:
   - Phase 1 centering from max(L/R, T/B) deviation
   - Phase 2 surface penalties (scratches × 0.5, dimples × 1.0, crease kill-switch)
   - Phase 3 edges from whitening count
   - Phase 4 corners from the **worst** of four 0–5 fray readings
   - **0.5-point condition ceiling:** `final = min(average, lowestSubGrade + 0.5)`,
     then round to the 0.5 lab step and clamp to [1.0, 10.0]
2. **`server.js`** no longer mocks grades. `POST /api/grade` and
   `POST /api/grade/upload` both call `grading.gradeBuffer`.
3. **`public/index.html` + `public/app.js`** add a live-camera canvas
   overlay: neon 2.5×3.5 window, L-brackets, 50/50 crosshair, inner 60/40
   PSA guide. Capture stills go through the same `/api/grade` pipeline.

Scoring math lives **only** in `grading_engine.js`. Do not re-weight it in
the server or the UI (BusinessPlan.md §4 Module D).

## Run locally

```bash
npm install
npm start          # http://localhost:5000
npm run test:judge # formula regression (no image I/O)
```

Uploads land in `./uploads`. Swap that for object storage before production.

## Grade API

`POST /api/grade`  (multipart)

| field    | required | notes |
|----------|----------|--------|
| `image`  | yes      | still of the card |
| `name`   | no       | display name |
| `cardType` | no     | reserved for sports vs TCG corner templates |
| `debug`  | no       | `"true"` attaches metrology dumps |

Response: `{ ok: true, item }` where `item.gradingReport` includes:

```
finalScore              1.0–10.0 (0.5 steps) — The Judge scale
label                   Gem Mint / Mint / Near Mint / …
subGradesLabel          "CEN: 9.5 | SUR: 9.0 | EDG: 10.0 | CRN: 9.5"
conditionCeilingApplied true when average was capped by lowest+0.5
primaryFlawDescription  same sentence order as The Judge.swift
centering, corners, edges, surface, weighted   0–100 projections (×10)
```

`POST /api/grade/upload` is the disk-backed twin of the same pipeline.

## Alignment viewport

Scan view clones `#scanViewportTemplate` (in `index.html`). `app.js`
draws the overlay every animation frame:

- Dark mask outside a 2.5" × 3.5" window
- White outer stroke + cyan inner stroke (readable on holofoil and black borders)
- Corner L-brackets
- Dashed 50/50 crosshair
- Inner dashed ~60/40 PSA window (10% inset)

The overlay is **not** burned into the captured JPEG. Only the video
frame is posted to `/api/grade`.

## Formula quick-reference (The Judge.swift)

```
centering:  ≤2 → 10, ≤4 → 9.5, ≤9 → 9.0, ≤14 → 8.0, ≤20 → 7.0, else 5.0
surface:    start 10; −0.5 per scratch (1 scratch is −0.5);
            −1.0 per dimple; crease/wrinkle≥2 → −max(2, severity)×1.5; floor 1.0
edges:      0 → 10, 1 → 9, 2–3 → 8, else 5
corners:    max fray 0 → 10, 1 → 9, 2 → 8, 3 → 6.5, else 4
ceiling:    min(mean(four), min(four) + 0.5) → round to 0.5 → clamp [1, 10]
```
