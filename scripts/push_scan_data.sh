#!/bin/bash
# Push this scanning session to the private scan-data repo.
#
# Run on the iMac, from anywhere:
#   bash scripts/push_scan_data.sh
#
# One-time setup (replace nothing if your GitHub login is Snoboy34):
#   gh repo create Snoboy34/the-judge-scans --private --description "The Judge scan uploads and saved grades"
#   gh repo clone Snoboy34/the-judge-scans "$HOME/the-judge-scans"
#
# Without gh:
#   mkdir -p "$HOME/the-judge-scans"
#   cd "$HOME/the-judge-scans"
#   git init -b main
#   git remote add origin git@github.com:Snoboy34/the-judge-scans.git
#   # Create the empty private repo at https://github.com/new first.
#
# Override locations if the app is not this checkout:
#   JUDGE_DATA_DIR=... JUDGE_UPLOADS_DIR=... JUDGE_SCANS_DIR=... JUDGE_SCAN_REPO=... bash scripts/push_scan_data.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${JUDGE_DATA_DIR:-$ROOT/data}"
UPLOADS_DIR="${JUDGE_UPLOADS_DIR:-$ROOT/uploads}"
SCANS_DIR="${JUDGE_SCANS_DIR:-$ROOT/scans}"
REPO="${JUDGE_SCAN_REPO:-$HOME/the-judge-scans}"

if [[ ! -d "$REPO/.git" ]]; then
  echo "Scan-data repo not found at: $REPO" >&2
  echo "Create it once, then re-run this script:" >&2
  echo "  gh repo create Snoboy34/the-judge-scans --private --description \"The Judge scan uploads and saved grades\"" >&2
  echo "  gh repo clone Snoboy34/the-judge-scans \"$HOME/the-judge-scans\"" >&2
  exit 1
fi

mkdir -p "$REPO/data" "$REPO/uploads" "$REPO/scans"

copy_if() {
  local src="$1" dest="$2"
  if [[ -f "$src" ]]; then
    cp -p "$src" "$dest"
  fi
}

copy_if "$DATA_DIR/database.json" "$REPO/data/database.json"
copy_if "$DATA_DIR/failed_scans.jsonl" "$REPO/data/failed_scans.jsonl"
copy_if "$DATA_DIR/scan_labels.json" "$REPO/data/scan_labels.json"
copy_if "$DATA_DIR/test_deck.json" "$REPO/data/test_deck.json"

if [[ -d "$UPLOADS_DIR" ]]; then
  rsync -a "$UPLOADS_DIR/" "$REPO/uploads/"
fi

if [[ -d "$SCANS_DIR" ]]; then
  rsync -a \
    --include='*/' \
    --include='overlay.jpg' \
    --include='oriented.jpg' \
    --include='debug.json' \
    --exclude='*' \
    "$SCANS_DIR/" "$REPO/scans/"
fi

if [[ ! -f "$REPO/.gitignore" ]]; then
  printf '.DS_Store\n' > "$REPO/.gitignore"
fi

if [[ ! -f "$REPO/README.md" ]]; then
  cat > "$REPO/README.md" << 'EOF'
# The Judge scan data

Private uploads and the grades saved with them. This is not the app.

Layout:

- `data/database.json` — graded scans
- `data/failed_scans.jsonl` — card-not-found scans
- `data/scan_labels.json` — deck id, side, pair, returned grade
- `data/test_deck.json` — deck card registry
- `uploads/` — the stills
- `scans/<scanId>/overlay.jpg` — photo with quad, sample lines, chosen border
- `scans/<scanId>/oriented.jpg` — warped card with the same lines
- `scans/<scanId>/debug.json` — the numbers behind the overlay

Pushed from the iMac with `scripts/push_scan_data.sh` in the app repo.
EOF
fi

node -e '
const fs = require("fs");
const path = process.argv[1];
let doc = {};
try { doc = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) {}
doc.kind = "judge-scan-data";
doc.layout = "data + uploads + scans/<id>/{overlay,oriented,debug}";
fs.writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
' "$REPO/data/scan_repo.json"

cd "$REPO"
git add -A
if git diff --cached --quiet; then
  echo "Nothing new to push."
  exit 0
fi
stamp="$(date -u +%Y-%m-%dT%H:%MZ)"
git commit -m "Scan session $stamp"
git push
echo "Pushed scan data to $(git remote get-url origin) ($stamp)."
