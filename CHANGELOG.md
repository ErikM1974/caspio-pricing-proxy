## v2026.07.18.6 (2026-07-18)

- feat(leads-crm): in-app lead forms (quote-request / webstore-request / team-roster) now get the SAME arrival enrichment as JotForm leads — fire-and-forget AE auto-assign (email match → AE else Taneisha; roster keeps a customer-chosen rep, blanks only) + Matched_ID_Customer stamp + EmailJS rep notification. Enrichment can never fail or slow the customer's save.
- feat(rep-email-map): 'House' → sales@ (house-account CSR on some ShopWorks contacts previously fell to the unassigned bucket)

## v2026.07.18.5 (2026-07-18)

- feat(leads-crm): digest + new-lead-email deep links now open the full lead workspace (`/dashboards/lead.html#<id>` — still hash-only, QP-safe)

## v2026.07.18.4 (2026-07-18)

- feat(leads-crm): activity timeline — new `Lead_Activity` Caspio table (Submission_ID FK, typed note/status/attachment/quote/system rows, TEXT body, server-stamped Created_At) + `GET/POST /api/lead-activity` (CRM-secret; staff reach it via the main app's session forwarder); attachment URLs allow-listed to proxy `/api/files/` + JotForm hosts
- feat(leads-crm): `Lead_Value` column on Form_Submissions (+PUT whitelist) — estimated pipeline $; a linked quote's TotalAmount snapshots into it
- feat(leads-crm): follow-up digest — `src/utils/lead-followup-digest.js` (overdue / due-today / new-&-untouched-48h buckets, per-AE via rep-email-map resolveAEEmailLoose, one EmailJS email each, #hash deep links — never '=' in emailed links); cron weekdays 7:45 AM PT (staggered before the 8:00 approval digest); admin `GET /api/lead-digest/scan` (dry-run) + `POST /api/lead-digest/send` (x-admin-key); env `EMAILJS_TEMPLATE_LEAD_FOLLOWUP_DIGEST`
- feat(rep-email-map): + Jim / Bradley / Steve(art@) / General(sales@) — leads carry full display names, resolved via resolveAEEmailLoose
- test: 14-case lead-digest-model + lead-activity-validate jest suites

## v2026.07.18.3 (2026-07-18)

- fix(leads): webhook ingest is REST-first — fetches the submission from the JotForm API on each webhook ping (rawRequest stays as fallback), so upload URLs are always captured (Erik's 7/18 test lead arrived without its attachment; backfill rows via REST had them)
- feat(leads): GET /api/jotform/file?u= — staff passthrough that streams JotForm uploads using the API key (JotForm upload links otherwise require a JotForm login); requireCrmSecretOrBrowserOrigin gate + strict JotForm-upload-host allow-list (never an open proxy). Leads drawer now shows in-app thumbnails
- fix(jotform): extractUploadUrls also accepts protocol-less rawRequest upload paths
- test: upload-URL extraction + passthrough allow-list cases (28 total across the jotform suites)

## v2026.07.18.2 (2026-07-18)

- feat(leads): JotForm lead ingest — POST /api/jotform/webhook (token-gated fast-ack multipart receiver), POST /api/jotform/sync (CRM-secret reconcile), GET /api/jotform/health; the 6 JotForm lead forms normalize into Form_Submissions as Form_ID='jotform-lead' (prefix JFL, External_ID dedupe) with AE auto-assignment (exact-email match in CompanyContactsMerge2026 → contact's rep + Matched_ID_Customer, Sales_Reps_2026 fallback; else Taneisha Clark) + #form-leads Slack card showing rep + source form
- feat(form-submissions): GET accepts formIds= (comma list) + statusNot= + limit= (≤2000, pageSize 500); PUT whitelist adds Sales_Rep / Matched_ID_Customer / Linked_Quote_ID (Leads CRM page writes)
- feat(schema): Form_Submissions +4 STRING columns (External_Source, External_ID, Matched_ID_Customer, Linked_Quote_ID) via create-form-submissions-tables.js field-sync — run `node scripts/create-form-submissions-tables.js --apply` once
- feat(scripts): register-jotform-webhooks (idempotent; --list/--remove/--form/--sample) · jotform-reconcile (daily Heroku Scheduler webhook-miss backstop) · backfill-jotform-csv (LOCAL one-off → Caspio CSV import = $0 Integrations quota; offline AE assignment; JFL{MMDD}-nnnn historical ids; >60d rows land Archived)
- test: jotform-normalizer jest suite (19 tests — both payload shapes, assignment pick, record build, webhook secret compare, account-TZ → ISO conversion)
- feat(leads): EmailJS "new lead" notification to the assigned rep (send-lead-email.js — AE from the match, else Taneisha; same EMAILJS_* creds as the other send-* utils; template `template_new_lead`; lead_link = /dashboards/leads.html#JFL… hash, no '=' per the QP-mangling rule; fire-and-forget, never blocks the save) + 7-test jest suite

## v2026.07.18.1 (2026-07-18)

- perf(cache): shared TTL cache (`src/utils/ttl-cache.js`) + 1h static-table cache (`src/utils/caspio-static-tables.js`) — per-style caching on 9 hot endpoints (size-pricing, max-prices-by-style, base-item-costs, inventory, sizes-by-style-color, product-colors, color-swatches, product-details, stylesearch); PDP Caspio cost drops ~13→~1 calls/view (Caspio quota was 507K/500K)
- perf(inventory): remove dead `/tables/Inventory` probe from /sizes-by-style-color (404'd on every call since 2026-06-18)
- security(inventory/products/pricing): sanitize style/color interpolation in WHERE clauses; remove `sanitize()||rawInput` fallbacks; escape stylesearch LIKE term
- feat(cache): GET /api/product-cache/clear — flush all product/pricing response caches (per-dyno); `?refresh=true` bypass on all cached endpoints
- test: 4 hermetic jest suites for cache behavior (hit/miss/TTL/bypass/no-cache-on-degraded/error-propagation)

## v2026.07.01.1 (2026-07-01)

- feat(portal-recs): candidate-pool columns on GET /recommendations for per-customer ranking

## v2026.06.30.3 (2026.06.30)

- chore(portal-p4): seed script for starter Portal_Recommendations (6 rows inserted)
- feat(portal-p5): reward-dollars ledger route (balance/entry/ledger, append-only, overdraw-guarded) + table script

## v2026.06.30.2 (2026.06.30)

- feat(portal-p4): catalog request-to-rep + recommendations route + Phase-4 table-creation script

## v2026.06.30.1 (2026.06.30)

- fix(inventory): /sizes-by-style-color falls back to SanMar bulk size run
- feat(pricing): custom & oversize decal square-foot pricing
- fix(dtg): reconcile empty-tiers fallback margin 0.57->0.53 to match the client copy (pricing-engine audit DTG-4)
- feat(art): add ?repMockup=true filter to /artrequests (saved-mockup library)
- security(art/files): integer-guard ids + escape WHERE filters + file-key/mime validation + art-write rate limit
- security(cors): origin allowlist (caspio/heroku/teamnwca/localhost, server-to-server allowed, EXTRA_CORS_ORIGINS env) + nosniff/referrer headers
- feat(pricing): add DTG_Store method to /api/pricing-bundle
- feat(sanmar-orders): GET /daily-inbound — daily arriving-blanks rollup for dashboard
- feat(sanmar-orders): GET /inbound-today — detailed per-PO arrivals for the dashboard detail view + PDF
- feat(sanmar-orders): inbound-today — live per-box contents (Option A)
- feat(sanmar-orders): backorder/hold alerts — surface SanMar issue flags
- feat(sanmar-orders): inbound-today — add ManageOrders box-label header fields
- feat(sanmar-orders): inbound-today — add date_Ordered to box-label fields
- feat(sanmar-orders): map id_OrderType 31 → Inksoft (was falling through to "Other")
- fix(files): serve correct image MIME from filename (Caspio returns text/plain)
- feat(sanmar-orders): daily-inbound accepts ?start=&end= month range (for the inbound calendar)
- feat(sanmar-orders): inbound $ — line/PO/day blank cost (wholesale CASE_PRICE)
- fix(sanmar-orders): inbound-today pieces from box detail when available (match cost source)
- feat(sanmar-orders): business-day arrival estimate (skip weekends + holidays)
- feat(scp-push): sleeves in production note + screen count
- @ Multi-mockup send: wire 6 ArtRequests mockup slots (Mockup_4/5/6)
- feat(sanmar-orders): method-aware transit — expedited UPS = guaranteed business days
- feat(sanmar-orders): method-aware transit — expedited UPS = guaranteed business days
- feat(ups-tracking): live delivery dates by tracking number (UPS Track API, OAuth)
- feat(ups-tracking): live delivery dates by tracking number (UPS Track API, OAuth)
- feat(sanmar-orders): inbound-today — attach UPS live delivery date per PO
- feat(sanmar-orders): inbound-today — attach UPS live delivery date per PO
- feat(ups-tracking): Quantum View client + /quantum-test diagnostic
- feat(ups-tracking): Quantum View client + /quantum-test diagnostic
- feat(files): import-from-url endpoint for "Send to Steve" art carry-over
- fix(sanmar-orders): catch-up sync for fast-completing orders + /link id_Order on create
- refactor(sanmar-orders): make /sync-recent-completed ASYNC (background + status)
- fix(art): notify AE on completion (email + Slack DM); restore dead status pings
- fix(rep-map): Ruthie/Ruth resolve to ruth@ (real inbox + Slack), not ruthie@
- feat(scp-push): itemize Vellum + Color Chg; fix SPSU description
- feat(safety-stripes): top-sellers route + Caspio table for hi-vis recommendations
- docs: point CLAUDE.md to the Caspio platform REST API capability reference
- feat(scripts): add read-only Caspio entitlement probe
- security(#9): gate customer-profile + industry-lookalikes (side-door)
- security(#9): gate daily-sales archive WRITES (anon could wipe YTD)
- security(#9): gate pricing-engine writes + service-code writes + files DELETE
- security(#9): gate admin/products + dead proxy orders + thumbnails writes
- security(#9): gate shipstation writes (anon could inject/delete warehouse orders)
- feat(#5): on-demand Caspio task triggers (list/status/run, gated)
- fix(#5): use src/config v3 base for dataImportExportTasks (was hitting /rest/v2 404)
- security(#9): trim internal CRM fields from PUBLIC digitized-designs/lookup
- tools(rbac): read-only Caspio Staff directory inspector + dry-run-first set-staff-roles
- feat(rbac): create + populate Staff_App_Roles Caspio table (app-readable role source)
- feat(rbac): GET /api/staff-app-role — read role from Staff_App_Roles (gated)
- chore(rbac): add jim@ as 'staff' (normal user) to Staff_App_Roles
- feat(rbac): Staff_Page_Access table + GET /api/staff-page-access (table-driven page gating)
- feat(rbac): admin CRUD endpoints for Staff_App_Roles + Staff_Page_Access (for Access-Admin UI)
- Merge PR #2: admin-rbac CRUD endpoints (Access-Admin UI backend)
- Merge remote-tracking branch 'origin/main' into deploy/send-to-steve
- security(side-door): gate /api/gift-certificates (requireCrmApiSecret)
- security(side-door): gate writes on /api/creditcard-atmos (gateWritesOnly)
- security(side-door Wave 1): gate no-caller + server-only endpoints
- feat(portal): Customer_Portal_Access invite registry + gated lookup endpoint (Phase 0)
- chore(portal): load dotenv in create-table script so standalone runs get Caspio creds
- feat(portal): customer-portal-access CRUD (list/create/update/delete) + Sales_Reps_2026 rep enrichment for the Customer Portals admin console

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

