# Donna Daily — design rules (approved redesign, Nov 4, 2026)

Direction: a professional newspaper with BBC-style clarity, a refined Globe and Mail-inspired editorial feel and selective New York Post energy, in Donna Daily's own red/black/white identity. No publisher logos, templates or layouts are copied. (Live BBC and NY Post pages were reviewed for reference; the Globe and Mail site was not accessible, so its current design was not inspected.)

**Where the design lives.** All layout, CSS and components are in `tools/build.mjs` (the `DAILY TEMPLATE` block for daily editions, `SP_CSS`/`renderSpecial` for specials). Edition JSON files are content only. Never add styling or layout fields to an edition. To change the design, change the template and run `tools/test.mjs`. Every page (front page, archived editions, Past editions, specials) is rebuilt from the same template.

## Identity and colour
- The wordmark is the original Donna Daily mark: "DONNA" in black plus "DAILY" in a skewed brand-red box (`#C8102E`). It sits in a compact masthead (52px on phones, 64px on desktop) under a 4px brand-red top rule. There is no full-red masthead and no black promo banner.
- White background (`#fff`), near-black text (`#121212`) and one deep-red accent for text and rules (`#B0102A`, 6.4:1 on white). Muted text is `#555`. Thin `#dedede` dividers and a 1–2px black rule above sections.
- Text contrast must be at least 4.5:1. Focus shows a 3px near-black outline (`:focus-visible`).

## Type
- Headlines use a sentence-case editorial serif (Georgia, then Times New Roman). Metadata, controls, labels and body text use the system sans (-apple-system, Segoe UI, Roboto, Arial).
- Uppercase is only for short section labels and kickers ("UNITED STATES · POLITICS", "TOP STORIES"). Headlines are never all-caps.
- Scale:
  - Lead headline: `clamp(30px, 18px + 2.2vw, 46px)`, which gives 30px on phones and 46px at 1280px and up.
  - Supporting headlines: 21–22px.
  - Regional headlines: 20–22px.
  - Body and decks: 16–18px (lead deck 18px).
  - Metadata: 13–14px.
  - Photo credits: 12px.

## Front page structure (daily edition)
1. **Masthead:** the wordmark plus a Past editions link.
2. **Edition line:** "Morning Edition · Published Tue, Nov 3, 8:06 AM ET · Latest daily edition".
   - This is the **publication** time from `data/published.json`, or from the edition's `publishedAt`.
   - Optional site notices from `data/site.json` (for example a publishing pause) appear on this line and expire automatically.
   - The **site maintenance time** ("Site last rebuilt …") appears only in the footer. Never mix the two, and never re-date an edition.
3. **Region bar:** All · US · Canada · Hong Kong (HK on phones) · China · World.
   - These are toggle buttons with `aria-pressed`, a red underline and a tinted background when active. "All" resets the region.
   - The bar is sticky on desktop and in normal page flow on phones.
   - The **Search & topics** disclosure (`aria-expanded`) sits on the same bar. It opens a search box and topic chips (Politics, Business & tech, Culture, Sports, Human interest) with live counts that follow the region.
   - Topics are never mixed into the region bar.
   - When any filter is on, a status line ("Showing 3 of 15 stories: Canada") and a **Clear filters** button appear. An unmatched search or an empty topic or region shows an honest message with **Show all stories**.
4. **Newer coverage:** a compact red-ruled line linking the newest featured special, with its "Updated …" time. It appears only when the special was updated after the daily edition was published, and it is not a banner.
5. **Lead + Top stories:** one dominant lead and 4–5 supporting stories.
   - Supporting stories come from `topIds`, or default to the first story of each other region.
   - On desktop the lead is about two-thirds wide (deck and Why it matters beside a medium photo) and the supporting stories form a text-only column beside it.
   - On phones everything is one column, with the headline and summary before any image. At 390×844 the lead headline and summary must be fully on the first screen.
6. **Regional sections:** compact lists for the remaining stories, with small 16:9 thumbnails beside the text. Desktop shows 3 columns and tablet 2.
   - Each story appears **once** on the front page. A region whose stories are already above gets an "Also in this edition: …" pointer.
   - A region with no stories says so ("No Hong Kong stories in this edition.").
   - There is no separate "Latest" list.
7. **Past editions** (the 6 newest daily editions plus every special, with an "All past editions" link), then the collapsed **About this edition** and **How to read the labels**, then the footer.

## Story cards
- **Preview:** kicker (region/topic), serif headline, then concise attribution and date ("CBS News, NPR and 2 more · Nov 3"), then a 1–2 sentence deck. Supporting cards use one sentence.
- **Labels on the preview:** show only labels that change how to read the story: Official statement, Claim, Allegation, Analysis/Opinion, Unnamed sources, State media. Plain "Reported" is the default and is stated in the expanded view ("Basis: …"). There are no verified badges of any kind.
- **Why it matters** is always marked "Why it matters · Donna Daily analysis" (italic serif, red rule). It is visible on the lead and is the first item in the expanded view of other stories.
- **Expanded view:** a native `<details>`: the rest of the summary, notes, "About the photo", the claim basis, and Sources & checks (every source link plus its check records).
  - Decorative glyphs (chevrons, arrows) are drawn with CSS borders or wrapped in `aria-hidden`, so no "+", "−" or arrow characters reach the accessibility tree.
  - Filtered-out cards are removed with `display:none`, so their controls never leak into results.

## Photos
- Only legally reusable photos are allowed (README → Photos), always with a credit and licence link next to the picture.
- **Lead:** a medium 16:9 photo beside the deck on desktop, after the deck on phones, with its full caption.
- **Regional cards:** a small thumbnail (112–168px wide) plus a one-line credit under the card. The full caption is in the expanded view under "About the photo".
- **Supporting stories:** text-only on the front page.
- File photos are labelled "File photo, <year>". The year comes from `image.year` or the first year in the caption. A caption never implies an old picture shows the current event.
- A strong text-only story is better than a large irrelevant photo. Missing images simply render text-only.

## Specials and archive pages
- Specials keep their own section/region tools but use the same identity: the compact Donna wordmark with the special's italic name ("Election", "Review"), serif headlines, the deep-red accent and the red brand rule.
- Archived daily editions use the daily template with a "kept as published (Published …)" banner and no newer-coverage or pause notices.
- The Past editions page lists Daily and Special editions separately, each newest first, with publication or update times.

## Checks (tools/test.mjs)
- **Widths:** 360, 390, 430, 768, 1280, 1286×683 and 1440.
- **Layout:** no overflow or clipping; lead headline plus summary on the first 390×844 screen; type sizes and fonts; one lead, 4–5 supporting stories, each story once.
- **Accessibility:** contrast; visible keyboard focus; 44px touch targets.
- **Filters:** every region, every topic and all 25 combinations; unmatched search plus reset; no stray glyphs in the accessibility snapshot.
- **Content:** story expansion and sources; publication versus maintenance time; newer coverage; pause notice; archive and specials.
- **Edge cases:** a fixture with a 170-character headline, missing images, an empty region and an empty topic.
