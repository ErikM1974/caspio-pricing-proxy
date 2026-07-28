# API Usage Tracking & Optimization

**Version**: 1.3.0
**Deployed**: 2025-11-29 (Heroku v201) · wave 2 2026-07-18 · wave 3 2026-07-26
**Updated**: 2026-07-26
**Status**: Production

## Wave 3 — 2026-07-26 (the $358 overage: fix the METER first)

Invoice **AI-334269-26072026** billed **178,874 calls over the 500K cap**
(689.8K used, **$0.002/call** ⇒ **1,000 calls/day saved = $60/period**). Wave 2's
fixes landed, but the daily rate never came down — ~20-23K/day against a budget
of **16,667/day**, because new dashboards shipped 7/19–7/25 absorbed the savings.

**The meter had been lying, which is why this recurred.** Three blind spots:

1. Only `makeCaspioRequest`/`fetchAllCaspioPages` counted — the **~236
   direct-axios call sites across 41 route files** (every write),
   `putWithRecordsAffected`, and all **four** OAuth token caches were invisible.
2. `path.split('/').pop().replace('/records','')` returns the literal
   `"records"` for every `/tables/X/records` URL, so the whole breakdown was one
   row named `records`. **Per-table attribution had never worked.**
3. Only a top-5 was exposed; counters are in-memory **per-dyno** and reset on
   every cycle.

**Now**: a global **axios request interceptor** on `*.caspio.com` is the single
counting path (`src/utils/api-tracker.js`) — a new route cannot bypass it by
using axios directly. Counts at request time (Caspio bills 400s and the
400-retry's extra request). `GET /api/admin/metrics?full=1` returns the complete
`callsByTable`/`callsByEndpoint`/`callsByMethod` plus `processUptimeMs`, and the
route is now behind `requireCrmApiSecret` (it was **unauthenticated**).
Optional hourly rollup to Caspio via `API_USAGE_ROLLUP_TABLE`
(`src/utils/api-usage-rollup.js`) — off unless the env var is set.

**Measured 2026-07-26 (hard row counts, not estimates):**

| Table | Rows | Pages @1000 | Note |
|---|---|---|---|
| `Shopworks_Thumbnail_Report` | 27,613 | 27 + 28 | scanned **twice per run**, every 20 min — see the cost model below |
| `Sanmar_Bulk_251816_Feb2024` | 251k | — | ~22-26% of all calls |
| `Supacolor_Jobs` | 1,035 | 2 | full scan every 10 min |
| `ArtRequests` | 2,694 | 3 | was queried **once per design id** |
| `Quote_Sessions` | **8** | 1 | ← far smaller than assumed; see below |

Changes: `ttl-cache` **FIFO → LRU** (a read now protects an entry; ~20 PDP views
used to flush the whole `product-details` cache); `products/search` moved onto
the shared cache, **50 → 400** entries, and is finally in the `clearAll()`
registry (`/product-cache/clear` never flushed it); `/supacolor-jobs/stats`
cached 120 s; `/supacolor-jobs/sync/all` capped to one real sync per 30 min
(`?bypassCadence=true` to force); `/api/artrequests?id_designs=1,2,3` batch
filter replaces an N+1; `/api/quote_sessions` gained named cron filters and now
**rejects** `q.where` instead of silently ignoring it.

⚠️ **Do NOT raise `product-details` / `inventory` maxEntries without measuring.**
Responses are **0.8–1.5 MB** and **1.5–3.1 MB per style** respectively (PC54
alone: 1.54 MB / 3.08 MB). `product-details` at 400 entries would be ~500 MB and
would OOM the dyno — it is capped at 150, `inventory` stays at 50. Real headroom
needs a `q.select` so those rows stop coming back full-width.

**Correction to the wave-2 note below**: it tells you to verify via
`GET /api/admin/metrics` (`callsByTable`). **That field did not exist** until
wave 3 — use `?full=1` (and the secret header) now.

## Scheduler cadence: check-transfers-received 10 min → Hourly at :20 (2026-07-28)

144 one-off dynos/day → 24. Each run costs a FIXED 2 Caspio calls (a cold OAuth
token + one filtered `PurchaseOrders` read) whether or not a transfer arrived, so
288 → 48 calls/day, **saving ~240/day ≈ $14.40/period**.

Why hourly and not daily (Erik was happy with daily): the cost is fixed *per
run*, so hourly already captures **84%** of the available saving and daily adds
only ~$2.76/period more while making the alert **20× slower** (≈75 min worst case
→ ≈24 h). Same flat-savings-curve arithmetic as the thumbnail sync.

Why **:20** specifically: `:00` and `:30` each already carry two hourly jobs, and
Caspio's per-second burst limit is the hard one — don't stack them. `:20` also
lands ~5 min after bandit's :15 PO sync, so it reads fresh data. The old 10-min
cadence was pointless anyway: `date_Received` only reaches Caspio via that
15-minute bandit sync, so ~1 poll in 3 could not possibly see anything new.

⚠️ Heroku Scheduler has **no CLI** — jobs are dashboard-only, and its minute
picker offers only :00/:10/:20/:30/:40/:50.

## 🔴 Two things that made this meter under-report (both fixed 2026-07-28)

Reconciling against Caspio's own chart showed a persistent 30-40% shortfall
(23,959 billed vs 16,055 measured on 27 Jul). It was **not** an unknown
integration — it was two of our own bugs. Ruled out along the way, so nobody
re-treads it: Caspio DataPages consume **no** Integrations calls; Python
Inksoft's Caspio endpoints are not being hit; the main app's runtime goes
through the proxy; nothing uses `fetch`/raw HTTP to reach Caspio; Caspio has
**no per-request REST log** (its "Integrations" log is webhook deliveries,
newest entry 08 May, all dead Zapier hooks returning 410); and the account has
exactly **ONE active API profile** (`ProdDetailsAPI`), so there is no second
consumer with its own credentials.

**1. Heroku Scheduler jobs are ONE-OFF DYNOS.** Every `npm run sync-*` job runs
in its own dyno that lives for seconds and exits via `process.exit(0)`. The
rollup flushed on a 60-minute `setInterval`, so it never fired there and SIGTERM
never arrived — `API_Usage_Daily` held `web.1` rows and **nothing else**, hiding
~30% of all traffic. Fixed by flushing on a **call-count threshold**
(`FLUSH_EVERY_CALLS = 250`) instead of a timer, making writes **append-only
deltas** (no read, and no read-modify-write race between concurrent dynos), and
auto-starting the rollup from `api-tracker` so any process that talks to Caspio
records — scheduler scripts never load `server.js`, which is why `start()` was
never called there.

**2. Caspio buckets usage on the ACCOUNT CLOCK, not UTC.** Its Integrations log
column header reads literally `Log date (UTC-07:00)`. We keyed days on UTC, so
our "28 Jul" began at **5 PM Pacific on the 27th** — every day-to-day comparison
against their chart was apples-to-oranges, and the offset was large enough to
look like thousands of missing calls. `src/utils/account-time.js` is now the one
definition of "what day is it" (DST-aware `America/Los_Angeles`), used by the
tracker, the rollup **and** the period window. They must agree: the rollup looks
days up by the tracker's own key, so a mismatch silently reads a day that was
never written.

**Rule for next time: before reconciling your number against a vendor's, match
their clock — check the timezone on their own log/report headers first.**

## Thumbnail sync cost model (measured 2026-07-26) — the single biggest line item

`Shopworks_Thumbnail_Report` was **48% of ALL Caspio traffic**: 909 of 1,883 calls
in a 4.3-hour window (~211/hr). Two bandit tasks touch it, and the split is not
what the name suggests:

| Task | Cadence | Runs/day | Caspio calls/day |
|---|---|---|---|
| **Thumbnail Box Sync** (images → Box) | 20 min | 72 | **3,960** |
| Thumbnail Metadata Sync (ODBC → rows) | 30 min | 48 | ~48 (mostly heartbeats) |

**The Box sync is effectively the whole cost.** It pays **55 calls before moving a
single byte** — `/thumbnails/uploaded-ids` (27 pages; the `FileUrl IS NOT NULL`
filter drops ~674 imageless rows) + `/thumbnails/all-ids` (28 pages). Variable cost
is 2 calls per image uploaded (existence GET + `FileUrl` PUT), capped at
`MaxFilesPerRun 200`. Steady state is **~5 changed thumbnails/day**, so this is
**~800 Caspio calls per image actually synced**.

**The metadata sync is nearly free — its delta read is ODBC against FileMaker, 0
Caspio calls.** Per run it costs 1 heartbeat PUT on `Sync_Heartbeats` (per HTTP
chunk of 50, not per run), plus 1 PUT per changed row / 2 for a new one. Do not
"optimise" it: it is the **record-creator** (`upload-with-stub` 404s
`RECORD_NOT_FOUND` because `Thumb_DesLocid_Design` is UNIQUE NOT NULL), so it must
run ahead of the image sync, and its overlap already has zero slack at 30/30.

**Fix (pending on bandit): `schtasks /Change /TN "\NWCA\Thumbnail Box Sync" /RI 240`**
→ 6 runs/day, 330 calls/day, saving ~3,630/day ≈ $218/period. Cost is *fixed per
run*, so 72→6 captures 92% of the available saving and going to once-daily adds
only ~$16/period more — not worth a 24-hour worst case. After the change expect
**~14 calls/hour** on this table instead of ~211.

🔴 **Never "delta-filter" `uploaded-ids` or `all-ids` to shrink them.** Both are
consumed as **completeness/existence sets** — the agent skips a file only when its
ID is present in the returned set. Truncate either and every older row reads as
un-uploaded, re-uploading ~27k images to Box. This already happened once from
silent `maxPages:20` truncation (2026-07-18: ~6,900 rows re-uploaded, Box dupes +
`FileUrl` churn). The safe delta signal the script already has for free is **file
mtime on the share** — narrow the file list first, then ask Caspio about only
those IDs.

### Wave 3b — the alert and the attribution page (2026-07-26)

Repairing the meter fixed *measurability*. It did not fix the reason the $358
bill was a **surprise**: for 30 days nothing looked at the number. A dashboard
alone would not have either — it needs someone to remember to open it, which is
exactly what failed. So the alert came first.

**Pacing alert** — `POST /api/admin/usage/alert` (secret-gated), driven by
`scripts/check-caspio-usage.js` via **Heroku Scheduler, daily**
(`npm run check-caspio-usage`). Same idiom as the ODBC watchdog: the *endpoint*
computes, dedupes (20 h) and DMs Erik; the script only reports and exits 1.
`GET /api/admin/usage` returns the same pacing without notifying (powers the page).

Maths lives in `src/utils/caspio-usage-pacing.js` — pure, clock-injected, 24 tests.

- **Caspio's period is the 27th → the 26th, and its LENGTH VARIES (28–31 days)
  while the 500K cap does not.** Daily budget is `500000 ÷ daysInPeriod`
  (16,667 in a 30-day period, 16,129 in a 31-day one) — never hardcode 16,667.
- **Fires at 90%, not 100%** — at 100% the overage is already being billed.
- **Three modes, and the message always says which:**
  - `rollup` — summed across dynos from `API_Usage_Daily`. Trustworthy.
  - `dyno` — one dyno since its last restart. Labelled a **LOWER BOUND**.
  - `insufficient` — **uptime < 1 h ⇒ refuses to project at all.** Found in
    testing: a dyno 8 seconds old with 6 calls extrapolated to 1,300,661
    (260% of cap). A daily cron can easily land on a just-cycled dyno, so
    without this guard the alert would cry wolf. Saying "I can't tell yet" is
    the honest output.

**Attribution page** — `/dashboards/api-usage.html` (pricing-index repo),
admin-only via a `Staff_Page_Access` row. Reads through the app's
`/api/crm-proxy/admin/{metrics,usage}` forwarders so the secret stays server-side.
Shows the budget meter, top tables/endpoints with share bars (≥20% flagged),
calls by method, and the daily trend. It states its own scope on the page and
names **Caspio → Plan and billing → Usage** as the billing authority — it is an
attribution tool, deliberately not a billing gauge.

Render harness (no SAML needed): `/tests/ui/test-api-usage.html?scenario=rollup|dyno|insufficient|error`.
⚠️ That harness stubs `fetch` wholesale, so it **cannot** catch an unregistered
route. Probe those live instead — `401/403 = registered, 404 = not`, checked
against a deliberately fake path so the probe is proven to discriminate.

## Wave 2 — July 2026 (per-style endpoint caching)

July 2026 blew the quota again (507K/500K by day 22; ~100K one-off backfills but
recurring baseline ≈18K/day ≈ 545K/mo by itself). Root cause: the per-style
product endpoints were never cached — a PDP view cost ~13 Caspio calls. Fix
(shared `src/utils/ttl-cache.js` + `src/utils/caspio-static-tables.js`):

- **Cached (15 min, `?refresh=true` bypass)**: `/api/size-pricing`,
  `/api/max-prices-by-style`, `/api/base-item-costs`, `/api/product-colors`,
  `/api/color-swatches`, `/api/sizes-by-style-color` (style-keyed size run);
  10 min: `/api/inventory` (memory-heavy rows), `/api/product-details`
  (pre-`applyProductCopy` snapshot — copy overlay applied per request);
  60 s: `/api/stylesearch` (per-keystroke LIKE scan).
- **Static tables cached 1 h process-wide**: `Standard_Size_Upcharges` +
  `Size_Display_Order` (were re-fetched in full on every pricing/size call,
  incl. inside `/api/pricing-bundle`).
- **Dead `/tables/Inventory` probe removed** from `/api/sizes-by-style-color`
  (404'd on 100% of calls since 2026-06-18 — one doomed Caspio call per request).
- **Rule 4 held**: expired cache never served; errors propagate; degraded
  payloads (SanMar active-color filter down, upcharge fetch failed, empty
  results) are served but never cached.
- **Flush**: `GET /api/product-cache/clear` (per-dyno) or per-request
  `?refresh=true`. Injection guards: `sanitize()||raw` fallbacks removed
  (pricing-bundle style query, getStyleSizeRun); raw interpolations sanitized
  in products.js/inventory.js.
- Tests: `tests/jest/{ttl-cache,pricing-cache-routes,product-colors-cache,sizes-by-style-color-route}.test.js` (hermetic, mocked Caspio).

Verify impact via `GET /api/admin/metrics?full=1` (secret-gated; the bare
`callsByTable` this line originally referenced never existed — see wave 3):
expect Sanmar_Bulk sharply down, Standard_Size_Upcharges + Size_Display_Order →
~24-50/day, `/tables/Inventory` → 0. Companion frontend work (same date,
pricing-index repo): dashboard pollers pause when tab hidden; hourly quote
bulk-sync got age-based backoff + cancelled-row exclusion.

## Results Summary (December 2025)

| Metric | Before (Nov 2025) | Expected | Actual (Dec 2025) |
|--------|-------------------|----------|-------------------|
| Monthly calls | 630K | 400-440K | **~280K projected** |
| % of limit | 126% (OVER) | 80-88% | **~56%** |
| Reduction | - | 30-40% | **~55-60%** |

**Current Period (Nov 27 - Dec 26, 2025):**
- Day 21 of 30: 196K calls used
- Daily average: ~9,333 calls/day
- Projected total: ~280K calls
- Status: Well under 500K limit

## Overview

Comprehensive API call tracking and caching system to monitor and reduce Caspio API usage. Implemented to address excessive API consumption (630K/month vs 500K limit).

## Problem Solved

**Before Implementation (November 2025):**
- Usage: 630K+ API calls/month (26% over 500K limit)
- No visibility into which endpoints/tables consumed calls
- No caching on high-traffic endpoints
- Estimated 7-9 Caspio calls per `/api/pricing-bundle` request

**After Implementation (December 2025):**
- Real-time tracking of all API calls
- Caching on high-traffic endpoints (5 cached endpoints)
- Metrics dashboard for monitoring usage
- **Actual 55-60% reduction** (from 630K → ~280K/month projected)

## Components

### 1. API Tracker Utility

**File**: [`src/utils/api-tracker.js`](../src/utils/api-tracker.js)

Singleton class that tracks all Caspio API calls in memory:

```javascript
const apiTracker = require('./src/utils/api-tracker');

// Automatically tracks calls via caspio.js
apiTracker.trackCall(endpoint, table, method, metadata);

// Get real-time summary
const summary = apiTracker.getSummary();
// Returns: {todayCount, last24hCount, monthlyProjection, ...}
```

**Features:**
- 24-hour rolling window (older entries auto-cleaned every 5 minutes)
- Tracks by endpoint, table, hour, and day
- Monthly projection based on current pace
- Automatic status alerts (OK, WARNING, CRITICAL, OVER_LIMIT)

**Memory Management:**
- Stores last 24 hours of call data
- Cleans up hourly stats older than 48 hours
- Cleans up daily stats older than 30 days
- Minimal memory footprint (~1-2MB for typical usage)

### 2. Automatic Call Tracking

**File**: [`src/utils/caspio.js`](../src/utils/caspio.js)

All Caspio API requests are automatically tracked:

**In `makeCaspioRequest()`** (lines 78-83):
```javascript
// Track API call
const tableName = resourcePath.split('/').pop().replace('/records', '');
apiTracker.trackCall(resourcePath, tableName, method, {
  status: response.status,
  recordCount: response.data?.Result?.length || (response.data ? 1 : 0)
});
```

**In `fetchAllCaspioPages()`** (lines 170-175):
```javascript
// Track this API call
const tableName = resourcePath.split('/').filter(p => p).pop().replace('/records', '');
apiTracker.trackCall(resourcePath, tableName, 'GET', {
  page: pageCount,
  recordCount: response.data?.Result?.length || 0
});
```

**Console Output:**
```
[API TRACKER] GET Sanmar_Bulk_251816_Feb2024 - Total today: 142
```

### 3. Metrics Endpoint

**Endpoint**: `GET /api/admin/metrics`
**Live URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/metrics`

**Response Structure:**
```json
{
  "success": true,
  "data": {
    "todayCount": 1234,
    "last24hCount": 1456,
    "monthlyProjection": 43680,
    "monthlyLimit": 500000,
    "percentOfLimit": 8,
    "status": "OK",
    "topEndpoints": [
      {"endpoint": "/tables/Sanmar_Bulk_251816_Feb2024/records", "count": 456},
      {"endpoint": "/tables/Pricing_Tiers/records", "count": 123}
    ],
    "topTables": [
      {"table": "Sanmar_Bulk_251816_Feb2024", "count": 456},
      {"table": "Pricing_Tiers", "count": 123}
    ]
  },
  "message": "Tracking 1,234 calls today. Monthly projection: 43,680 / 500,000 (8%)"
}
```

**Status Levels:**
- `OK`: <80% of limit (< 400K/month)
- `WARNING`: 80-90% of limit (400K-450K/month)
- `CRITICAL`: 90-95% of limit (450K-475K/month)
- `OVER_LIMIT`: >100% of limit (>500K/month)

## Caching Implementation

### Summary of All Caches

| Cache | Endpoint | TTL | Savings | Max Size |
|-------|----------|-----|---------|----------|
| Pricing Bundle | `/api/pricing-bundle` | 15 min | 7-9 calls/req | 100 |
| Product Search | `/api/products/search` | 5 min | 2 calls/req | 50 |
| New Products | `/api/products/new` | 5 min | 1+ calls/req | - |
| Top Sellers | `/api/products/topsellers` | 5 min | 1+ calls/req | - |
| Quote Sessions | `/api/quote_sessions` | 5 min | 1+ calls/req | - |

### Pricing Bundle Cache (Highest Impact)

**Endpoint**: `/api/pricing-bundle`
**File**: [`src/routes/pricing.js`](../src/routes/pricing.js) (lines 7-9, 361-371, 753-764)
**Impact**: **7-9 API calls → 0 calls (cache hit)** - BIGGEST SAVINGS
**TTL**: 15 minutes

**Before Caching:**
Each request made 7-9 calls to Caspio:
1. Pricing_Tiers
2. Pricing_Rules
3. Location table
4. Cost table (DTG/EMB/SP)
5. Size_Display_Order
6. Standard_Size_Upcharges
7. Sanmar_Bulk (if styleNumber provided)
8. Additional queries for specific methods

**After Caching:**
- First request: 7-9 calls (cache miss, sets cache)
- Subsequent requests (within 15 min): 0 calls (cache hit)
- Cache is parameter-aware: different method/styleNumber = different cache entry

**Cache Bypass:**
```bash
# Force refresh (bypass cache)
GET /api/pricing-bundle?method=DTG&styleNumber=PC54&refresh=true
```

### Product Search Cache

**Endpoint**: `/api/products/search`
**File**: [`src/routes/products.js`](../src/routes/products.js) (lines 8-10, 367-377, 781-792)
**Impact**: **2 API calls → 0 calls (cache hit)**
**TTL**: 5 minutes

**Before Caching:**
Each search made 2 calls:
1. Initial query for styles (groupBy STYLE)
2. Detailed query for variants (full records)

**After Caching:**
- First search: 2 calls (cache miss)
- Subsequent identical searches (within 5 min): 0 calls (cache hit)
- Shorter TTL due to many parameter combinations

### Additional Caches

**New Products** (`/api/products/new`):
- File: `src/routes/products.js` (lines 846-931)
- TTL: 5 minutes
- Object-based cache with parameter tracking

**Top Sellers** (`/api/products/topsellers`):
- File: `src/routes/products.js` (lines 1333-1402)
- TTL: 5 minutes
- Object-based cache with parameter tracking

**Quote Sessions** (`/api/quote_sessions`):
- File: `src/routes/quotes.js` (lines 31-33)
- TTL: 5 minutes
- Added December 2025 with filter parameter fix

### Token Caching

**Caspio Access Token** (server-level):
- File: `src/utils/caspio.js`
- Caches OAuth token with 60-second expiry buffer
- Prevents OAuth call on every request

**ManageOrders Token**:
- File: `src/utils/manageorders.js`
- TTL: 1 hour
- Reduces authentication overhead

## Monitoring Workflow

### Initial 48 Hours (Phase 1)

**Goal**: Collect baseline usage data

1. Monitor `/api/admin/metrics` every few hours
2. Watch for `topEndpoints` and `topTables` to identify patterns
3. Check `monthlyProjection` to ensure trending toward <500K
4. Look for any unexpected high-volume endpoints

**Example Check:**
```bash
# Check current usage
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/metrics

# Expected to see:
# - todayCount: < 16,666 (target daily rate for 500K/month)
# - monthlyProjection: < 450K (with safety margin)
# - status: "OK" or "WARNING"
```

### Week 1 Analysis (Phase 2)

**Goal**: Identify additional optimization opportunities

1. Review top 5 endpoints by call count
2. Identify endpoints without caching that should have it
3. Check for any polling patterns (same endpoint called frequently)
4. Validate cache hit rates are improving over time

**Questions to Answer:**
- Which endpoints consume most calls?
- Are there new caching opportunities?
- Is any endpoint being polled excessively?
- Are specific tables/brands driving high usage?

### Ongoing Monitoring (Phase 3)

**Goal**: Maintain usage under 450K/month

1. Check metrics dashboard weekly
2. Set up alerts at 80% threshold (400K projected)
3. Document any usage spikes and root causes
4. Adjust cache TTLs based on actual usage patterns

## Actual Impact (December 2025)

### Results vs Projections

| Estimate | Projected | Actual |
|----------|-----------|--------|
| Conservative | 440K (30% reduction) | - |
| Optimistic | 380K (40% reduction) | - |
| **Actual** | - | **~280K (55-60% reduction)** |

### Why Results Exceeded Expectations

1. **Higher cache hit rates than estimated** - Real-world usage patterns favor repeated queries
2. **Pricing bundle cache had massive impact** - 15-min TTL covers most user sessions
3. **Product search cache effective** - Users often search same products repeatedly
4. **Token caching eliminated OAuth overhead** - Prevents token refresh on every request
5. **Multiple endpoints cached** - Cumulative effect of 5+ cached endpoints

### Original Calculations (For Reference)

**Pricing Bundle** (assuming 5,000 requests/month):
- Before: 5,000 requests × 8 calls = 40,000 API calls
- After (80% cache hit rate): (5,000 × 20% × 8) + (5,000 × 80% × 0) = 8,000 API calls
- **Savings**: 32,000 calls/month

**Product Search** (assuming 10,000 requests/month):
- Before: 10,000 requests × 2 calls = 20,000 API calls
- After (70% cache hit rate): (10,000 × 30% × 2) + (10,000 × 70% × 0) = 6,000 API calls
- **Savings**: 14,000 calls/month

**Actual savings exceeded these estimates significantly.**

## Future Optimization Opportunities

### Additional Caching Candidates

Based on plan analysis, these endpoints should be cached next:

1. **Pricing Reference Endpoints** (1-hour TTL):
   - `/api/pricing-tiers` - Static reference data
   - `/api/embroidery-costs` - Monthly changes
   - `/api/dtg-costs` - Monthly changes
   - `/api/screenprint-costs` - Monthly changes
   - `/api/pricing-rules` - Monthly changes

2. **Product Catalog Endpoints** (30-min TTL):
   - `/api/products-by-brand` - SanMar monthly updates
   - `/api/products-by-category` - SanMar monthly updates
   - `/api/products-by-subcategory` - SanMar monthly updates

3. **Reference Lists** (1-hour TTL):
   - `/api/all-brands` - Rarely changes
   - `/api/all-categories` - Rarely changes
   - `/api/all-subcategories` - Rarely changes

### Advanced Optimizations

**If monitoring reveals need:**
- Request deduplication (same request in flight multiple times)
- Pre-aggregation for expensive queries
- Extended cache for YoY dashboard (currently 60 seconds)
- Conditional feature flags (disable rarely-used expensive features)

## Troubleshooting

### Cache Not Working

**Symptoms:**
- Still seeing `[CACHE MISS]` on repeated requests
- No reduction in API call count

**Checks:**
1. Verify parameters are identical (cache is parameter-aware)
2. Check TTL hasn't expired (15 min for pricing, 5 min for search)
3. Confirm cache size limit not evicting entries too quickly
4. Look for `?refresh=true` parameter bypassing cache

### High Memory Usage

**Symptoms:**
- Heroku dyno memory warnings
- Slow response times

**Checks:**
1. Check cache sizes (should be <100 entries)
2. Verify cleanup is running (every 5 minutes)
3. Review `apiTracker` stats (should only keep 24 hours)

### Metrics Not Updating

**Symptoms:**
- `/api/admin/metrics` showing 0 calls
- No `[API TRACKER]` logs

**Checks:**
1. Verify deployment succeeded (check Heroku releases)
2. Confirm API traffic is actually happening
3. Check server logs for errors in `api-tracker.js`

## Files Modified/Created

**New Files:**
- `src/utils/api-tracker.js` - API call tracking utility

**Modified Files:**
- `src/utils/caspio.js` - Added tracking to both API functions
- `src/routes/pricing.js` - Added pricing-bundle cache
- `src/routes/products.js` - Added product search cache
- `server.js` - Added /api/admin/metrics endpoint

**Deployment:**
- Commit: 9fef725c
- Heroku Release: v201
- Deployed: 2025-11-29 13:11 UTC

## Related Documentation

- [Local Development Guide](LOCAL_DEVELOPMENT.md) - Running/testing locally
- [Caspio API Analysis Plan](../C:\Users\erik\.claude\plans\adaptive-squishing-neumann.md) - Full optimization plan

## Summary

This implementation provides:
- ✅ Real-time visibility into API usage
- ✅ Automatic tracking with zero overhead
- ✅ **High-impact caching (55-60% actual reduction achieved)**
- ✅ Metrics dashboard for ongoing monitoring
- ✅ Foundation for data-driven optimization

**Current Status (December 2025):**
- API usage well under control (~280K projected vs 500K limit)
- No immediate action needed
- Continue monitoring via `/api/admin/metrics`

**Maintenance:**
1. Check `/api/admin/metrics` weekly
2. Watch for unusual spikes in daily usage
3. If usage increases, consider extending cache TTLs
4. Future optimizations available if needed (see "Future Optimization Opportunities")
