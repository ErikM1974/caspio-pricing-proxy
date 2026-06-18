## v2026.06.18.2 (2026.06.18)

- fix(inventory): /sizes-by-style-color no longer 500s — the dedicated Caspio "Inventory" table now 404s, so derive the real size run (e.g. PC61 → S–6XL) from the live SanMar bulk table as a fallback. Quote builders' getAvailableSizes() now see 5XL/6XL instead of a hardcoded S–4XL list.

## v2026.06.18.1 (2026.06.18)

- fix(files): make DELETE /files/:externalKey idempotent + diagnosable

## v2026.05.20.1 (2026-05-20)

- Contract Emblem AI: 4-6 week Taiwan turnaround (replace 10-12 day default)
- Contract Emblem AI: proactively flag LTM threshold during chat intake
- Contract Webstore AI: new dual-mode bot with web-search tool
- DTG Quote AI: chat-driven retail quote builder + live ShopWorks push
- DTG Quote AI: real-catalog color lookup + fix print-cost dropout
- Release: DTG Quote AI catalog lookup + pricing fix
- DTG Quote AI: hydrate product thumbnails on recommend_top_sellers
- Release: top-seller thumbnails
- DTG Quote AI: tier aggregates BY IMPRINT, multi-line quote support
- Release: DTG tier aggregates by imprint + multi-line quotes
- DTG: single canonical pricing module + /api/dtg/quote-pricing endpoint
- Release: DTG canonical pricing module + /api/dtg/quote-pricing endpoint
- DTG Quote AI prompt: 3 UX fixes from a real-rep session
- Release: DTG bot prompt UX fixes
- DTG bot: 3 prompt fixes from a real-rep transcript
- Release: DTG bot prompt UX fixes (round 2)
- DTG LTM is now Caspio-driven (no more hardcoded $50 / qty<24)
- Release: DTG LTM Caspio-driven (no hardcoded 0)
- DTG bot prompt: require canonical SanMar COLOR_NAME in PRICE_QUOTE
- Release: DTG bot canonical COLOR_NAME requirement
- DTG bot REP MODE: collect everything in 1 reply, mandatory STATUS LINE
- Release: DTG bot REP MODE prompt
- DTG bot: stop drip-feeding size questions
- Release: DTG bot no drip-feed sizes
- DTG bot: quick-paste opener + parallel tool calls
- Release: DTG bot quick-paste opener + parallel tool calls
- DTG bot: explicit next-step list after pricing
- Release: DTG bot explicit next-step list
- DTG bot: form is source of truth — read [CURRENT FORM STATE] first
- Release: DTG form-state-aware bot
- DTG bot: recast as 'Order Entry Assistant', not salesperson
- Release: DTG bot Order Entry Assistant rebrand
- DTG bot: lead every greeting with print location
- Release: DTG bot leads with print location
- DTG bot: location auto-update — drop 'tap the pill' wording
- Release: DTG bot location auto-update
- DTG bot: never confirm a color from memory — call the tool first
- Release: DTG bot no-hallucinate color
- Add DTG Top Sellers API — curated catalog from Caspio
- Release: DTG top-sellers endpoint
- DTG bot: warn on unapproved styles, steer to top 20
- Release: DTG bot warn on unapproved styles
- DTG bot: recommend_top_sellers now queries Caspio table
- Release: DTG bot recommend_top_sellers uses Caspio table
- DTG bot + tool: hard-block invalid colors at the source
- Release: hard-block invalid colors at bot + tool
- DTG top-sellers: add main_image_url + top_colors[] to /styles endpoint
- Release: catalog enrichment for images + inline swatches
- DTG bot prompt: Brother GTX600 → Kornit Storm Hexa
- Release: DTG prompt — Kornit Storm Hexa rename
- DTG top-sellers: per-color front_image_url for catalog hero swap
- Release: DTG top-sellers per-color hero
- DTG bot: re-scope as research assistant (no more form-filling)
- Release: DTG bot research-assistant re-scope + exclusion script
- DTG designs: new /api/dtg-designs/by-customer/:customerId endpoint
- Release: DTG designs endpoint
- Deploy v2026.05.20.1: 2 files (enrich-contacts-from-manageorders.js,thumbnails.js,)

