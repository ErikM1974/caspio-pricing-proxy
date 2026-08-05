## v2026.08.05.10 (2026.08.05)

- Gate DTG calibration writes with the shared secret; keep GET public

## v2026.08.05.9 (2026.08.05)

- Gate POST /api/manageorders/orders/create — the last anonymous write

## v2026.08.05.8 (2026.08.05)

- Gate the Box WRITE routes too — the Box surface is now fully closed

## v2026.08.05.7 (2026.08.05)

- Gate the Box READ routes behind the shared secret

## v2026.08.05.6 (2026.08.05)

- Fix unauthenticated arbitrary file write, and the HEAD auth bypass

## v2026.08.05.5 (2026.08.05)

- Scope EVERY /api-mounted limiter — the proxy was capped at 30 req/min per IP

## v2026.08.05.4 (2026.08.05)

- Fix: sanmarLimiter was metering the ENTIRE proxy at 60 req/min per IP

## v2026.08.05.3 (2026.08.05)

- Contract embroidery AI: pass stitch-file context through to the model

## v2026.08.05.2 (2026.08.05)

- sync-design-lookup: add --csv-out for full rebuilds (39k API calls -> 1 import)
- design-search: lower the completeness floor — it was tuned to corrupt data

## v2026.08.05.1 (2026.08.05)

- sync-design-lookup: verify the delete, and NEVER insert on top of it
- sync-design-lookup: countRecords must never return null (it emptied the table)
- sync-design-lookup: treat 429 as backpressure, not as a failure to skip past
- sync-sanmar: run the short backfill daily — it closes the weekend hole

## v2026.08.04.3 (2026.08.04)

- Design Vault PR-A groundwork: surface strict truncation + shared normalizers
- WIP Design Vault PR-A: index engine + /api/design-search routes (DO NOT DEPLOY YET)
- Sync release v2026.08.04.2 back into develop
- Design Vault PR-B: gate design search reads + fields=deep escalation
- jest: forceExit so a fully-green run stops exiting 1

## v2026.08.04.2 (2026.08.04)

- Add /api/sanmar-orders/label-data/:id — one label pipeline for both surfaces

## v2026.08.04.1 (2026.08.04)

- Flag rush orders: 3 or fewer working days between blanks landing and due date

## v2026.08.03.5 (2026-08-03)

- Lessons: one missing carton, three bugs stacked — each hiding the next
- One-off: split the Feb/Mar/Apr 2026 statements out of their 2025 labels
- Payroll: expose Vacation_Annual_Entitlement, stop leaking pay in reconcile

## v2026.08.03.4 (2026.08.03)

- inbound-today: cartons decide the arrival day, not POs

## v2026.08.03.3 (2026.08.03)

- sync-shipments: give the drain loop a cursor — rounds were re-polling the same batch

## v2026.08.03.2 (2026.08.03)

- One-off: realign Atmos Month_Reconciled to the table's YY-Mon convention
- A carton that ships after its order closes was invisible forever

## v2026.08.03.1 (2026.08.03)

- Pacing: bar pre-repair rollup rows from the rate, widen the trend to 7 days
- Atmos upsert: key on the reference digit run, store it non-numeric

## v2026.07.31.3 (2026.07.31)

- Pacing: project from spent + recent trend, so the alert can go green again

## v2026.07.31.2 (2026.07.31)

- sync-sanmar: the slowest phase was silently disabling its own safety net

## v2026.07.31.1 (2026.07.31)

- Meter: count what Caspio RECEIVES, not what we SEND
- Lessons: a filter that was right about one consumer silently starved another

## v2026.07.30.2 (2026.07.30)

- Meter: count our own rollup writes, and publish the reconciliation
- sync-shipments only looked at OPEN orders, so closed-before-tracked POs never appeared
- Postman preserve-list: 'GET /api' was an artifact, not a hand addition

## v2026.07.30.1 (2026.07.30)

- Shutdown: flush the meter in PARALLEL with server.close(), bounded and loud

## v2026.07.29.12 (2026.07.29)

- Deploy v2026.07.29.12: 2 files (jotform.js, jotform-normalizer.test.js)

## v2026.07.29.11 (2026.07.29)

- Close the exit-flush hole: a job ending in process.exit() never recorded its tail

## v2026.07.29.10 (2026.07.29)

- sync-purchase-orders: same content dedupe, now that the legacy CSV chain is confirmed dead

## v2026.07.29.9 (2026.07.29)

- sync-orders: content dedupe — stop writing every changed order to Caspio twice

## v2026.07.29.8 (2026.07.29)

- sync-manageorders: fix the date comparison that re-synced 456 orders/day forever

## v2026.07.29.7 (2026.07.29)

- Postman: --prune, so the 143 dead entries could actually be removed
- Remove the contract-sticker-ai route; keep its test's live half

## v2026.07.29.6 (2026.07.29)

- Memory: rescue the Files-API DELETE semantics from the auto-memory index
- Generate the route map from source — the hand-written one had 44 of 121 files
- Postman scanner: one in five collection entries pointed at a URL that 404s
- Gate the six anonymous AI chat routes behind requireCrmApiSecret

## v2026.07.29.5 (2026.07.29)

- Track .claude/skills — a fresh clone couldn't deploy without them
- core.hooksPath: point git at the tracked hooks instead of copying them in

## v2026.07.29.4 (2026.07.29)

- GIT_WORKFLOW.md documented a deploy path the pre-push hook blocks

## v2026.07.29.3 (2026.07.29)

- inbound-today: fill "Unmatched" POs from live ManageOrders when the archive lags
- Delete the three server.js.backup-* files (CLAUDE.md rule 1)
- .gitignore: close the *.backup-* gap that let 800 KB of server.js copies ship

## v2026.07.29.2 (2026.07.29)

- Stop serving the repo root — express.static('.') published source and internal docs

## v2026.07.29.1 (2026.07.29)

- Keep crawlers off the API — no robots.txt meant Googlebot was pricing the catalog

## v2026.07.28.8 (2026.07.28)

- DTG product-bundle: cache it, merge its two Sanmar scans, stop pricing on partial data
- Meter the 3 blind scheduler scripts; stop ~619 no-op PUTs/day in sync-manageorders

## v2026.07.28.7 (2026.07.28)

- Memory: check-transfers-received cadence 10 min -> hourly at :20

## v2026.07.28.6 (2026.07.28)

- daily-sales-by-rep: abort the date on a failed read instead of INSERTing duplicate archive rows
- sanmar-orders: fix two truncated/unordered reads that caused nightly PO re-ingestion
- check-transfers-received: fail loudly when the Slack_Notified flag does not stick

## v2026.07.28.5 (2026.07.28)

- Rollup: flush POST is no longer metered (self-feeding flush loop)

## v2026.07.28.4 (2026.07.28)

- Meter, rollup and pacing now key days on the Caspio account clock (Pacific), matching how Caspio buckets its usage bars

## v2026.07.28.3 (2026.07.28)

- Rollup: rate limits retry with backoff instead of tripping the circuit breaker
- Rollup: beforeExit flush fires once, not on every loop drain

## v2026.07.28.2 (2026.07.28)

- Rollup: record scheduler dynos — the table only ever held web.1

## v2026.07.28.1 (2026.07.28)

- Payroll API: expose Vacation_Eligible_Hours for the printed slip footnote

## v2026.07.27.4 (2026.07.27)

- Payroll: write Vacation_Hours_Remaining now that it is no longer a Caspio formula

## v2026.07.27.3 (2026.07.27)

- Thumbnail sync: skip files over the server's upload cap instead of failing them
- Payroll tracking: Payroll_Register schema + reconciled packet importer
- Payroll import: Erik-confirmed roster corrections + spelling-tolerant matcher
- Payroll follow-ups: vacation eligibility, ex-staff deactivation, admin-only gate
- Payroll API: admin-gated reads + packet upload with reconciliation gate
- Payroll cleanup: deactivate UT Thi Tran (last unexplained active record)
- Payroll: repair employee drift found by auditing a Caspio CSV export

## v2026.07.27.2 (2026.07.27)

- Pre-push guard: production ships through /deploy, not by hand

## v2026.07.27.1 (2026-07-27)

**Catch-up release.** Tagging lapsed after `v2026.07.01.1` and CHANGELOG entries after
`v2026.07.19.3`, while work continued straight onto `main` and shipped to Heroku untagged.
This tag marks the slug currently live (`84fa367`, Heroku v1014) and records the 36
commits deployed since the last CHANGELOG entry. A pre-push guard now blocks direct `main`
pushes so the deploy skill can't be bypassed again.

- fix(ae-dashboard): data-quality radar flags only OPEN, non-webstore orders
- feat(ae-dashboard): flag orders with a carrier ship method but no ship-to address
- feat: /api/command-search — staff dashboard Ctrl+K Everything Bar backend
- feat(shopworks-odbc): payables sync → Caspio ShopWorks_Payables + read feed for SanMar Payables page
- feat(sanmar-invoices): payable import-stamp log (mark-imported / imports / unmark)
- bandit-agent: rewrite sync-thumbnail-metadata.ps1 for direct ODBC
- Jim's Mailing List: Prospect_Mailing_List table + CRUD route
- Jim's Mailing List: AI capture endpoint (paste text/screenshot -> fields)
- Prospect_Mailing_List: add First/Last name, outreach status, Mailchimp tracking fields
- Jim's Mailing List: First/Last fields + status/mailed columns on route; AI returns First/Last
- Jim's Mailing List Phase 2: Mailchimp client + status/sync/record-sends endpoints
- Jim's Mailing List: controlled + engagement-aware Mailchimp sync
- Jim's Mailing List: build the Mailchimp engagement map in the background
- products/search: surface PRODUCT_STATUS='New' styles + styleNumbers list filter
- products/search: dedupe styles before pagination on styleNumbers requests
- products/search: stable q.orderBy on Phase-2 variant fetch (silent row drops)
- Sticker pricing: one engine, derived unit prices, TTL cache, first tests
- Security: /api/contract-sticker-ai is now secret-only
- Sticker durability: one number, and it's 3 years
- Sticker AI: never quote an outdoor lifespan
- Uploads: allow TIFF, and stop trusting octet-stream alone
- fix(products): never cache an empty brand/category list
- Q3 2026 Embroidery Bonus: computation, config table, scoped access
- Embroidery bonus: target roadmap endpoint, and stop using a deprecated bulk helper
- Embroidery bonus: pace context on the seasonal curve, not elapsed days
- Caspio quota: fix the meter first, then cut the calls
- Embroidery bonus: exclude webstore accounts, and replace the ladder with a rate
- Re-baseline the bonus harness, and stop the fallback config lying
- Caspio quota: create the rollup table so the meter survives dyno cycling
- Caspio quota: schedule the pacing check in-dyno, not on Heroku Scheduler
- Caspio pacing: an empty rollup table is "unknown", not 0% of limit
- Rollup: accumulate across dyno restarts instead of overwriting
- Memory: thumbnail sync cost model, measured
- Call list: one ranked order of work, and a CRM write that can't vanish
- SanMar inbound: reconcile against the freight manifest, per carton
- Product copy: CSV407 dual-color safety vest (autopilot 2026-07-27)

## v2026.07.19.3 (2026-07-19)

- feat(leads-crm): live Claude lead qualification. `src/utils/lead-classify-ai.js` — Anthropic Messages API (`claude-opus-4-8`, override `LEAD_CLASSIFY_MODEL`; structured-output JSON) categorizes newly-arrived uncategorized `New` leads as spam/unqualified/qualified and applies (spam+unqualified → Status='Archived'+Lead_Category, qualified → tag; logs a `system` activity). Routes `GET /api/lead-classify/scan` (CRM-secret dry-run) + `POST /api/lead-classify/run` (CRM-secret; powers the "Rescan with Claude" button). Cron: daily 6:30 AM PT, env-guarded on `ANTHROPIC_API_KEY` (no-op if unset). Bounded/idempotent — only touches blank-category New leads. Adds `@anthropic-ai/sdk`.

## v2026.07.19.2 (2026-07-19)

- feat(leads-crm): lead qualification. New `Form_Submissions.Lead_Category` field ('' | qualified | unqualified | spam) — Claude-categorized via a 28-agent workflow. `POST /api/lead-categorize/apply` (x-admin-key): bulk chunked `Submission_ID IN()` PUTs — `toLost` qualified non-converters → Status='Lost', `spam`/`unqualified` → Lead_Category set + kept Status='Archived' (off the board). `GET /api/form-submissions?category=` filter + PUT whitelist += Lead_Category — powers the "Unqualified & Spam" review page. Server-side chunking dodges the 30s browser-request limit.

## v2026.07.19.1 (2026-07-19)

- feat(leads-crm): lead-conversion tracking + rep scorecard. `src/utils/lead-conversion.js` — `runConversionSync()` auto-moves a lead to WON once its ShopWorks customer places an order AFTER the inquiry (email OR company match; "first order after lead" rule; personal-email + name-mismatch = collision-risk, skipped), attaches the customer # + stamps lifetime sales in Lead_Value, and refreshes lifetime on Won leads. `buildScorecard({since,until})` = per-rep closes + total order value by conversion date (answers "Taneisha since Oct 2025"). Routes: `GET /api/lead-conversion/scan` (CRM-secret dry-run), `POST /api/lead-conversion/run` (x-admin-key; `{includeArchived,fuzzy}` = one-time backfill), `GET /api/lead-scorecard` (CRM-secret). Cron: daily 6:15 AM PT (before the 7:45 digest; `CONVERSION_SYNC_DISABLED=1` to pause). Pure helpers jest-locked (11 cases). Quota-light: scan touches only OPEN leads; scorecard computes on demand.

## v2026.07.18.8 (2026-07-18)

- fix(lead-outreach): drop the company from template prose when it's really just the person again (blank, equals the contact name, or the modal's "Individual — Name" fallback) — "custom apparel for Jordan Hibbard — I'll be your…" now reads "custom apparel — I'll be your…"; real companies unchanged (+jest cases)
- 🔒 fix(lead-digest): `GET /api/lead-digest/scan` was ANONYMOUS (dry-run report exposes lead companies/contacts + AE emails) — now requireCrmApiSecret, same posture as /lead-activity (the orders-router "enumerate every route" lesson again)

## v2026.07.18.7 (2026-07-18)

- feat(leads-crm): manual lead capture — new Form_ID `manual-lead` (prefix MNL, default Status New) for phone/walk-in leads logged by staff from the Leads board; Slack card "📞 New PHONE/WALK-IN LEAD"; counts in the follow-up digest; arrival enrichment runs but SKIPS the rep email when the logging AE already picked a rep (no self-notify noise)
- feat(leads-crm): one-click outreach — `POST /api/lead-outreach` (CRM-secret; staff via the main app's forwarder): 4 server-built templates (`src/utils/lead-outreach-templates.js` — intro / quote-followup / checking-in / won-thanks, every lead value HTML-escaped), `preview:true` returns {label,subject,bodyHtml} without sending; send goes EmailJS `EMAILJS_TEMPLATE_LEAD_OUTREACH` (To=lead, Reply-To=AE if @nwcustomapparel.com else sales@) then logs an `email` Lead_Activity row
- feat(lead-activity): Activity_Type allowlist += `email`
- test: lead-outreach jest suite (template build, unknown-key null, XSS-escape lock)

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

