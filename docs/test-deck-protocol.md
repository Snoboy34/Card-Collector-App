# Test deck protocol

The test deck is a fixed set of ~40–50 cards that never changes. Every engine
change is measured against it before release, alongside `compare_finders.js`.

## The deck

IDs are `TD-01` … `TD-50` (two or three digits). Suggested mix:

| Category (`/deck` value) | Cards | What the engine must do today |
|---|---|---|
| `white-vintage` (1950s–70s) | 5 | measure centering |
| `white-80s-90s` | 5 | measure centering |
| `white-modern` | 4 | measure centering |
| `colored-border` (black, blue, team colors) | 5 | measure centering |
| `borderless` / full-bleed | 4 | come back **undetectable** |
| `chrome-foil` (chrome, refractor, foil) | 4 | measure centering |
| `die-cut` / odd shape | 2 | come back **undetectable** |
| `tcg-pokemon` | 4 | measure centering |
| `tcg-magic` | 3 | measure centering |
| `off-center` (visibly) | 4 | measure, worst axis worse than 60/40 |
| `worn` (corners, edges, creases) | 5 | measure centering (defect rebuild later) |

A card's expectation can be overridden on `/deck` (`expect`).

## One-time registry setup

On `/deck` (iMac browser or phone on the same network), for each card:

- ID, category, title (e.g. "1991 Upper Deck Eric Karros").
- Ruler or caliper border widths in mm (front: left, right, top, bottom),
  measured at mid-edge. Calipers beat a ruler: ±0.25 mm on a 3 mm border is
  ±2 centering points.
- Known grade if the card is already slabbed. Company, overall grade, and cert.
  Leave the number blank for Authentic, Altered, or No Grade. Sub-grades,
  special labels, qualifiers, a TAG score, and an autograph grade are optional.

## Scanning session

Same setup every time:

- **Lab baseline:** pink paper, recorded as `capture.background` = `pink`.
  Pink is the lab baseline only. It is not the instruction for a real scan.
- **Surface field:** `capture.background` is `pink`, `white`, `dark-matte`,
  `wood`, `pattern`, `glossy`, or `other`. Empty is `unspecified` and is not
  a baseline. The grade does not read this field.

The phone shows this guidance:

1. Use a plain, matte, colored surface that contrasts with the card's border, and leave background showing on all four sides.
2. Do not use white paper under a white border. A white border needs a colored surface.
3. Do not use a black surface under a dark border. A dark border needs a lighter colored surface.
4. Do not use a pattern or a glossy surface. Patterns and glare look like extra edges.
- **Lighting:** same room, same lamps, diffuse, no direct glare on the card.
  Note anything that changed.
- **Phone:** same phone, held level (green bubble), card flat and taped, the
  whole card inside the neon frame with background showing on every side.

Per card:

1. On the phone, enter the deck ID (`TD-07`) before Capture.
2. **Capture** the front. When the tilt banner appears, tap **Submit without tilt frames**.
3. Turn the card over left to right. Keep the same edge at the top of the frame.
   Leave background showing on all four sides. **Capture back**, or tap **Skip back**.
4. Do not retake, even for a bad result — the bad result is the data. Retake
   only after "Card not found — retake", and note it.
5. The deck field advances after the back upload or the skip, not after the front.

The report's pass/fail is the latest front. A back is measured (borders, low-confidence
edges) and its centering sub-grade stays blank. A copyright line in the bottom half
of the back text stores the year and records that image-left is the front's right.
A copyright line in the top half flags the back upside down and does not apply that
map. No copyright line leaves the map unapplied and the year blank.

Missed the ID on the phone? Assign it afterwards on `/deck` (recent scans table).

## After an engine change (release gate)

On the iMac, with the candidate checked out in a worktree (see README):

```bash
node /tmp/judge-next/scripts/deck_report.js --data "$PWD/data" --uploads "$PWD/uploads" --candidate /tmp/judge-next
node /tmp/judge-next/scripts/compare_finders.js --current "$PWD" --candidate /tmp/judge-next --n 50
```

Ship only if:

- no category's pass rate drops,
- `borderless` and `die-cut` stay undetectable (no fabricated centering),
- every `off-center` card is still caught,
- ruler deltas do not get worse on average,
- repeat scans of the same card spread < 3 points on each axis.

## Grading-company ground truth

Every card sent to a grading company (deck or not) becomes a labeled example.
Companies stay in their own lists. A PSA 8 and a BGS 9.5 are never averaged.

1. Turn on **Pre-sub** before Capture (or tick it on `/deck` afterwards).
2. Set the **intended grader** on the phone, next to Pre-sub: PSA, BGS, SGC,
   CGC, TAG, or Other. Capture sends `intendedGrader`. Leave the picker unset
   and the scan has no company; you can still set it on `/deck`.
3. When the slab comes back, enter that company's result on `/deck` for that
   scan:
   - **Overall** grade, half points (8, 9.5, 10).
   - **Special label**, when the company printed one: BGS Pristine, BGS Black
     Label, SGC Pristine 10, CGC Pristine, CGC Perfect 10.
   - **No-number result**: Authentic, Altered, or No Grade. Leave Overall
     blank. The report still lists the scan.
   - **Sub-grades** (optional): centering, corners, edges, surface, as BGS or
     CGC printed them.
   - **TAG score**: type it exactly as printed. It is not converted to a number.
   - **Qualifiers**: PSA's OC, ST, PD, OF, MC, MK. OC is shown against the
     Judge centering prediction (worst-axis share past 60/40).
   - **Autograph** grade when it is separate (BGS dual grade, PSA/DNA).
   - **Cert** number.

`deck_report.js` prints one section per company. Each returned grade, including
a slab with no number, sits next to that scan's Judge prediction.
