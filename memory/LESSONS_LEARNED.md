# Lessons Learned

A running log of problems solved and gotchas discovered. Add new entries at the top.

---

## Problem: A safety guard emptied the production table it was written to protect
**Date:** 2026-08-05
**Symptoms:** `node scripts/sync-design-lookup.js --live` printed `❌ ABORTED — delete failed:
Cannot read properties of null (reading 'toLocaleString')` and inserted nothing. Design_Lookup_2026
was left with **0 rows** — `/design/:n` customer share pages, the EMB quote-builder design picker,
and `search-all`/`by-customer` all served empty until a follow-up run restored 38,785 rows.
**Background — the bug the guard existed for.** The table held **146,526 rows for a 38,785-row
dataset**: design #36868 had 43 rows for 10 distinct DST+stitch combinations, every row stamped
2026-02-24 or 2026-02-25. Step 3 issued a **WHERE-less DELETE**, which Caspio silently does not
honour, then logged HTTP 400 as "table already empty" and, on any other error, printed *"will try
inserting anyway"* — and did. Two runs, two stacked copies, ~4-5x duplication. (It also explains
the Vault index reading 146,526 base rows to yield only 37,811 groups: grouping was absorbing it.)
**Root cause of the outage:** the new verified-delete guard called `countRecords()`, which read
`resp.data.TotalRecords` — a field **Caspio REST v3 does not return** on `GET /tables/{t}/records`.
It came back `undefined` → helper returned `null` → `null.toLocaleString()` threw in the log line
that runs *immediately after* the DELETE. So the guard aborted correctly but **downstream of the
destructive step**, on an input that had never been checked against a real response.
**Solution:** `countRecords()` now returns 0 / a real count / `-1` ("not empty, count unknown")
derived from whether a `q.limit=1` probe returns rows — it cannot return null. All count logging
goes through `fmtCount()`, so nothing between delete and insert can throw. Callers already treat
`!== 0` as "still has rows". Commits `d2b1822` (guard) + `f770735` (null-safety).
**Prevention.**
- 🔑 **A guard that reads a field you have never observed on a real response is not a guard.** One
  read call would have shown `TotalRecords` was undefined. Verify the probe *before* trusting it to
  gate anything destructive.
- 🔑 **Put the verification UPSTREAM of the destructive step.** Check-then-delete fails safe;
  delete-then-check fails empty. The abort path must be reachable before data is gone.
- 🔑 **Caspio DELETE needs an explicit WHERE.** `q.where=PK_ID>0` deletes and reports
  `RecordsAffected`; a WHERE-less DELETE removes nothing while looking like success. Never treat a
  4xx on a delete as "already empty" — that is the opposite of what it means.
- 🔑 **Never insert on top of an unverified delete.** A no-op run is recoverable; a stacked one
  silently corrupts every consumer and hides inside grouped reads for months.
- ⚠️ Full-refresh scripts on this table are one POST per record (**no batch insert in REST v3**):
  38,785 records ≈ 39k Caspio calls and ~30 min with an empty-table window. Run them off-hours.

---

## Problem: One missing carton, three bugs stacked — each hiding the next
**Date:** 2026-08-03
**Symptoms:** PO 113852's second carton (VA, `1ZGH03410357176079`, 1 pc) was on SanMar's PSST
manifest and in SanMar's live feed, but on no printout and no day of the inbound board. Three
separate sync paths were run against it and all reported success having done nothing.
**Root cause — three independent defects in series:**
1. **Ingest.** The order shipped carton 1 on 7/30 while SanMar had it OPEN, then carton 2 on
   7/31 after SanMar CLOSED it. Every path then declined carton 2 for a different reason: the
   daily loop skips Complete; `/sync-shipments` skipped any PO that already had a carton;
   `/sync-recent-completed` only ingests orders we don't already hold. Fixed by making a PO
   'settled' only once its NEWEST carton is older than `recheckDays` (default 10).
2. **Drain loop (self-inflicted, caught in prod within minutes).** Re-polling no longer shrinks
   `pending`, so `pending.slice(0, cap)` returned the same head every round — three rounds,
   identical batch, `remaining` stuck at 53. Fixed with an explicit `?offset=` cursor.
3. **Display.** `/inbound-today` collapsed all of a PO's cartons into one entry BEFORE choosing
   a day, taking the earliest estimate and the FIRST tracking's UPS date. A split-warehouse PO
   could only ever appear on one day; its other cartons were dropped silently. Fixed by
   bucketing per CARTON, then grouping the survivors by PO.
**Verified:** 113852 now shows on 8/3 (NV carton) and 8/6 (VA carton), each with only its own box.
**Prevention.**
- 🔑 **A fix that makes data appear in a table has not finished — check it renders.** Bug 1 was
  fixed and the carton was still invisible, because bug 3 lived one layer up. 'It's in the
  database' is not 'the user can see it'.
- 🔑 **A near-miss is not a pass.** Sibling PO 113837 survived bug 3 purely because its two
  estimates fell outside each other's ±3-day band. That accident is what made me wrongly
  conclude the PO-keyed skip was harmless — verify the mechanism, not the outcome of one case.
- 🔑 **Grouping before filtering loses rows.** Any 'collapse to parent, then decide' pipeline
  silently drops children that would have decided differently. Filter first, group after.
- 🔑 When a loop's progress depended on its own side effect (rows leaving the queue), removing
  that side effect turns it into an infinite no-op. Give it an explicit cursor.
- Found, again, only by reconciling SanMar's PSST manifest against our board — not by telemetry.

---
## Problem: A filter that was right about one consumer silently starved another
**Date:** 2026-07-30
**Symptoms:** Cartons on SanMar's PSST freight manifest were absent from the SanMar Inbound
board and from the printed box labels — PO 113832 and the VA half of split PO 113837.
SanMar's live feed had both. `sync-shipments` reported `checked: 3, shipmentsAdded: 0`:
it had looked straight past them. Re-running never helped.
**Root cause:** `sync-shipments` selected only non-terminal orders
(`SanMar_Status<>'Shipped' AND <>'Complete' AND …`). The reasoning in the comment was sound
*for the consumer it was written for*: a shipped order's status dot is already correct, so it
needs no tracking-based promotion. But a second consumer had grown up on the same table —
`/inbound-today` builds its **entire candidate list** from `SanMar_Shipments`. So a PO that
reached Complete before its tracking was ever captured could never get a shipment row, and its
cartons were invisible to receiving **permanently**, not merely late. The filter wasn't stale
or wrong; it was correct for one reader and starving for the other.
**Solution:** Also consider recently-CLOSED orders that still have no tracking row, bounded to
one page of the most-recently-updated (`?closedScan=`, default 200, max 1000) so it can never
become a scan of every order ever completed. Canceled stays excluded. Purely additive — the
original open-order query is untouched. Verified live: candidates 135 → 319,
`shipmentsAdded` 0 → 1, and all 8 of our POs on the manifest then reconciled exactly.
**Prevention:**
- **When a table gains a second reader, re-audit every filter that writes to it.** Ask what
  each consumer needs, not just the one the code was written for. A `WHERE` clause is an
  implicit contract with every downstream reader.
- **"Nothing to do" is a claim that needs checking.** `shipmentsAdded: 0` looked like a healthy
  no-op and was actually the bug. A skip count (`pendingNoTracking`, `closedCandidates`) makes
  the difference visible — that is why those counters are now in the response.
- **Reconcile against the vendor's own document.** Both this and the 2026-07-29 gap were found
  by diffing the PSST manifest against our board, not by anything in our own telemetry.
- A PO can legitimately arrive on **two different days** (split shipment, different warehouses:
  113837 NV → 7/31, VA → 8/4). Any reconciliation keyed on PO alone reads that as a shortfall.

---

## Problem: Every quote DELETE reported recordsAffected: 0 — even successful ones
**Date:** 2026-07-08
**Symptoms:** `DELETE /api/quote_sessions/:id` → 200 `recordsAffected: 0` for a row that a direct table GET confirmed existed (and that a delete-by-QuoteID removed fine). Suspected PK aliasing or numeric-vs-string `q.where` — both disproven by a live create→delete-by-PK→verify round trip: `q.where=PK_ID=<n>` deletes fine, quoted or unquoted (PK_ID works in `q.where` even though `/tables/{t}/fields` metadata omits the autonumber PK).
**Root cause:** `makeCaspioRequest` returned `{success, status}` for DELETEs, discarding Caspio's `{"RecordsAffected": N}` body — every handler's `result.RecordsAffected || 0` fabricated 0, hit or miss. Caspio also answers 200 `{"RecordsAffected": 0}` (not an error) when the where matches nothing, so a miss looked identical to a success.
**Solution:** `src/utils/caspio.js` now passes the DELETE body through; `src/utils/quote-delete-response.js` (pure, jest-locked) maps 0-affected → 404 for quote_sessions/items/analytics; a real sessions delete clears the 5-min `quoteSessionsCache`. Tests: `tests/jest/quote-delete-response.test.js` + hardened DELETE round trips in `quote-sessions.test.js`/`quote-items.test.js`. The main app's forwarders handle the new 404 (ownership gate → idempotent `{success, alreadyGone}`).
**Prevention:** Read `RecordsAffected` on every Caspio write-with-where — 0 on a by-PK delete = 404, never fake success. Full entry: Pricing Index `memory/LESSONS_LEARNED.md` → "Caspio API Gotchas". NOTE: `orders.js`, `pricing.js`, `pricing-matrix.js` delete handlers still 200-on-0 (their `recordsAffected` is now at least accurate); align them if those endpoints ever get real consumers.

---

## Problem: Caspio multi-select List columns are unwritable via REST API
**Date:** 2026-05-09
**Symptoms:** POST `/tables/ArtRequests/records` with `Order_Type: 'Roland Stickers'` returns `InvalidInputValue: Cannot perform operation because the value doesn't match the data type of the following field(s): Order_Type` (500). Same for an array `["Roland Stickers"]`. Caspio's visual Triggered Action builder also hides multi-select fields from the assignment-target dropdown — even server-side triggers can't write them.
**Root cause:** Caspio's REST API and TA builder lack the internal encoding the DataPage UI uses for `List - String` columns. Reads return the dict shape `{'9': 'Roland Stickers'}`; writes need a wire format we can't produce from outside Caspio.
**Solution:** Parallel-column workaround. For `Order_Type` we added `Order_Type_Source` (Text 255). New REST forms (jds-submit-form, sticker-banner-submit-form) write `Order_Type_Source`; the legacy Garment DataPage continues to write `Order_Type`. Each record has exactly one populated; never both. Dashboard reads coalesce: `req.Order_Type || req.Order_Type_Source` in `art-hub-steve-gallery.js`, `art-ae.js`, `pages/js/art-request-detail.js`.
**Prevention:** **Do NOT include multi-select List columns in REST POST payloads — submissions will 500.** Same workaround pattern applies to any future List - String column. See MEMORY.md "Critical Patterns" → "CASPIO MULTI-SELECT WRITES".

---

## Problem: Caspio rejects unknown field names in POSTs with 404 FieldNotFound
**Date:** 2026-05-08
**Symptoms:** Form submissions 500 immediately when the payload includes a column name that doesn't exist on the target table. e.g., posting `Design_Name` to ArtRequests returns 404 FieldNotFound (no such column).
**Root cause:** Caspio strictly validates field names against the table schema. There's no partial-write or silent-skip — one unknown field rejects the whole insert.
**Solution:** Add the columns in Caspio admin BEFORE deploying any frontend that writes them. If you can't add columns first, gate the writes behind a feature flag or release in two stages (Caspio columns → frontend deploy).
**Prevention:** Always verify column existence with a `GET` query (`select=PK_ID,YourNewField&limit=1`) before adding write fields to any payload. Phase 2a/2b of the Phase 8 implementation plan documents this two-stage release pattern.

---

## Problem: Caspio POST returns 201 with empty body — needs follow-up SELECT to surface PK
**Date:** 2026-05-08
**Symptoms:** Backend `art.js` POST handler returns `response.data` from the Caspio insert, but `response.data` is empty. Frontend can't read the new PK_ID / ID_Design to render success links or fire downstream notifications.
**Root cause:** Caspio's `/tables/<Table>/records` POST is fire-and-forget. The 201 confirms the row was created but doesn't return the inserted record.
**Solution:** After the POST succeeds, do a SELECT with a fallback `where` chain to find the just-inserted record:
1. `Design_Num_SW + CompanyName` (legacy Garment DataPage)
2. `CompanyName + User_Email` (new REST forms)
3. `CompanyName` alone (last resort)
ORDER BY `PK_ID DESC LIMIT 1`. Return the fetched record at `result.record` in the response. Slack notification (`notifyArtRequestSubmission`) fires off the same fetched record.
**Prevention:** `art.js`'s `POST /artrequests` handler implements this pattern — copy it for any future Caspio-backed insert endpoint that needs to return the new PK.

---

## Problem: Caspio Files API rejects 409 FILE_EXISTS for any duplicate filename — Artwork folder is global
**Date:** 2026-05-08
**Symptoms:** AE uploads `40091 Braun NW Mock1 WF copy.jpg` to `/api/files/upload`, gets 409 FILE_EXISTS. Generic filenames collide across customers because the Caspio Artwork folder is global, not per-customer.
**Root cause:** Filename uniqueness is enforced globally on Caspio's Files API. Any file ever uploaded with that exact name (even months ago, from a different customer) blocks new uploads.
**Solution:** `files-simple.js` POST handler now retries once with a sortable timestamp suffix appended before the extension when 409 fires:
```
"40091 Braun NW Mock1 WF copy.jpg"
  → "40091 Braun NW Mock1 WF copy_2026-05-08T18-02-34-123.jpg"
```
Original names are preserved when there's no collision; only conflicts get the suffix.
**Prevention:** Don't rely on customer-specific naming for uniqueness. The retry-with-suffix pattern in `files-simple.js` handles it transparently. See `appendUniquenessSuffix()` for the implementation.

---

## Problem: Caspio Files API DELETE — only the path form works, and a 404 must not be an error
**Date:** 2026-06-18 (moved here from the auto-memory index 2026-07-29 — it was the only copy)
**Symptoms:** Orphan-cleanup calls to `DELETE /api/files/:externalKey` hard-failed. Errors were
undiagnosable because the route logged only `error.message`, never Caspio's real status or body.
**Root cause / verified semantics:** `files-simple.js` DELETE → Caspio
`DELETE /integrations/rest/v3/files/{externalKey}` is the **ONLY supported form** (path-style).
- **204 No Content** on success.
- **404 FileNotFound** when the file is already gone.
- The collection form `DELETE /files?externalKey=...` returns **405** — that collection allows
  only OPTIONS/GET/POST/PUT.
**Solution:** The route is **idempotent**: a 404 returns `{success:true, alreadyAbsent:true}`, so
cleanup of an already-deleted file never hard-fails — e.g. re-saving a Shirt Designer mockup over
a prior `ArtRequests.Rep_Mockup`. 30s timeout; network/timeout → 504 `DELETE_TIMEOUT`; every other
error now logs Caspio's real status + body.
**Gotcha:** `files-simple.js` uses the ROOT `config.js` (`CASPIO_ACCOUNT_DOMAIN=c3eku948`, where the
global Artwork folder `b91133c3-…` lives). `/api/health` reports `caspio.domain` from a *different*
config module and can show another/stale domain — that mismatch is not a Files-route bug, so don't
chase it.
**Prevention:** For any delete-shaped cleanup, treat "already absent" as success, and log the
upstream status+body rather than `error.message` alone.

---

## Problem: Box mockup images not showing in Art Hub / AE Hub
**Date:** 2026-04
**Symptoms:** Images uploaded to Box weren't displaying in Art Hub or AE Hub
**Root cause:** Direct Box file URLs aren't publicly accessible; they require authentication
**Solution:** Added a shared-image proxy endpoint and updated uploads to use proxy URLs instead of direct Box links (commit 0d2f3e6)
**Prevention:** Always use proxy URLs for Box-hosted images, never direct Box file links

---

## Problem: OGIO brand missing from product list
**Date:** 2025-12
**Symptoms:** API returns products but OGIO brand not included
**Root cause:** `makeCaspioRequest` doesn't handle pagination; OGIO was on page 2
**Solution:** Use `fetchAllCaspioPages` for all multi-record queries
**Prevention:** Added CRITICAL note to CLAUDE.md - Caspio Pagination section

---

## Problem: API usage exceeded 500K monthly limit
**Date:** 2025-12
**Symptoms:** 630K calls/month (26% over limit), Caspio throttling
**Root cause:** No caching, every page load made fresh API calls
**Solution:** Implemented caching: pricing bundle (15min), product search (5min), etc.
**Prevention:** Added API Usage Tracking system, `/api/admin/metrics` endpoint

---

## Problem: WSL can't connect to local server
**Date:** 2025
**Symptoms:** `localhost:3002` not accessible from Windows browser
**Root cause:** WSL uses different network interface than Windows
**Solution:** Use WSL IP address (`hostname -I`) instead of localhost
**Prevention:** Documented in LOCAL_DEVELOPMENT.md

---

## Problem: Incomplete data returned from Caspio
**Date:** 2025
**Symptoms:** Some records missing, data appears truncated
**Root cause:** Caspio paginates at 1000 records, only first page returned
**Solution:** Always use `fetchAllCaspioPages`, never `makeCaspioRequest` for lists
**Prevention:** CRITICAL warning in CLAUDE.md

---

## Template for New Entries

```markdown
## Problem: [Brief description]
**Date:** YYYY-MM
**Symptoms:** What the bug looked like to users/developers
**Root cause:** What was actually wrong
**Solution:** How we fixed it
**Prevention:** How to avoid this in future (rule added, pattern documented, etc.)
```
