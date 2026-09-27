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
- Known PSA grade if the card is already slabbed.

## Scanning session

Same setup every time:

- **Mat:** the same matte, non-white, non-glossy mat (the pink paper works). The
  card must contrast with it on all four edges.
- **Lighting:** same room, same lamps, diffuse, no direct glare on the card.
  Note anything that changed.
- **Phone:** same phone, held level (green bubble), card flat and taped, the
  whole card inside the neon frame with background showing on every side.

Per card:

1. On the phone, enter the deck ID (`TD-07`) before Capture.
2. One **Capture**, front only.
3. When the tilt banner appears, tap **Submit without tilt frames**.
4. Do not retake, even for a bad result — the bad result is the data. Retake
   only after "Card not found — retake", and note it.
5. The deck field advances to the next ID after a successful upload.

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

## PSA ground truth

Every card sent to PSA (deck or not) becomes a labeled example:

1. Turn on **Pre-submission** on the phone before its Capture (or tick it on
   `/deck` afterwards).
2. When the grade comes back, enter the PSA grade (and cert number) on `/deck`
   for that scan.

`deck_report.js` lists every returned grade next to the engine's prediction.
