# Donna Daily — static website

Built output: `public/` (index.html, editions/*.html, editions/index.html, data.json). Fully self-contained: inline CSS/JS, no external scripts, fonts, trackers or images. Readable without JS; JS adds search, region/topic filters, chip filtering and shareable `?region=&topic=&q=` URLs.

## Layout
- `data/editions/*.json` — one file per edition (never edit old ones; they are the archive).
  - `kind:"edition"`: `{id, kind, title, date:"YYYY-MM-DD", leadId, notes:[], stories:[{id, region: us|ca|hk|cn|world, topic: politics|business|culture|sports|human, ts:"YYYY-MM-DDTHH:MM", dateLabel, headline, summary, why, label:"Fact"|"Allegation"|"Fact + opinion"|"Reported (unnamed sources)"|"Fact (state media)"…, note?, sources:[{title, site, date?, href:"https://…"}]}]}`
  - `kind:"archive"`: older Grok Page briefs converted by `tools/convert-archive.mjs` (personal travel section removed from the public copy).
- `data/state.json` — last successful build time (America/New_York), written only after a successful build.
- `tools/build.mjs` — validates (max 5 per region, https sources, required fields), builds into a temp dir, swaps into `public/`.
- `tools/linkcheck.mjs` — checks current edition's source links (403/406 = bot-blocked → WARN; 404/410 → FAIL).
- `tools/test.mjs` — Playwright + Google Chrome at 360/390/430/1280: no horizontal overflow, 17px text, ≥44px targets, filters/search/chips, no-JS reading; screenshots to `screenshots/`.
- `tools/update.sh` — the routine's one-command update: linkcheck → build → test (restore previous on failure) → optional `DEPLOY_CMD`.

The newest `kind:"edition"` file (by id, e.g. `2026-11-02-am` > `2026-11-01-ed1`) becomes the front page; all others are listed under Past editions.

## Path note (this repo)

The published site is the **repository root** (what used to be `public/`: `index.html`, `editions/`, `data.json`, `.nojekyll`). Build inputs live under `_build/` and the scripts were not rewritten.

`tools/build.mjs`, `tools/test.mjs`, and `tools/linkcheck.mjs` set `ROOT` to the parent of `tools/` (here, `_build/`). `tools/update.sh` does `cd` to that same directory, then calls `node tools/...` and copies `public/`.

- `linkcheck.mjs` reads `_build/data/editions` — that path still matches.
- `build.mjs` writes `_build/public/` (and `_build/.public-tmp`), **not** the repository root that GitHub Pages serves.
- `update.sh` snapshots and restores `_build/public`, and records state in `_build/data/state.json`.
- `test.mjs` defaults to `file://` + `_build/public/`.

A successful rebuild therefore lands in `_build/public/`. To update the live site, copy that directory's contents onto the repository root (keep `.nojekyll`) and commit. Do not refactor the scripts to chase the new layout.
