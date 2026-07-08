# Lessons Learned

A running log of problems solved and gotchas discovered. Add new entries at the top.

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
