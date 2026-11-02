# Donna Daily — static website

Built output: `public/` (index.html, editions/*.html, editions/index.html, data.json). Fully self-contained: inline CSS/JS, no external scripts, fonts or trackers. Photos are local files under `public/img/` (copied from `data/img/` at build time), never hotlinked. Readable without JS; JS adds search, region/topic filters, chip filtering and shareable `?region=&topic=&q=` URLs.

## Layout
- `data/editions/*.json` — one file per edition (never edit old ones; they are the archive).
  - `kind:"edition"`: `{id, kind, title, date:"YYYY-MM-DD", leadId, notes:[], stories:[{id, region: us|ca|hk|cn|world, topic: politics|business|culture|sports|human, ts:"YYYY-MM-DDTHH:MM", dateLabel, headline, summary, why, label:"Fact"|"Allegation"|"Fact + opinion"|"Reported (unnamed sources)"|"Fact (state media)"…, note?, sources:[{title, site, date?, href:"https://…"}], image?}]}` (see Photos below)
  - `kind:"archive"`: older Grok Page briefs converted by `tools/convert-archive.mjs` (personal travel section removed from the public copy).
- `data/state.json` — last successful build time (America/New_York), written only after a successful build.
- `tools/build.mjs` — validates (max 5 per region, https sources, required fields), builds into a temp dir, swaps into `public/`.
- `tools/linkcheck.mjs` — checks current edition's source links (403/406 = bot-blocked → WARN; 404/410 → FAIL).
- `tools/test.mjs` — Playwright + Google Chrome at 360/390/430 (phone) and 1280/1440 (desktop): no horizontal overflow on every page, photos stay inside the viewport/column at 16:9 with width/height/alt and existing files (lead not lazy, lead loaded), 16–18px text, ≥44px targets on phones (≥24px on desktop), filters/search/chips, no-JS reading; phone layout has no desktop-only elements; desktop has the lead + Top stories rail side by side, ≥3-column region grids, black sticky nav with a working Sports button, ≤1264px content width, ≤920px archive reading column. A region or Sports with zero stories is allowed. Screenshots to `screenshots/` (incl. `phone-390.png`, `home-390x844.png`, `region-hk-390.png`, `desktop-1280.png`, `desktop-1280-full.png`).
- `tools/update.sh` — the routine's one-command update: linkcheck → build → test (restore previous on failure) → optional `DEPLOY_CMD`.

The newest `kind:"edition"` file (by id, e.g. `2026-11-02-am` > `2026-11-01-ed1`) becomes the front page; all others are listed under Past editions.

## Responsive layout (one page, CSS media queries only; no user-agent sniffing, no separate URL)
- **Phones (<760px):** the original single-column layout. Anything desktop-only carries `class="dt-only"` (hidden below 1024px; its images are `loading=lazy`, so phones never download them).
- **Tablet (760–1023px):** two-column region grids.
- **Desktop (≥1024px):** tabloid front page — full-width red masthead with an 82px wordmark, edition/date/update time on the left; black sticky section nav (US · Canada · Hong Kong · China · World · Sports · Archive; Sports toggles the topic filter via `data-tchip`); lead story (condensed uppercase headline above a big photo) with a **Top stories** rail (first story of each region, thumbnails) and a numbered **Latest** rail beside it; search/filter bar; region sections as 3-column (1024–1199px) or 4-column (≥1200px) grids with red section rules, a double-width feature card, and the last row filled using `data-n` (cards per section excluding the lead); headline/photo/source hover states; black footer. Content max 1264px; archive and past-editions pages use a 920px reading column.
- All of it lives in `tools/build.mjs` (CSS + templates), so every new edition, the archive pages and the past-editions list get it automatically. The routine's steps are unchanged (`tools/update.sh`).

## Photos (optional `image` per story)
Aim to give the lead and most stories a photo. Skip a story rather than bend these rules.

**Field** (on a story): `image: {src, width, height, alt, caption?, credit, license, licenseUrl, sourcePage, isFilePhoto}`
- `src` — RELATIVE path `img/<edition-id>/<story-id>.webp` (the site is served from the repo root on GitHub Pages; the build adds `../` for pages under `editions/`). The file lives at `data/img/<edition-id>/<story-id>.webp`; the build copies all of `data/img/**` to `public/img/**`, so archived editions keep their photos. Use a new folder per edition (story ids repeat across editions). Never delete old edition folders.
- `width`/`height` — pixel size of the processed file (800×450).
- `alt` — what the picture shows. `caption` — short factual line saying what/where/when the photo is (e.g. "Wang Fuk Court in Tai Po, pictured in 2009."). Must not imply it shows the news event unless it really does.
- `credit` — author as given on the Commons file page (e.g. "Gunnar Klack", "National Park Service"). `license` — e.g. "CC BY-SA 4.0", "CC BY 2.0", "CC0 (public domain)", "Public domain (US government work)"; the build rejects anything else. `licenseUrl` — https link to the licence deed (for public domain, the Commons file page). `sourcePage` — https Commons file page.
- `isFilePhoto` — `true` when the picture is of the person/place/venue/flag rather than the event itself (nearly always). Rendered as **File photo**.
- Rendered: the lead gets a full-width 16:9 photo above the headline (eager, `fetchpriority=high`); cards get a 16:9 photo above the label/headline (`loading=lazy`) on every screen size; on desktop the first card of each region is a double-width feature and the Top stories rail reuses the same files as 128×72 thumbnails (credited on the full story). Caption line: File photo · caption · Photo: credit (links to the Commons page) · licence (linked).

**Allowed sources only:** Wikimedia Commons files licensed CC0, public domain, CC BY or CC BY-SA (open the file page and confirm licence + author; avoid files tagged "review needed"/"license review" pending, or with unclear licence), and public-domain US government images (White House, NASA, NPS, military, etc.).
**Forbidden:** news-agency or outlet photos (AP, Reuters, Getty, AFP, Xinhua, outlet websites — also Commons files whose author is a news outlet or TV channel, e.g. am730, Box Azteca), anything with an unclear licence, logos as illustration, and AI-generated images.

**Processing:** download the Commons thumbnail (e.g. API `iiurlwidth=1280`), crop to 16:9 (shift the crop to keep faces/subjects), resize to 800×450, save WebP (quality ~70–78) under ~120 KB (Pillow is installed: `python3 -c "import PIL"`). Record each file in `data/img/<edition-id>/SOURCES.json` (story, Commons file, page, author, licence, licence URL). Cropped CC BY-SA images stay under the same licence (the caption links it).

Commons lookup that returns licence/author/thumbnail in one call:
`https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=File:NAME&prop=imageinfo&iiprop=extmetadata|url|size&iiurlwidth=1280` (read `LicenseShortName`, `LicenseUrl`, `Artist`, `Credit`; send a descriptive User-Agent).
