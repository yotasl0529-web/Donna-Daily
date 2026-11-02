#!/usr/bin/env bash
# Donna Daily update procedure (used by the twice-daily routine).
# 1) The routine researches/verifies stories and writes a NEW edition file:
#      data/editions/YYYY-MM-DD-am.json  or  YYYY-MM-DD-pm.json   (schema: see README.md)
#    Older edition files are never edited, so they stay available as past editions.
#    Photos: put processed files in data/img/<edition-id>/<story-id>.webp and add story.image (README).
#    The build copies data/img/** to public/img/**, so archived editions keep their photos.
#    Special editions (data/specials/*.json, e.g. 2026-10-review) are rebuilt on every run and kept;
#    never edit, move or delete them when writing a daily edition (README: Special editions).
# 2) Run this script. It link-checks, builds into a temp dir, tests at phone/desktop sizes,
#    and only then swaps public/ and records the last successful update. On any failure the
#    previous public/ is left as-is and the script exits non-zero.
# 3) If DEPLOY_CMD is set (e.g. a gh-pages push once GitHub is connected), it runs after tests pass.
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/linkcheck.mjs || { echo "UPDATE FAILED: broken source links (fix or replace them)"; exit 2; }
rm -rf /tmp/donna-daily-prev; cp -a public /tmp/donna-daily-prev 2>/dev/null || true   # includes public/img (all editions' photos)
cp -a data/state.json /tmp/donna-daily-prev-state.json 2>/dev/null || true
if ! node tools/build.mjs; then echo "UPDATE FAILED: build/validation"; exit 3; fi
if ! node tools/test.mjs > /tmp/donna-daily-test.log 2>&1; then
  echo "UPDATE FAILED: layout/filter tests (see /tmp/donna-daily-test.log); restoring previous site"
  rm -rf public && cp -a /tmp/donna-daily-prev public; cp -a /tmp/donna-daily-prev-state.json data/state.json || true; exit 4
fi
if [[ -n "${DEPLOY_CMD:-}" ]]; then bash -c "$DEPLOY_CMD" || { echo "DEPLOY FAILED: local build is fine, public URL still shows previous edition"; exit 5; }; fi
echo "UPDATE OK: $(cat data/state.json)"
