/**
 * Enrich CompanyContactsMerge2026 with ManageOrders historical data.
 *
 * Reads a Caspio CSV export, groups by id_Customer, fetches each customer's
 * orders from ManageOrders (cached per-customer on disk), matches contacts
 * to orders by email (lowercase exact), computes phone history + preferred
 * terms + order counts, then writes an enriched CSV ready to re-import
 * into Caspio via "Update existing records" keyed on ID_Contact.
 *
 * --- Usage ---
 *
 *   # Dry run on 20 random active-with-email rows (fast, ~1 min):
 *   node scripts/enrich-contacts-from-manageorders.js --dry-run
 *
 *   # Full run (30-60 min, resumable):
 *   node scripts/enrich-contacts-from-manageorders.js
 *
 *   # Force-refresh ManageOrders cache (use sparingly):
 *   node scripts/enrich-contacts-from-manageorders.js --no-cache
 *
 *   # Retry only the rows that timed out on a previous run:
 *   node scripts/enrich-contacts-from-manageorders.js --retry-timeouts
 *
 * --- Files ---
 *
 *   Input:  ~/Downloads/CompanyContactsMerge2026_*.csv
 *           (latest mtime — script picks the newest by default;
 *            override with --input <path>)
 *
 *   Output: ~/Downloads/CompanyContactsMerge2026_enriched_<YYYY-MM-DD>.csv
 *
 *   Cache:  scripts/.cache/manage_orders/<id_Customer>.json
 *           (per-customer order arrays, 24h TTL)
 *
 *   Report: ~/Downloads/CompanyContactsMerge2026_enrichment_report_<YYYY-MM-DD>.txt
 *
 *   Checkpoint: scripts/.cache/enrichment_processed.txt
 *               (resumability — append id_Customer after success)
 *
 * --- Caspio re-import ---
 *
 *   Caspio Datasheet → Import → choose enriched CSV →
 *   "Update existing records" mode → key on ID_Contact column.
 *   Only the 7 new columns get overwritten in Caspio; existing data stays.
 *
 * --- Defenses against ManageOrders flakiness ---
 *
 *   - 30s per-request timeout
 *   - 3 retries with exponential backoff (2s, 4s, 8s)
 *   - 5 consecutive timeouts → 60s circuit-breaker pause
 *   - 200ms throttle between calls (gentle to MO)
 *   - Per-customer disk cache → re-runs skip already-fetched customers
 *   - Per-row checkpoint → script can resume after Ctrl-C / crash
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const API_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const CACHE_DIR = path.join(__dirname, '.cache', 'manage_orders');
const CHECKPOINT_FILE = path.join(__dirname, '.cache', 'enrichment_processed.txt');

// 24-month window for "recent" order history.
const MONTHS_BACK = 24;

// Pacing — adaptive. Starts gentle, slows further on 429s, recovers on success streaks.
const THROTTLE_MS_START = 750;       // initial throttle between MO requests (was 200, MO rate-limits below this)
const THROTTLE_MS_MAX = 5000;        // upper cap on adaptive throttle (5s/request worst case)
const THROTTLE_MS_MIN = 400;         // lower cap — never go faster than this even on success streaks
const SUCCESS_STREAK_TO_SPEED_UP = 30; // halve throttle after this many consecutive successes
const REQUEST_TIMEOUT_MS = 30_000;   // per request
const MAX_RETRIES = 5;               // bumped from 3 — 429s benefit from extra retries
const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000]; // longer backoffs for 429s
const RATE_LIMIT_PAUSE_MS = 60_000;  // pause this long on hard 429 (after retries exhausted) before continuing

// Phone history cap
const MAX_PHONE_HISTORY = 5;

// CLI flags
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_CACHE = args.includes('--no-cache');
const RETRY_TIMEOUTS_ONLY = args.includes('--retry-timeouts');
// 2026-05-20: full runs now skip Is_Active=0 (dormant/dead) rows by default.
// Cuts the work surface ~50% and gets a usable enriched CSV in one sitting.
// Use --include-inactive to process ALL rows (the original behavior, ~14h on a 429-stingy day).
const INCLUDE_INACTIVE = args.includes('--include-inactive');
const INPUT_OVERRIDE = (() => {
    const i = args.indexOf('--input');
    return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
})();

// ----- Helpers -------------------------------------------------------------

function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function findLatestInputCsv() {
    if (INPUT_OVERRIDE) return INPUT_OVERRIDE;
    const files = fs.readdirSync(DOWNLOADS)
        .filter((f) => /^CompanyContactsMerge2026_.*\.csv$/i.test(f) && !/_enriched_/i.test(f))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(DOWNLOADS, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) {
        throw new Error(`No CompanyContactsMerge2026_*.csv found in ${DOWNLOADS}. Export from Caspio first.`);
    }
    return path.join(DOWNLOADS, files[0].name);
}

// Robust CSV parser that handles quoted fields with embedded commas + newlines.
function parseCsv(text) {
    // Strip UTF-8 BOM if present
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else { inQuotes = false; }
            } else {
                cell += c;
            }
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { row.push(cell); cell = ''; }
            else if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
            else if (c === '\r') { /* skip */ }
            else cell += c;
        }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0];
    const records = rows.slice(1).filter((r) => r.length === headers.length && r.some((v) => v !== ''))
        .map((r) => {
            const obj = {};
            headers.forEach((h, i) => { obj[h] = r[i] != null ? r[i] : ''; });
            return obj;
        });
    return { headers, records };
}

function writeCsv(filePath, headers, records) {
    const escape = (v) => {
        if (v == null) return '';
        const s = String(v);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };
    const lines = [headers.map(escape).join(',')];
    for (const r of records) {
        lines.push(headers.map((h) => escape(r[h])).join(','));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: controller.signal });
        return r;
    } finally {
        clearTimeout(t);
    }
}

// ----- ManageOrders fetcher with retry + cache + adaptive throttle ---------
//
// Adaptive throttle protocol (added 2026-05-20 after Erik's first full-run
// attempt got HTTP 429 storms starting at customer #31):
//   - Start at THROTTLE_MS_START (750ms)
//   - On any HTTP 429: DOUBLE current throttle (up to THROTTLE_MS_MAX), pause
//     longer than normal backoff, retry
//   - On SUCCESS_STREAK_TO_SPEED_UP consecutive successes: halve throttle
//     (down to THROTTLE_MS_MIN floor)
//   - On HARD 429 (all retries exhausted): pause RATE_LIMIT_PAUSE_MS (60s)
//     before returning the timeout signal. Lets MO's rate limiter cool down
//     before we continue to the next customer.

let currentThrottleMs = THROTTLE_MS_START;
let successStreak = 0;
let consecutiveTimeouts = 0;

function adaptOnSuccess() {
    successStreak++;
    if (successStreak >= SUCCESS_STREAK_TO_SPEED_UP && currentThrottleMs > THROTTLE_MS_MIN) {
        const old = currentThrottleMs;
        currentThrottleMs = Math.max(Math.floor(currentThrottleMs / 2), THROTTLE_MS_MIN);
        successStreak = 0;
        console.log(`  ↑ ${SUCCESS_STREAK_TO_SPEED_UP} successes — throttle ${old}ms → ${currentThrottleMs}ms`);
    }
    consecutiveTimeouts = 0;
}

function adaptOn429() {
    successStreak = 0;
    if (currentThrottleMs < THROTTLE_MS_MAX) {
        const old = currentThrottleMs;
        currentThrottleMs = Math.min(currentThrottleMs * 2, THROTTLE_MS_MAX);
        console.log(`  ↓ HTTP 429 — throttle ${old}ms → ${currentThrottleMs}ms`);
    }
}

async function fetchCustomerOrders(idCustomer) {
    ensureDir(CACHE_DIR);
    const cacheFile = path.join(CACHE_DIR, `${idCustomer}.json`);

    // Read from disk cache if present and < 24h old
    if (!NO_CACHE && fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        const ageMs = Date.now() - stat.mtime.getTime();
        if (ageMs < 24 * 60 * 60 * 1000) {
            try {
                return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            } catch { /* re-fetch */ }
        }
    }

    const url = `${API_BASE}/api/manageorders/orders?id_Customer=${encodeURIComponent(idCustomer)}`;

    let last429 = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const r = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

            // ---- HTTP 429 — rate limited. Slow down + retry with long pause.
            if (r.status === 429) {
                last429 = true;
                adaptOn429();
                if (attempt < MAX_RETRIES - 1) {
                    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
                    console.log(`  ⏸  429 backoff (attempt ${attempt + 1}/${MAX_RETRIES}) — sleeping ${wait / 1000}s`);
                    await sleep(wait);
                    continue;
                }
                // All retries exhausted on 429 — pause hard then give up on this customer
                console.warn(`  ⏸  429 exhausted retries — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s before continuing`);
                await sleep(RATE_LIMIT_PAUSE_MS);
                throw new Error('HTTP 429 (rate limit exhausted)');
            }

            // ---- Other non-OK statuses — retry but less aggressively
            if (!r.ok) {
                if (attempt < MAX_RETRIES - 1) {
                    await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
                    continue;
                }
                throw new Error(`HTTP ${r.status}`);
            }

            // ---- Success
            const data = await r.json();
            const orders = Array.isArray(data.result) ? data.result : [];
            const cutoff = new Date();
            cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);
            const filtered = orders.filter((o) => {
                if (!o.date_Ordered) return false;
                return new Date(o.date_Ordered) >= cutoff;
            });

            fs.writeFileSync(cacheFile, JSON.stringify(filtered), 'utf8');
            adaptOnSuccess();
            return filtered;
        } catch (err) {
            const isTimeout = err.name === 'AbortError' || /timeout|abort/i.test(err.message);
            if (isTimeout) {
                consecutiveTimeouts++;
                if (consecutiveTimeouts >= 5) {
                    console.warn(`  ⚠ 5 consecutive timeouts — pausing 60s`);
                    await sleep(60_000);
                    consecutiveTimeouts = 0;
                }
            }
            if (attempt < MAX_RETRIES - 1) {
                await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
                continue;
            }
            throw err;
        }
    }
}

// ----- Aggregation helpers -------------------------------------------------

function normalizeEmail(e) {
    return String(e || '').trim().toLowerCase();
}

function normalizePhone(p) {
    // Strip the trailing " C" / " W" / " H" markers Caspio captures, plus
    // any whitespace, but keep digits + separators readable.
    return String(p || '').replace(/\s+[CWHM]\s*$/i, '').trim();
}

function getPhoneType(p) {
    const m = String(p || '').match(/\s+([CWHM])\s*$/i);
    return m ? m[1].toUpperCase() : '';
}

function modeOf(arr) {
    if (!arr.length) return '';
    const counts = new Map();
    for (const v of arr) {
        if (!v) continue;
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (!counts.size) return '';
    let best = '', max = 0;
    for (const [k, v] of counts) {
        if (v > max) { max = v; best = k; }
    }
    return best;
}

// Build the contact's enrichment fields from their email-matched orders.
function buildContactEnrichment(contactOrders, customerOrders) {
    // Sort contact orders by date_Ordered DESC
    const cOrdered = contactOrders.slice().sort((a, b) =>
        new Date(b.date_Ordered || 0) - new Date(a.date_Ordered || 0));

    // Phone_Best — most-recent non-empty ContactPhone
    let phoneBest = '';
    for (const o of cOrdered) {
        if (o.ContactPhone && String(o.ContactPhone).trim()) {
            phoneBest = String(o.ContactPhone).trim();
            break;
        }
    }

    // Phone_All_JSON — top 5 unique phones (by normalized number), sorted by lastSeen DESC
    const phoneMap = new Map(); // normalizedPhone → { phone, type, lastSeen, orderNo }
    for (const o of cOrdered) {
        const raw = String(o.ContactPhone || '').trim();
        if (!raw) continue;
        const norm = normalizePhone(raw);
        if (!norm) continue;
        if (!phoneMap.has(norm)) {
            phoneMap.set(norm, {
                phone: norm,
                type: getPhoneType(raw),
                lastSeen: o.date_Ordered ? String(o.date_Ordered).slice(0, 10) : '',
                orderNo: String(o.id_Order || ''),
            });
        }
    }
    const phoneArr = Array.from(phoneMap.values()).slice(0, MAX_PHONE_HISTORY);
    const phoneAllJson = phoneArr.length ? JSON.stringify(phoneArr) : '';

    // Preferred terms — mode of TermsName across contact's orders (fall back to customer-level)
    let prefTerms = modeOf(cOrdered.map((o) => String(o.TermsName || '').trim()));
    if (!prefTerms && customerOrders.length) {
        prefTerms = modeOf(customerOrders.map((o) => String(o.TermsName || '').trim()));
    }

    return {
        Phone_Best: phoneBest,
        Phone_All_JSON: phoneAllJson,
        Preferred_Terms_FromOrders: prefTerms,
        Orders_Email_Match_24mo: String(cOrdered.length),
    };
}

// ----- Main ----------------------------------------------------------------

async function main() {
    console.log('');
    console.log('=== CompanyContactsMerge2026 enrichment ===');
    console.log('Mode:', DRY_RUN ? '🟢 DRY RUN (20 random rows)' : '🔴 FULL RUN');
    console.log('');

    // 1. Load input CSV
    const inputPath = findLatestInputCsv();
    console.log('Input:', inputPath);
    const text = fs.readFileSync(inputPath, 'utf8');
    const { headers, records } = parseCsv(text);
    console.log(`  ${records.length} rows, ${headers.length} columns`);

    // 2. Make sure the 7 enrichment columns exist in the output headers
    const ENRICHED_COLS = [
        'Phone_Best',
        'Phone_All_JSON',
        'Preferred_Terms_FromOrders',
        'Orders_Email_Match_24mo',
        'Orders_Customer_Total_24mo',
        'MO_Sync_Date',
        'MO_Sync_Status',
    ];
    const outHeaders = headers.slice();
    for (const col of ENRICHED_COLS) {
        if (!outHeaders.includes(col)) outHeaders.push(col);
    }

    // 3. Pick the rows to process
    let workSet = records;
    if (DRY_RUN) {
        const candidates = records.filter((r) => r.Is_Active === '1' && r.Email && r.Email.trim());
        // Shuffle and take 20
        const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
        workSet = shuffled.slice(0, 20);
        console.log(`  DRY RUN: enriching ${workSet.length} of ${candidates.length} active-with-email candidates`);
    } else if (!INCLUDE_INACTIVE) {
        // Active-only filter (default for full runs as of 2026-05-20).
        // Dormant/dead contacts won't benefit from enrichment — they're not
        // getting new orders — and skipping them cuts the work surface ~50%.
        const before = workSet.length;
        workSet = records.filter((r) => r.Is_Active === '1');
        console.log(`  Active-only filter: enriching ${workSet.length} of ${before} rows (use --include-inactive to process all)`);
    }

    // 4. Group rows by id_Customer (so we fetch MO once per customer)
    const byCustomer = new Map();
    for (const r of workSet) {
        const id = String(r.id_Customer || '').trim();
        if (!id) continue;
        if (!byCustomer.has(id)) byCustomer.set(id, []);
        byCustomer.get(id).push(r);
    }
    const customerIds = Array.from(byCustomer.keys());
    console.log(`  Unique customers: ${customerIds.length}`);
    console.log('');

    // 5. Load checkpoint (resumability)
    ensureDir(path.dirname(CHECKPOINT_FILE));
    const processedSet = new Set();
    if (!DRY_RUN && fs.existsSync(CHECKPOINT_FILE)) {
        const lines = fs.readFileSync(CHECKPOINT_FILE, 'utf8').split('\n');
        for (const l of lines) {
            const t = l.trim();
            if (t) processedSet.add(t);
        }
        console.log(`  Resuming from checkpoint (${processedSet.size} customers already processed)`);
    }

    // 6. Initialize enriched rows — keep original data, will overwrite enrichment fields
    const enrichedRows = workSet.map((r) => ({ ...r }));
    const indexByContactId = new Map();
    enrichedRows.forEach((r, i) => {
        const cid = String(r.ID_Contact || '').trim();
        if (cid) indexByContactId.set(cid, i);
    });

    // 7. Stats
    const stats = {
        rowsProcessed: 0,
        rowsOk: 0,
        rowsNoEmail: 0,
        rowsNoMatch: 0,
        rowsNoData: 0,
        rowsTimeout: 0,
        phonesFound: 0,
        termsFound: 0,
        customersFetched: 0,
        customersFromCache: 0,
        customersTimedOut: 0,
        startedAt: new Date(),
    };

    // 8. Process customers
    let custIdx = 0;
    for (const idCustomer of customerIds) {
        custIdx++;
        if (!DRY_RUN && processedSet.has(idCustomer)) {
            // Already done in a prior run — skip
            continue;
        }

        // Fetch this customer's orders
        const cacheFile = path.join(CACHE_DIR, `${idCustomer}.json`);
        const wasCached = !NO_CACHE && fs.existsSync(cacheFile) &&
            (Date.now() - fs.statSync(cacheFile).mtime.getTime() < 24 * 60 * 60 * 1000);

        let customerOrders;
        let moStatus = 'ok';
        try {
            customerOrders = await fetchCustomerOrders(idCustomer);
            if (wasCached) stats.customersFromCache++;
            else {
                stats.customersFetched++;
                // Adaptive throttle — value adjusts up on 429s, down on success streaks.
                await sleep(currentThrottleMs);
            }
        } catch (err) {
            customerOrders = [];
            moStatus = 'timeout';
            stats.customersTimedOut++;
            console.warn(`  [${custIdx}/${customerIds.length}] customer ${idCustomer} TIMED OUT: ${err.message}`);
        }

        const ordersCount24mo = customerOrders.length;

        // Enrich each contact for this customer
        for (const row of byCustomer.get(idCustomer)) {
            const email = normalizeEmail(row.Email || row.ContactNumbersEmail);
            const cid = String(row.ID_Contact || '').trim();
            const idx = indexByContactId.get(cid);
            if (idx == null) continue;
            const out = enrichedRows[idx];

            // Always update these
            out.Orders_Customer_Total_24mo = String(ordersCount24mo);
            out.MO_Sync_Date = new Date().toISOString();

            if (moStatus === 'timeout') {
                out.MO_Sync_Status = 'timeout';
                stats.rowsTimeout++;
                continue;
            }

            if (!email) {
                out.MO_Sync_Status = 'no_email';
                out.Phone_Best = '';
                out.Phone_All_JSON = '';
                out.Preferred_Terms_FromOrders = '';
                out.Orders_Email_Match_24mo = '0';
                stats.rowsNoEmail++;
                continue;
            }

            if (customerOrders.length === 0) {
                out.MO_Sync_Status = 'no_data';
                out.Phone_Best = '';
                out.Phone_All_JSON = '';
                out.Preferred_Terms_FromOrders = '';
                out.Orders_Email_Match_24mo = '0';
                stats.rowsNoData++;
                continue;
            }

            // Email match (case-insensitive exact)
            const matched = customerOrders.filter((o) =>
                normalizeEmail(o.ContactEmail) === email);
            const enriched = buildContactEnrichment(matched, customerOrders);

            out.Phone_Best = enriched.Phone_Best;
            out.Phone_All_JSON = enriched.Phone_All_JSON;
            out.Preferred_Terms_FromOrders = enriched.Preferred_Terms_FromOrders;
            out.Orders_Email_Match_24mo = enriched.Orders_Email_Match_24mo;

            if (matched.length > 0) {
                out.MO_Sync_Status = 'ok';
                stats.rowsOk++;
            } else {
                out.MO_Sync_Status = 'no_match';
                stats.rowsNoMatch++;
            }
            if (enriched.Phone_Best) stats.phonesFound++;
            if (enriched.Preferred_Terms_FromOrders) stats.termsFound++;
            stats.rowsProcessed++;
        }

        // Checkpoint only on successful MO fetch — timed-out customers stay
        // un-checkpointed so re-runs retry them. (Without this, the 4 customers
        // that 429'd in Erik's first run would never get retried.)
        if (!DRY_RUN && moStatus === 'ok') {
            fs.appendFileSync(CHECKPOINT_FILE, idCustomer + '\n');
        }

        // Progress every 50 customers
        if (custIdx % 50 === 0 || custIdx === customerIds.length) {
            console.log(`  [${custIdx}/${customerIds.length}] ok=${stats.rowsOk} no_match=${stats.rowsNoMatch} no_email=${stats.rowsNoEmail} timeout=${stats.rowsTimeout}`);
        }
    }

    // 9. Write enriched CSV
    const outName = DRY_RUN
        ? `CompanyContactsMerge2026_enriched_DRYRUN_${todayStamp()}.csv`
        : `CompanyContactsMerge2026_enriched_${todayStamp()}.csv`;
    const outPath = path.join(DOWNLOADS, outName);
    writeCsv(outPath, outHeaders, enrichedRows);
    console.log('');
    console.log('Wrote:', outPath);

    // 10. Write summary report
    const reportName = DRY_RUN
        ? `CompanyContactsMerge2026_enrichment_report_DRYRUN_${todayStamp()}.txt`
        : `CompanyContactsMerge2026_enrichment_report_${todayStamp()}.txt`;
    const reportPath = path.join(DOWNLOADS, reportName);
    const elapsed = ((Date.now() - stats.startedAt.getTime()) / 1000).toFixed(1);
    const report = [
        '=== CompanyContactsMerge2026 enrichment report ===',
        `Mode:           ${DRY_RUN ? 'DRY RUN' : 'FULL RUN'}`,
        `Started:        ${stats.startedAt.toISOString()}`,
        `Finished:       ${new Date().toISOString()}`,
        `Elapsed:        ${elapsed}s`,
        `Input file:     ${inputPath}`,
        `Output file:    ${outPath}`,
        '',
        'INPUT',
        `  Total rows in CSV:          ${records.length}`,
        `  Rows in this run:           ${workSet.length}`,
        `  Unique customers:           ${customerIds.length}`,
        '',
        'MO FETCH STATS',
        `  Customers fetched fresh:    ${stats.customersFetched}`,
        `  Customers from disk cache:  ${stats.customersFromCache}`,
        `  Customers timed out:        ${stats.customersTimedOut}`,
        '',
        'PER-ROW STATUS',
        `  ok        ${stats.rowsOk.toString().padStart(6)}  (email matched orders → enrichment applied)`,
        `  no_match  ${stats.rowsNoMatch.toString().padStart(6)}  (email didn't match any MO orders for this customer)`,
        `  no_email  ${stats.rowsNoEmail.toString().padStart(6)}  (contact has no email — skipped enrichment)`,
        `  no_data   ${stats.rowsNoData.toString().padStart(6)}  (customer has no MO orders in 24mo window)`,
        `  timeout   ${stats.rowsTimeout.toString().padStart(6)}  (MO timed out — re-run with --retry-timeouts)`,
        '',
        'FIELDS POPULATED',
        `  Phone_Best filled:                    ${stats.phonesFound}`,
        `  Preferred_Terms_FromOrders filled:    ${stats.termsFound}`,
        '',
        'NEXT STEP',
        '  Re-import the enriched CSV into Caspio:',
        '    1. Open CompanyContactsMerge2026 → Datasheet → Import',
        '    2. Choose the enriched CSV',
        '    3. Mode: "Update existing records"',
        '    4. Key field: ID_Contact',
        '    5. Map all 7 new columns (auto-detected by name)',
        '    6. Run import',
        '',
    ].join('\n');
    fs.writeFileSync(reportPath, report, 'utf8');
    console.log('Wrote:', reportPath);

    // 11. Sample output for dry-run
    if (DRY_RUN) {
        console.log('');
        console.log('--- Sample enriched rows (first 3) ---');
        for (let i = 0; i < Math.min(3, enrichedRows.length); i++) {
            const r = enrichedRows[i];
            console.log('');
            console.log(`Contact: ${r.ct_NameFull || r.NameFirst + ' ' + r.NameLast} (${r.Email || '(no email)'})`);
            console.log(`  id_Customer:                  ${r.id_Customer} (${r.CustomerCompanyName})`);
            console.log(`  MO_Sync_Status:               ${r.MO_Sync_Status}`);
            console.log(`  Orders_Email_Match_24mo:      ${r.Orders_Email_Match_24mo}`);
            console.log(`  Orders_Customer_Total_24mo:   ${r.Orders_Customer_Total_24mo}`);
            console.log(`  Phone_Best:                   ${r.Phone_Best || '(none)'}`);
            console.log(`  Preferred_Terms_FromOrders:   ${r.Preferred_Terms_FromOrders || '(none)'}`);
            if (r.Phone_All_JSON) {
                console.log(`  Phone_All_JSON: ${r.Phone_All_JSON.slice(0, 140)}${r.Phone_All_JSON.length > 140 ? '...' : ''}`);
            }
        }
        console.log('');
        console.log('Full output: ' + outPath);
        console.log('Full report: ' + reportPath);
    }

    console.log('');
    console.log('=== DONE ===');
    console.log(`Elapsed: ${elapsed}s`);
}

main().catch((err) => {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
