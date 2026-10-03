# Scan data repo

Real scans stay out of the app repo. A private GitHub repo holds the uploads, the saved grades, and the debug overlays. After each scanning session on the iMac, one script copies the new files and pushes them.

## One-time setup

On the iMac, with the [GitHub CLI](https://cli.github.com/) logged in as the account that owns `Card-Collector-App`:

```bash
gh repo create Snoboy34/the-judge-scans --private --description "The Judge scan uploads and saved grades"
gh repo clone Snoboy34/the-judge-scans "$HOME/the-judge-scans"
```

Without `gh`, create an empty private repo named `the-judge-scans` at https://github.com/new, then:

```bash
mkdir -p "$HOME/the-judge-scans"
cd "$HOME/the-judge-scans"
git init -b main
git remote add origin git@github.com:Snoboy34/the-judge-scans.git
```

The app checkout does not need to move. The script reads `data/`, `uploads/`, and `scans/` next to itself, which is the directory `npm start` writes.

## After each scanning session

From the app checkout:

```bash
bash scripts/push_scan_data.sh
```

That copies:

- `data/database.json`, `failed_scans.jsonl`, `scan_labels.json`, `test_deck.json`
- every file in `uploads/`
- `scans/<scanId>/overlay.jpg`, `oriented.jpg`, and `debug.json`

and commits them on `main` of `the-judge-scans`. Run it again and it pushes only what changed.

If the app's data lives somewhere else:

```bash
JUDGE_DATA_DIR="$HOME/judge/data" \
JUDGE_UPLOADS_DIR="$HOME/judge/uploads" \
JUDGE_SCANS_DIR="$HOME/judge/scans" \
JUDGE_SCAN_REPO="$HOME/the-judge-scans" \
  bash scripts/push_scan_data.sh
```

## Running the gate against the deck

Clone the private repo wherever the gate should read it, then point the gate at that checkout:

```bash
gh repo clone Snoboy34/the-judge-scans /tmp/judge-scans
JUDGE_DATA_DIR=/tmp/judge-scans/data \
JUDGE_UPLOADS_DIR=/tmp/judge-scans/uploads \
  npm run gate
```

`npm run gate` then re-grades the saved uploads (`compare_finders`), scores the deck registry (`deck_report`), and checks TD-01 through TD-06 against `fixtures/td_expectations.json` (`td_deck`).

Those six expectations come from the 2026-10-03 phone photos, in the order they were sent, plus the session notes (colored back must measure, thin front is off-center, borderless and the chrome front stay undetectable). If an ID is on the wrong card, fix the title on `/deck`. The expect column in the fixtures file is what `td_deck` checks.

With no scan checkout, `td_deck` prints SKIP and the gate still passes. `--require-data` fails when the six cards are missing.
