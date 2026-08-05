#!/usr/bin/env node
/**
 * Sync Design Lookup — Unified Table Sync Script
 *
 * Reads all 4 design source tables, merges them using the same logic as
 * digitized-designs.js mergeDesignResults(), and upserts into the unified
 * Design_Lookup_2026 Caspio table.
 *
 * Usage:
 *   node scripts/sync-design-lookup.js           # Dry-run (preview only)
 *   node scripts/sync-design-lookup.js --live     # Write to Caspio
 *
 * Designed for Heroku Scheduler (weekly) or manual runs.
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Box.com design previews mapping (design# → CDN URL for DST thumbnails)
const BOX_MAPPING_FILE = path.join(__dirname, 'data', 'box-design-previews.json');
let boxByDN = {};
if (fs.existsSync(BOX_MAPPING_FILE)) {
    boxByDN = JSON.parse(fs.readFileSync(BOX_MAPPING_FILE, 'utf8'));
    console.log(`[Init] Loaded ${Object.keys(boxByDN).length.toLocaleString()} Box thumbnail mappings`);
} else {
    console.warn('[Init] Box mapping file not found — Box thumbnails will be skipped');
}

// Box.com Steve Art mockups mapping (design# → CDN URL for garment mockups)
const MOCKUP_MAPPING_FILE = path.join(__dirname, 'data', 'box-steve-mockups.json');
let mockupByDN = {};
if (fs.existsSync(MOCKUP_MAPPING_FILE)) {
    mockupByDN = JSON.parse(fs.readFileSync(MOCKUP_MAPPING_FILE, 'utf8'));
    console.log(`[Init] Loaded ${Object.keys(mockupByDN).length.toLocaleString()} Box mockup mappings`);
} else {
    console.warn('[Init] Box mockup mapping file not found — mockups will be skipped');
}

// ============================================
// Company → Customer_ID CSV mapping (primary/authoritative source)
// ============================================
// Auto-detect CSV files in scripts/data/ matching common patterns
const CSV_PATTERNS = ['company-customer-ids.csv', 'company-customers.csv', 'customer-ids.csv', 'Full Company List 2026.csv'];
let csvCompanyMap = {};  // normalized company name → { custId, correctName }
let csvLoaded = false;

function loadCompanyCSV() {
    const dataDir = path.join(__dirname, 'data');
    // Find any CSV file in data/ that might be the company mapping
    let csvFile = null;
    for (const pattern of CSV_PATTERNS) {
        const candidate = path.join(dataDir, pattern);
        if (fs.existsSync(candidate)) {
            csvFile = candidate;
            break;
        }
    }
    // Also check for any CSV with "company" or "customer" in the name
    if (!csvFile && fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir);
        for (const f of files) {
            if (f.endsWith('.csv') && (f.toLowerCase().includes('company') || f.toLowerCase().includes('customer'))) {
                csvFile = path.join(dataDir, f);
                break;
            }
        }
    }
    if (!csvFile) return;

    console.log(`[Init] Loading company CSV: ${path.basename(csvFile)}`);
    const raw = fs.readFileSync(csvFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) {
        console.warn('[Init] CSV file has fewer than 2 lines — skipping');
        return;
    }

    // Parse header — auto-detect column names
    const header = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
    const companyCol = header.findIndex(h =>
        /^(company|companyname|company_name|customercompanyname|customer_company_name|name)$/i.test(h)
    );
    const idCol = header.findIndex(h =>
        /^(id_customer|customer_id|customerid|id|shopworks_id)$/i.test(h)
    );

    // Also detect CustomerType column (optional enrichment)
    const typeCol = header.findIndex(h =>
        /^(customertype|customer_type|type)$/i.test(h)
    );

    if (companyCol === -1 || idCol === -1) {
        console.warn(`[Init] CSV header not recognized: [${header.join(', ')}]`);
        console.warn('  Expected columns like CompanyName + ID_Customer');
        return;
    }

    console.log(`[Init] CSV columns: "${header[companyCol]}" (company) + "${header[idCol]}" (customer ID)${typeCol !== -1 ? ` + "${header[typeCol]}" (customer type)` : ''}`);

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
        // Simple CSV parse — handles quoted fields with commas
        const fields = parseCSVLine(lines[i]);
        if (!fields || fields.length <= Math.max(companyCol, idCol)) continue;

        const company = (fields[companyCol] || '').trim();
        const custId = (fields[idCol] || '').trim();
        if (!company || !custId || custId === '0') continue;

        const customerType = (typeCol !== -1 && fields[typeCol]) ? fields[typeCol].trim() : '';
        const normalized = normalizeCompanyName(company);
        if (normalized && !csvCompanyMap[normalized]) {
            csvCompanyMap[normalized] = { custId, correctName: company, customerType };
            count++;
        }
    }

    csvLoaded = true;
    console.log(`[Init] Loaded ${count.toLocaleString()} company→customer mappings from CSV (with correct spellings)`);
}

/** Simple CSV line parser that handles quoted fields */
function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && !inQuotes) {
            inQuotes = true;
        } else if (ch === '"' && inQuotes) {
            if (i + 1 < line.length && line[i + 1] === '"') {
                current += '"';
                i++; // skip escaped quote
            } else {
                inQuotes = false;
            }
        } else if (ch === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current.trim());
    return fields;
}

/** Normalize company name for matching: lowercase, trim, strip common punctuation */
function normalizeCompanyName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .trim()
        .replace(/[.,;:!?'"()[\]{}]/g, '')  // strip punctuation
        .replace(/\s+/g, ' ')                // collapse whitespace
        .replace(/\b(inc|llc|ltd|corp|co|the|and)\b/g, '') // strip common suffixes
        .replace(/\s+/g, ' ')
        .trim();
}

// Load CSV at startup
loadCompanyCSV();

// ============================================
// Configuration
// ============================================

const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const CASPIO_TOKEN_URL = `https://${CASPIO_DOMAIN}/oauth/token`;
const CASPIO_API_BASE = `https://${CASPIO_DOMAIN}/integrations/rest/v3`;

const LIVE_MODE = process.argv.includes('--live');
const VERBOSE = process.argv.includes('--verbose');

// --csv-out <path>: write the merged rows to CSV instead of POSTing them.
// A full refresh is ~38.8k individual POSTs (Caspio REST v3 has no batch
// insert) = ~7.8% of the 500k/period Integrations budget for ONE run. Caspio's
// data-import quota is a SEPARATE ~1,000/period meter, so importing the same
// rows costs essentially nothing against the budget that matters — and takes
// minutes instead of hours. Use this for any full rebuild; keep --live for
// small incremental work.
const CSV_OUT_IDX = process.argv.indexOf('--csv-out');
const CSV_OUT = CSV_OUT_IDX !== -1 ? process.argv[CSV_OUT_IDX + 1] : null;

// Column order for the CSV. MUST match the keys pushed into unifiedRecords —
// these are the Design_Lookup_2026 field names. ID_Unique / PK_ID are omitted
// on purpose: Caspio owns those.
const CSV_COLUMNS = [
    'Design_Number', 'Design_Name', 'Company', 'Customer_ID',
    'Stitch_Count', 'Stitch_Tier', 'AS_Surcharge', 'DST_Filename',
    'Color_Changes', 'Extra_Colors', 'Extra_Color_Surcharge',
    'FB_Price_1_7', 'FB_Price_8_23', 'FB_Price_24_47', 'FB_Price_48_71', 'FB_Price_72plus',
    'Thumbnail_URL', 'DST_Preview_URL', 'Artwork_URL', 'Mockup_URL',
    'Placement', 'Thread_Colors', 'Last_Order_Date', 'Order_Count',
    'Art_Notes', 'Sales_Rep', 'Customer_Type', 'Is_Active', 'Date_Updated'
];

/** RFC-4180 field: quote when it contains a comma, quote, CR/LF, or edge whitespace. */
function csvField(value) {
    if (value === null || value === undefined) return '';
    let s = String(value);
    // Strip CR/LF outright — Caspio's importer treats a stray newline inside an
    // unquoted field as a row break, which silently shifts every later column.
    s = s.replace(/\r\n|\r|\n/g, ' ');
    if (/[",]/.test(s) || /^\s|\s$/.test(s)) {
        s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function writeCsv(records, outPath) {
    const fsMod = require('fs');
    const lines = [CSV_COLUMNS.join(',')];
    for (const rec of records) {
        lines.push(CSV_COLUMNS.map(col => csvField(rec[col])).join(','));
    }
    // BOM so Excel opens UTF-8 design names correctly; Caspio ignores it.
    fsMod.writeFileSync(outPath, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
    return { rows: records.length, bytes: fsMod.statSync(outPath).size };
}

// Source tables
const TABLES = {
    master: 'Digitized_Designs_Master_2026',
    shopworks: 'ShopWorks_Designs',
    thumbnail: 'Shopworks_Thumbnail_Report',
    artRequests: 'ArtRequests',
    unified: 'Design_Lookup_2026',
    // Customer mapping tables (for Customer_ID enrichment)
    salesReps: 'Sales_Reps_2026',
    contacts: 'Company_Contacts_Merge_ODBC',
    houseAccounts: 'House_Accounts',
    taneishaAccounts: 'Taneisha_All_Accounts_Caspio',
    nikaAccounts: 'Nika_All_Accounts_Caspio'
};

// Fields to fetch from each source table
const FIELDS = {
    master: [
        'ID_Unique', 'Design_Number', 'Design_Description', 'Company', 'Customer_ID',
        'Stitch_Count', 'Stitch_Tier', 'AS_Surcharge', 'DST_Filename',
        'Color_Changes', 'Extra_Colors', 'Extra_Color_Surcharge',
        'FB_Price_1_7', 'FB_Price_8_23', 'FB_Price_24_47', 'FB_Price_48_71', 'FB_Price_72plus',
        'DST_Preview_URL', 'Thumbnail_URL'
    ].join(','),
    shopworks: [
        'Design_Number', 'Design_Name', 'Company_Name',
        'Thread_Colors', 'Color_Count', 'Last_Order_Date', 'Order_Count',
        'Stitch_Count', 'Stitch_Tier', 'AS_Surcharge'
    ].join(','),
    thumbnail: [
        'Thumb_DesLocid_Design', 'Thumb_DesLoc_DesDesignName', 'ExternalKey', 'FileUrl'
    ].join(','),
    artRequests: [
        'Design_Num_SW', 'ID_Design', 'CompanyName', 'Company_Mockup', 'CDN_Link',
        'Garment_Placement', 'NOTES', 'Shopwork_customer_number'
    ].join(',')
};

// Rate limit: pause between Caspio writes to avoid 429s
const WRITE_DELAY_MS = 200;

// ============================================
// Caspio API helpers
// ============================================

let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (accessToken && now < tokenExpiry - 60) return accessToken;

    console.log('[Auth] Requesting Caspio access token...');
    const resp = await axios.post(CASPIO_TOKEN_URL, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CASPIO_CLIENT_ID,
        client_secret: CASPIO_CLIENT_SECRET
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    accessToken = resp.data.access_token;
    tokenExpiry = now + resp.data.expires_in;
    console.log('[Auth] Token obtained, expires in', resp.data.expires_in, 'seconds');
    return accessToken;
}

/**
 * Fetch all pages from a Caspio table.
 * Handles pagination (q.pageNumber / q.pageSize).
 */
async function fetchAll(tableName, params = {}) {
    const token = await getToken();
    const resourcePath = `/tables/${tableName}/records`;
    let allResults = [];
    let page = 1;
    const pageSize = params['q.limit'] || 1000;

    while (true) {
        const reqParams = { ...params, 'q.pageNumber': page, 'q.pageSize': pageSize };
        if (page === 1 && params['q.limit']) {
            reqParams['q.limit'] = params['q.limit'];
        }

        const url = `${CASPIO_API_BASE}${resourcePath}`;
        try {
            const resp = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                params: reqParams,
                timeout: 30000
            });

            const records = resp.data?.Result || [];
            allResults = allResults.concat(records);

            if (VERBOSE) {
                console.log(`  [Fetch] ${tableName} page ${page}: ${records.length} records (total: ${allResults.length})`);
            }

            // If we got fewer than pageSize records, we're done
            if (records.length < pageSize) break;
            page++;

            // Safety: max 50 pages
            if (page > 50) {
                console.warn(`  [Fetch] ${tableName}: Hit 50-page safety limit at ${allResults.length} records`);
                break;
            }
        } catch (err) {
            if (err.response?.status === 404) {
                console.warn(`  [Fetch] Table "${tableName}" not found (404). Returning empty.`);
                return [];
            }
            throw err;
        }
    }

    return allResults;
}

/**
 * Insert a single record, retrying through Caspio's rate limiter.
 *
 * 🔴 Caspio's PER-SECOND limit is the real ceiling, not the monthly quota, and
 * when you cross it the whole ACCOUNT starts answering 429 — reads included, so
 * every other proxy consumer (pricing, products, dashboards) degrades with you.
 * On 2026-08-05 this script drove ~30-50 writes/sec (concurrency 10, 50ms
 * between chunks) and got exactly that: 2,520 rows in, then a wall of 429s.
 * A 429 is BACKPRESSURE, not a failure — wait and retry, never drop the record.
 */
async function insertRecord(tableName, record, throttle) {
    if (!LIVE_MODE) return { dryRun: true };

    const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;
    const MAX_ATTEMPTS = 6;
    let lastErr;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const token = await getToken();
            return await axios.post(url, record, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 20000
            });
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            const retryable = status === 429 || status === 408 || (status >= 500 && status <= 599);
            if (!retryable || attempt === MAX_ATTEMPTS) break;

            // Tell the whole run to slow down — one record backing off alone
            // just means the next chunk walks into the same wall.
            if (status === 429) throttle.penalise();
            const waitMs = Math.min(60000, 1500 * Math.pow(2, attempt - 1));
            await sleep(waitMs + Math.floor(Math.random() * 500));
        }
    }
    throw lastErr;
}

/**
 * Adaptive pacing: widen the gap between chunks whenever Caspio pushes back,
 * and creep back toward the floor only after a clean stretch.
 */
function makeThrottle(floorMs = 400, ceilMs = 8000) {
    let delay = floorMs;
    let cleanChunks = 0;
    return {
        get current() { return delay; },
        penalise() { delay = Math.min(ceilMs, Math.max(floorMs, delay * 2)); cleanChunks = 0; },
        reward() {
            if (++cleanChunks >= 12 && delay > floorMs) { delay = Math.max(floorMs, delay / 2); cleanChunks = 0; }
        },
        wait() { return sleep(delay); }
    };
}

/**
 * Insert records with adaptive concurrency control.
 * Every record either lands or fails the run — nothing is silently skipped.
 */
async function insertWithConcurrency(tableName, records, concurrency = 4, onProgress = null) {
    if (!LIVE_MODE) return { dryRun: true, count: records.length };

    const stats = { inserted: 0, errors: 0, retriesSeen: 0 };
    const failures = [];
    const throttle = makeThrottle();
    const startTime = Date.now();

    for (let i = 0; i < records.length; i += concurrency) {
        const chunk = records.slice(i, i + concurrency);

        const results = await Promise.allSettled(
            chunk.map(rec => insertRecord(tableName, rec, throttle))
        );

        let chunkClean = true;
        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled') {
                stats.inserted++;
            } else {
                chunkClean = false;
                stats.errors++;
                const reason = results[j].reason;
                const errMsg = reason?.response?.data?.Message || reason?.message || 'unknown';
                failures.push({ designNumber: chunk[j].Design_Number, status: reason?.response?.status, errMsg });
                if (stats.errors <= 10) {
                    console.error(`  ❌ Design #${chunk[j].Design_Number}: ${errMsg}`);
                }
            }
        }
        chunkClean ? throttle.reward() : throttle.penalise();

        if (onProgress && (i + concurrency) % 500 < concurrency) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            onProgress(Math.min(i + concurrency, records.length), records.length, elapsed, stats, throttle.current);
        }

        // 🔴 Bail out rather than grind through 34,000 more failures leaving a
        // half-populated table that LOOKS fine. The old code counted errors and
        // kept going; that is how a silently incomplete table gets published.
        if (stats.errors >= 50 && stats.inserted === 0) {
            throw new Error(`Aborting: ${stats.errors} consecutive insert failures with nothing landing — Caspio is refusing writes.`);
        }

        await throttle.wait();
    }

    stats.failures = failures;
    return stats;
}

/**
 * How many rows the table holds — or, when Caspio won't say, whether it holds ANY.
 *
 * Returns 0 for empty, a positive count when Caspio supplies TotalRecords, and
 * -1 for "not empty, exact count unknown". Callers must treat anything !== 0 as
 * "still has rows".
 *
 * 🔴 Caspio REST v3 does NOT reliably return TotalRecords on this endpoint — it
 * came back undefined here, and reading `.toLocaleString()` off the resulting
 * null threw *after* the DELETE had already run (2026-08-05), which aborted the
 * sync with the table emptied and nothing re-inserted. The emptiness probe below
 * is all the delete verification actually needs, and it cannot return null.
 */
async function countRecords(tableName) {
    const token = await getToken();
    const resp = await axios.get(`${CASPIO_API_BASE}/tables/${tableName}/records`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { 'q.select': 'PK_ID', 'q.limit': 1 },
        timeout: 30000
    });
    const total = resp.data?.TotalRecords;
    if (typeof total === 'number') return total;
    return (resp.data?.Result || []).length === 0 ? 0 : -1;
}

/** Render a countRecords() result for humans without ever throwing. */
function fmtCount(n) {
    if (n === 0) return '0';
    if (typeof n === 'number' && n > 0) return n.toLocaleString();
    return 'some (exact count unavailable)';
}

/**
 * Delete every row from a Caspio table, VERIFIED.
 *
 * 🔴 This used to issue a WHERE-less DELETE and let main() insert regardless of
 * the outcome. That is how Design_Lookup_2026 reached 146,526 rows for what is
 * really a 38,785-row dataset: the 2026-02-24 and 2026-02-25 runs each stacked
 * a full copy on top of the previous one (sampled 2026-08-05: design #36868 had
 * 43 rows for 10 distinct DST+stitch combinations). Caspio also answers an
 * unsupported delete with 400, which the old handler logged as "table already
 * empty" — the exact opposite of what happened.
 *
 * Now: delete with an explicit match-everything WHERE, loop until the table is
 * actually empty (Caspio caps how much one DELETE removes), and return the
 * verified remaining count so the caller can refuse to insert on top.
 */
async function deleteAllRecords(tableName) {
    if (!LIVE_MODE) return { dryRun: true };

    const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;
    let totalDeleted = 0;

    for (let pass = 1; pass <= 40; pass++) {
        const before = await countRecords(tableName);
        if (before === 0) break;

        const token = await getToken();
        const resp = await axios.delete(url, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            params: { 'q.where': 'PK_ID>0' },   // matches every row; Caspio requires a WHERE
            timeout: 120000,
            validateStatus: () => true
        });

        if (resp.status >= 400) {
            throw new Error(`DELETE rejected with HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
        }

        const affected = resp.data?.RecordsAffected ?? 0;
        totalDeleted += affected;
        console.log(`    pass ${pass}: deleted ${fmtCount(affected)} (table had ${fmtCount(before)})`);

        // No progress but rows remain → looping again would spin forever.
        if (affected === 0) break;
        await sleep(500);
    }

    const remaining = await countRecords(tableName);
    return { totalDeleted, remaining };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Merge logic (mirrors digitized-designs.js)
// ============================================

const PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

/**
 * Build a unified company → customer_id lookup map from multiple Caspio tables + CSV.
 * Priority: CSV (authoritative) → Sales_Reps → Contacts → Rep accounts → House
 * Lower-priority sources only fill gaps — they don't overwrite higher-priority mappings.
 */
function buildCompanyCustomerMap(salesRepsRecs, contactsRecs, houseRecs, taneishaRecs, nikaRecs) {
    const map = {};
    const sourceCounts = { csv: 0, salesReps: 0, contacts: 0, repAccounts: 0, house: 0 };

    // Helper: add to map if not already present
    function addMapping(company, custId, source) {
        if (!company || !custId || custId === '0') return;
        const normalized = normalizeCompanyName(company);
        if (!normalized) return;
        if (!map[normalized]) {
            map[normalized] = String(custId).trim();
            sourceCounts[source]++;
        }
    }

    // 1. CSV file (highest priority — authoritative master list with correct spellings)
    if (csvLoaded) {
        for (const [normalized, entry] of Object.entries(csvCompanyMap)) {
            if (!map[normalized]) {
                map[normalized] = entry;  // { custId, correctName }
                sourceCounts.csv++;
            }
        }
    }

    // 2. Sales_Reps_2026 (2nd priority — active sales assignments)
    for (const rec of salesRepsRecs) {
        addMapping(rec.CompanyName, rec.ID_Customer, 'salesReps');
    }

    // 3. Company_Contacts_Merge_ODBC (3rd — rich contact data)
    // Note: this table uses different field names (id_Customer, CustomerCompanyName)
    for (const rec of contactsRecs) {
        addMapping(rec.CustomerCompanyName, rec.id_Customer, 'contacts');
    }

    // 4. Rep-specific account tables (4th)
    for (const rec of taneishaRecs) {
        addMapping(rec.CompanyName, rec.ID_Customer, 'repAccounts');
    }
    for (const rec of nikaRecs) {
        addMapping(rec.CompanyName, rec.ID_Customer, 'repAccounts');
    }

    // 5. House_Accounts (5th — catch-all non-rep customers)
    for (const rec of houseRecs) {
        addMapping(rec.CompanyName, rec.ID_Customer, 'house');
    }

    console.log(`  Customer map sources: CSV=${sourceCounts.csv}, SalesReps=${sourceCounts.salesReps}, Contacts=${sourceCounts.contacts}, RepAccounts=${sourceCounts.repAccounts}, House=${sourceCounts.house}`);

    return map;
}

/**
 * Look up Customer_ID by company name using the unified map.
 * Tries exact normalized match first, then prefix matching.
 * Returns { customerId, matchType, correctName, customerType } or null.
 * correctName = authoritative spelling from CSV (source of truth).
 * customerType = from CSV (e.g., "DEAD", "ACTIVE").
 */
function lookupCustomerByCompany(company, companyToCustomerId) {
    if (!company) return null;
    const normalized = normalizeCompanyName(company);
    if (!normalized) return null;

    // 1. Exact normalized match
    const entry = companyToCustomerId[normalized];
    if (entry) {
        return {
            customerId: typeof entry === 'object' ? entry.custId : entry,
            correctName: typeof entry === 'object' ? entry.correctName : null,
            customerType: typeof entry === 'object' ? (entry.customerType || '') : '',
            matchType: 'exact'
        };
    }

    // 2. Prefix match (first 10+ chars) — catches "Company Name Inc" vs "Company Name"
    if (normalized.length >= 8) {
        const prefix = normalized.substring(0, Math.min(normalized.length, 15));
        for (const [key, val] of Object.entries(companyToCustomerId)) {
            if (key.startsWith(prefix) || prefix.startsWith(key.substring(0, Math.min(key.length, 15)))) {
                return {
                    customerId: typeof val === 'object' ? val.custId : val,
                    correctName: typeof val === 'object' ? val.correctName : null,
                    customerType: typeof val === 'object' ? (val.customerType || '') : '',
                    matchType: 'prefix'
                };
            }
        }
    }

    return null;
}

/**
 * Build a Customer_ID → Sales_Rep lookup map.
 * Determines rep ownership from which account table(s) a customer appears in.
 * Sales_Reps_2026 Account_Tier encodes the rep: "GOLD '26-TANEISHA" → "Taneisha"
 */
function buildCustomerToRepMap(salesRepsRecs, taneishaRecs, nikaRecs) {
    const repMap = {};  // customer_id → rep name

    // Rep-specific tables are the most authoritative (explicit assignment)
    for (const rec of taneishaRecs) {
        const id = String(rec.ID_Customer || '').trim();
        if (id && id !== '0') repMap[id] = 'Taneisha';
    }
    for (const rec of nikaRecs) {
        const id = String(rec.ID_Customer || '').trim();
        if (id && id !== '0') repMap[id] = 'Nika';
    }

    // Sales_Reps_2026 Account_Tier can also encode the rep
    // e.g., "GOLD '26-TANEISHA", "SILVER '26-NIKA", "Win Back '26 TANEISHA"
    for (const rec of salesRepsRecs) {
        const id = String(rec.ID_Customer || '').trim();
        if (!id || id === '0' || repMap[id]) continue; // don't overwrite rep-specific
        const tier = (rec.Account_Tier || '').toUpperCase();
        if (tier.includes('TANEISHA')) repMap[id] = 'Taneisha';
        else if (tier.includes('NIKA')) repMap[id] = 'Nika';
    }

    const tCount = Object.values(repMap).filter(r => r === 'Taneisha').length;
    const nCount = Object.values(repMap).filter(r => r === 'Nika').length;
    console.log(`  Customer→Rep map: ${Object.keys(repMap).length} customers (Taneisha=${tCount}, Nika=${nCount})`);

    return repMap;
}

/**
 * Merge records from all 4 source tables into a unified map.
 * Key = Design_Number, Value = merged record fields for Design_Lookup_2026.
 *
 * Unlike the route's mergeDesignResults() which groups variants,
 * this preserves EACH VARIANT ROW from Master as a separate row in the
 * unified table (important: one design number can have garment/cap/sleeve
 * variants with different stitch counts).
 *
 * @param {Object} companyToCustomerId - Normalized company name → Customer_ID lookup map
 * @param {Object} customerToRep - Customer_ID → Sales_Rep name lookup map
 */
function buildUnifiedRecords(masterRecords, shopworksRecords, thumbnailRecords, artRecords, companyToCustomerId = {}, customerToRep = {}) {
    // Track Customer_ID enrichment stats
    const custIdStats = { fromMaster: 0, fromArt: 0, companyLookup: 0, prefixMatches: 0, namesCorrected: 0, fromCompanyMockup: 0, stillMissing: 0 };
    const enrichStats = { salesRepFilled: 0, customerTypeFilled: 0 };

    // Index ShopWorks_Designs by Design_Number (one record per design number)
    const swByDN = {};
    for (const rec of shopworksRecords) {
        const dn = String(rec.Design_Number || '').trim();
        if (!dn) continue;
        // Keep first occurrence (or update if this one has more data)
        if (!swByDN[dn] || (!swByDN[dn].Design_Name && rec.Design_Name)) {
            swByDN[dn] = rec;
        }
    }

    // Index Thumbnail by design number (strip .xx suffix)
    // Multiple thumbnails per design possible; keep best one
    const thumbByDN = {};
    for (const rec of thumbnailRecords) {
        const rawDN = String(rec.Thumb_DesLocid_Design || '').trim();
        const dn = rawDN.replace(/\.\d+$/, ''); // Strip .xx suffix
        if (!dn) continue;

        const imageUrl = rec.ExternalKey
            ? `${PROXY_BASE}/api/files/${rec.ExternalKey}`
            : (rec.FileUrl || null);

        if (imageUrl && !thumbByDN[dn]) {
            thumbByDN[dn] = {
                thumbnailUrl: imageUrl,
                designName: (rec.Thumb_DesLoc_DesDesignName || '').trim()
            };
        }
    }

    // Index ArtRequests by design number
    // Multiple art requests per design possible; keep latest or most complete
    const artByDN = {};
    for (const rec of artRecords) {
        const dn = String(rec.Design_Num_SW || '').trim() || String(rec.ID_Design || '').trim();
        if (!dn) continue;
        if (!artByDN[dn] || (!artByDN[dn].CDN_Link && rec.CDN_Link)) {
            artByDN[dn] = rec;
        }
    }

    // Build unified records from Master (each variant = one row)
    const unifiedRecords = [];
    const masterDesignNumbers = new Set();

    for (const rec of masterRecords) {
        const dn = String(rec.Design_Number);
        masterDesignNumbers.add(dn);

        const sw = swByDN[dn];
        const thumb = thumbByDN[dn];
        const art = artByDN[dn];

        // Design name priority: ShopWorks_Designs → Thumbnail → Master Description
        const designName = (sw?.Design_Name || '').trim()
            || (thumb?.designName || '').trim()
            || (rec.Design_Description || '').trim()
            || '';

        // Company priority: Master → ArtRequests CompanyName → ArtRequests Company_Mockup → ShopWorks
        // (resolved BEFORE Customer_ID so we can use company name for lookup)
        // Using let because CSV may correct the spelling
        let company = (rec.Company || '').trim()
            || (art?.CompanyName || '').trim()
            || (art?.Company_Mockup || '').trim()
            || (sw?.Company_Name || '').trim()
            || '';

        // Track if Company_Mockup was the source (CompanyName empty, Company_Mockup provided the value)
        const companyFromMockup = company && !(rec.Company || '').trim() && !(art?.CompanyName || '').trim()
            && (art?.Company_Mockup || '').trim();

        // Customer ID priority: Master → ArtRequests → Company name lookup
        // Note: Customer_ID in Master may be a Number, so coerce to String first
        let customerId = (rec.Customer_ID != null ? String(rec.Customer_ID) : '').trim()
            || (art?.Shopwork_customer_number != null ? String(art.Shopwork_customer_number) : '').trim()
            || '';

        // 3rd fallback: look up by company name
        // Also correct company spelling from CSV (source of truth)
        if (company) {
            const lookup = lookupCustomerByCompany(company, companyToCustomerId);
            if (lookup) {
                if (!customerId) {
                    customerId = lookup.customerId;
                    custIdStats.companyLookup++;
                    if (lookup.matchType === 'prefix') custIdStats.prefixMatches++;
                    if (companyFromMockup) custIdStats.fromCompanyMockup++;
                }
                // Use correct spelling from CSV (authoritative)
                if (lookup.correctName && lookup.correctName !== company) {
                    company = lookup.correctName;
                    custIdStats.namesCorrected = (custIdStats.namesCorrected || 0) + 1;
                }
            }
        }
        if (customerId) {
            if (rec.Customer_ID != null && String(rec.Customer_ID).trim()) custIdStats.fromMaster++;
            else if (art?.Shopwork_customer_number) custIdStats.fromArt++;
        }

        // DST Preview URL: preserved as separate field (JPG of digitized stitch file)
        const dstPreviewUrl = (rec.DST_Preview_URL || '').trim();

        // Thumbnail URL priority: Master → Thumbnail Report → Box DST → (empty)
        // Note: DST_Preview_URL removed from this chain — now its own field
        const thumbnailUrl = (rec.Thumbnail_URL || '').trim()
            || (thumb?.thumbnailUrl || '')
            || (boxByDN[dn] || '')
            || '';

        // Artwork URL: ArtRequests CDN_Link only (full mockup, not thumbnail)
        const artworkUrl = (art?.CDN_Link && art.CDN_Link.length > 30) ? art.CDN_Link : '';

        unifiedRecords.push({
            Design_Number: parseInt(dn, 10) || 0,
            Design_Name: designName.substring(0, 255),
            Company: company.substring(0, 255),
            Customer_ID: customerId.substring(0, 255),
            Stitch_Count: parseInt(rec.Stitch_Count, 10) || 0,
            Stitch_Tier: (rec.Stitch_Tier || 'Standard').substring(0, 255),
            AS_Surcharge: parseFloat(rec.AS_Surcharge) || 0,
            DST_Filename: (rec.DST_Filename || '').substring(0, 255),
            Color_Changes: parseInt(rec.Color_Changes, 10) || 0,
            Extra_Colors: parseInt(rec.Extra_Colors, 10) || 0,
            Extra_Color_Surcharge: parseFloat(rec.Extra_Color_Surcharge) || 0,
            FB_Price_1_7: parseFloat(rec.FB_Price_1_7) || 0,
            FB_Price_8_23: parseFloat(rec.FB_Price_8_23) || 0,
            FB_Price_24_47: parseFloat(rec.FB_Price_24_47) || 0,
            FB_Price_48_71: parseFloat(rec.FB_Price_48_71) || 0,
            FB_Price_72plus: parseFloat(rec.FB_Price_72plus) || 0,
            Thumbnail_URL: thumbnailUrl.substring(0, 255),
            DST_Preview_URL: dstPreviewUrl.substring(0, 500),
            Artwork_URL: artworkUrl.substring(0, 255),
            Mockup_URL: (mockupByDN[dn] || '').substring(0, 500),
            Placement: (art?.Garment_Placement || '').substring(0, 255),
            Thread_Colors: (sw?.Thread_Colors || '').substring(0, 255),
            Last_Order_Date: sw?.Last_Order_Date || null,
            Order_Count: parseInt(sw?.Order_Count, 10) || 0,
            Art_Notes: (art?.NOTES || '').substring(0, 255),
            Sales_Rep: (customerId && customerToRep[customerId]) ? customerToRep[customerId].substring(0, 255) : '',
            Customer_Type: '',  // will be set below from lookup
            Is_Active: 'true',
            Date_Updated: new Date().toISOString()
        });

        // Set Customer_Type from CSV lookup (need to re-check after push)
        const lastRec = unifiedRecords[unifiedRecords.length - 1];
        const normalizedForType = normalizeCompanyName(company);
        if (normalizedForType && csvCompanyMap[normalizedForType]?.customerType) {
            lastRec.Customer_Type = csvCompanyMap[normalizedForType].customerType.substring(0, 255);
            enrichStats.customerTypeFilled++;
        }
        if (lastRec.Sales_Rep) enrichStats.salesRepFilled++;
    }

    // Also add designs that exist ONLY in ShopWorks_Designs (not in Master)
    // These are designs we know about but don't have full stitch data for
    for (const [dn, sw] of Object.entries(swByDN)) {
        if (masterDesignNumbers.has(dn)) continue; // Already handled via Master

        const thumb = thumbByDN[dn];
        const art = artByDN[dn];

        let swCompany = (sw.Company_Name || art?.CompanyName || art?.Company_Mockup || '').trim();
        const swCompanyFromMockup = swCompany && !(sw.Company_Name || '').trim() && !(art?.CompanyName || '').trim()
            && (art?.Company_Mockup || '').trim();
        let swCustomerType = '';

        let customerId = (art?.Shopwork_customer_number != null ? String(art.Shopwork_customer_number) : '').trim()
            || '';

        // Look up by company name — fills Customer_ID and corrects spelling
        if (swCompany) {
            const lookup = lookupCustomerByCompany(swCompany, companyToCustomerId);
            if (lookup) {
                if (lookup.customerType) swCustomerType = lookup.customerType;
                if (!customerId) {
                    customerId = lookup.customerId;
                    custIdStats.companyLookup++;
                    if (lookup.matchType === 'prefix') custIdStats.prefixMatches++;
                    if (swCompanyFromMockup) custIdStats.fromCompanyMockup++;
                }
                if (lookup.correctName && lookup.correctName !== swCompany) {
                    swCompany = lookup.correctName;
                    custIdStats.namesCorrected = (custIdStats.namesCorrected || 0) + 1;
                }
            }
        }
        if (customerId && art?.Shopwork_customer_number) custIdStats.fromArt++;

        unifiedRecords.push({
            Design_Number: parseInt(dn, 10) || 0,
            Design_Name: (sw.Design_Name || thumb?.designName || '').substring(0, 255),
            Company: swCompany.substring(0, 255),
            Customer_ID: customerId.substring(0, 255),
            Stitch_Count: parseInt(sw.Stitch_Count, 10) || 0,
            Stitch_Tier: (sw.Stitch_Tier || '').substring(0, 255),
            AS_Surcharge: parseFloat(sw.AS_Surcharge) || 0,
            DST_Filename: '',
            Color_Changes: 0,
            Extra_Colors: 0,
            Extra_Color_Surcharge: 0,
            FB_Price_1_7: 0,
            FB_Price_8_23: 0,
            FB_Price_24_47: 0,
            FB_Price_48_71: 0,
            FB_Price_72plus: 0,
            Thumbnail_URL: (thumb?.thumbnailUrl || boxByDN[dn] || '').substring(0, 255),
            DST_Preview_URL: '',
            Artwork_URL: (art?.CDN_Link && art.CDN_Link.length > 30 ? art.CDN_Link : '').substring(0, 255),
            Mockup_URL: (mockupByDN[dn] || '').substring(0, 500),
            Placement: (art?.Garment_Placement || '').substring(0, 255),
            Thread_Colors: (sw.Thread_Colors || '').substring(0, 255),
            Last_Order_Date: sw.Last_Order_Date || null,
            Order_Count: parseInt(sw.Order_Count, 10) || 0,
            Art_Notes: (art?.NOTES || '').substring(0, 255),
            Sales_Rep: (customerId && customerToRep[customerId]) ? customerToRep[customerId].substring(0, 255) : '',
            Customer_Type: swCustomerType.substring(0, 255),
            Is_Active: 'true',
            Date_Updated: new Date().toISOString()
        });
        if (customerId && customerToRep[customerId]) enrichStats.salesRepFilled++;
        if (swCustomerType) enrichStats.customerTypeFilled++;
    }

    // Also add designs that exist ONLY in ArtRequests (not in Master or ShopWorks)
    for (const [dn, art] of Object.entries(artByDN)) {
        if (masterDesignNumbers.has(dn)) continue;
        if (swByDN[dn]) continue; // Already handled

        const thumb = thumbByDN[dn];
        let artCompany = (art.CompanyName || '').trim()
            || (art.Company_Mockup || '').trim();
        const artCompanyFromMockup = artCompany && !(art.CompanyName || '').trim()
            && (art.Company_Mockup || '').trim();
        let artCustomerType = '';

        let artCustomerId = (art.Shopwork_customer_number != null ? String(art.Shopwork_customer_number) : '').trim();

        // Look up by company name — fills Customer_ID and corrects spelling
        if (artCompany) {
            const lookup = lookupCustomerByCompany(artCompany, companyToCustomerId);
            if (lookup) {
                if (lookup.customerType) artCustomerType = lookup.customerType;
                if (!artCustomerId) {
                    artCustomerId = lookup.customerId;
                    custIdStats.companyLookup++;
                    if (lookup.matchType === 'prefix') custIdStats.prefixMatches++;
                    if (artCompanyFromMockup) custIdStats.fromCompanyMockup++;
                }
                if (lookup.correctName && lookup.correctName !== artCompany) {
                    artCompany = lookup.correctName;
                    custIdStats.namesCorrected = (custIdStats.namesCorrected || 0) + 1;
                }
            }
        }
        if (artCustomerId && art.Shopwork_customer_number) custIdStats.fromArt++;

        unifiedRecords.push({
            Design_Number: parseInt(dn, 10) || 0,
            Design_Name: (thumb?.designName || '').substring(0, 255),
            Company: artCompany.substring(0, 255),
            Customer_ID: artCustomerId.substring(0, 255),
            Stitch_Count: 0,
            Stitch_Tier: '',
            AS_Surcharge: 0,
            DST_Filename: '',
            Color_Changes: 0,
            Extra_Colors: 0,
            Extra_Color_Surcharge: 0,
            FB_Price_1_7: 0,
            FB_Price_8_23: 0,
            FB_Price_24_47: 0,
            FB_Price_48_71: 0,
            FB_Price_72plus: 0,
            Thumbnail_URL: (thumb?.thumbnailUrl || boxByDN[dn] || '').substring(0, 255),
            DST_Preview_URL: '',
            Artwork_URL: (art.CDN_Link && art.CDN_Link.length > 30 ? art.CDN_Link : '').substring(0, 255),
            Mockup_URL: (mockupByDN[dn] || '').substring(0, 500),
            Placement: (art.Garment_Placement || '').substring(0, 255),
            Thread_Colors: '',
            Last_Order_Date: null,
            Order_Count: 0,
            Art_Notes: (art.NOTES || '').substring(0, 255),
            Sales_Rep: (artCustomerId && customerToRep[artCustomerId]) ? customerToRep[artCustomerId].substring(0, 255) : '',
            Customer_Type: artCustomerType.substring(0, 255),
            Is_Active: 'true',
            Date_Updated: new Date().toISOString()
        });
        if (artCustomerId && customerToRep[artCustomerId]) enrichStats.salesRepFilled++;
        if (artCustomerType) enrichStats.customerTypeFilled++;
    }

    // Count remaining missing
    const filtered = unifiedRecords.filter(r => r.Design_Number > 0);
    custIdStats.stillMissing = filtered.filter(r => !r.Customer_ID).length;

    // Log enrichment stats
    console.log('\n  Customer_ID enrichment stats:');
    console.log(`    From Master table:       ${custIdStats.fromMaster.toLocaleString()}`);
    console.log(`    From ArtRequests:         ${custIdStats.fromArt.toLocaleString()}`);
    console.log(`    From company name lookup: ${custIdStats.companyLookup.toLocaleString()} (${custIdStats.prefixMatches} prefix matches)`);
    console.log(`    Via Company_Mockup field: ${custIdStats.fromCompanyMockup.toLocaleString()} (CompanyName empty, matched via Company_Mockup)`);
    console.log(`    Company names corrected:  ${custIdStats.namesCorrected.toLocaleString()} (spelling fixed from CSV)`);
    console.log(`    Still missing:            ${custIdStats.stillMissing.toLocaleString()} (${(custIdStats.stillMissing / filtered.length * 100).toFixed(1)}%)`);
    console.log(`\n  Additional enrichment stats:`);
    console.log(`    Sales_Rep filled:         ${enrichStats.salesRepFilled.toLocaleString()} (${(enrichStats.salesRepFilled / filtered.length * 100).toFixed(1)}%)`);
    console.log(`    Customer_Type filled:     ${enrichStats.customerTypeFilled.toLocaleString()} (${(enrichStats.customerTypeFilled / filtered.length * 100).toFixed(1)}%)`);

    return filtered;
}

// ============================================
// Main sync logic
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Design Lookup Sync — Unified Table Builder');
    console.log(`Mode: ${LIVE_MODE ? '🔴 LIVE (writing to Caspio)' : '🟢 DRY RUN (preview only)'}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    // Validate env
    if (!CASPIO_DOMAIN || !CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('FATAL: Missing CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, or CASPIO_CLIENT_SECRET');
        process.exit(1);
    }

    // -----------------------------------------------
    // Step 1: Fetch all 4 source tables in parallel
    // -----------------------------------------------
    console.log('\n📥 Step 1: Fetching source tables...');
    const startFetch = Date.now();

    const [masterRecords, shopworksRecords, thumbnailRecords, artRecords] = await Promise.all([
        fetchAll(TABLES.master, { 'q.select': FIELDS.master }).catch(err => {
            console.error(`  ❌ Master table failed: ${err.message}`);
            return [];
        }),
        fetchAll(TABLES.shopworks, { 'q.select': FIELDS.shopworks }).catch(err => {
            console.error(`  ❌ ShopWorks_Designs failed: ${err.message}`);
            return [];
        }),
        fetchAll(TABLES.thumbnail, { 'q.select': FIELDS.thumbnail }).catch(err => {
            console.error(`  ❌ Thumbnail Report failed: ${err.message}`);
            return [];
        }),
        fetchAll(TABLES.artRequests, { 'q.select': FIELDS.artRequests }).catch(err => {
            console.error(`  ❌ ArtRequests failed: ${err.message}`);
            return [];
        })
    ]);

    const fetchTime = ((Date.now() - startFetch) / 1000).toFixed(1);
    console.log(`\n  Source table counts (fetched in ${fetchTime}s):`);
    console.log(`    Master:           ${masterRecords.length.toLocaleString()} records`);
    console.log(`    ShopWorks_Designs: ${shopworksRecords.length.toLocaleString()} records`);
    console.log(`    Thumbnail_Report:  ${thumbnailRecords.length.toLocaleString()} records`);
    console.log(`    ArtRequests:       ${artRecords.length.toLocaleString()} records`);

    if (masterRecords.length === 0) {
        console.error('\n❌ Master table returned 0 records — aborting to prevent data loss.');
        process.exit(1);
    }

    // -----------------------------------------------
    // Step 1b: Fetch customer mapping tables for Customer_ID enrichment
    // -----------------------------------------------
    console.log('\n📥 Step 1b: Fetching customer mapping tables...');
    const startCustFetch = Date.now();

    const [salesRepsRecs, contactsRecs, houseRecs, taneishaRecs, nikaRecs] = await Promise.all([
        fetchAll(TABLES.salesReps, { 'q.select': 'ID_Customer,CompanyName,Account_Tier' }).catch(err => {
            console.error(`  ❌ Sales_Reps_2026 failed: ${err.message}`);
            return [];
        }),
        fetchAll(TABLES.contacts, { 'q.select': 'id_Customer,CustomerCompanyName' }).catch(err => {
            console.error(`  ❌ Company_Contacts failed: ${err.message}`);
            return [];
        }),
        fetchAll(TABLES.houseAccounts, { 'q.select': 'ID_Customer,CompanyName' }).catch(err => {
            console.error(`  ❌ House_Accounts failed: ${err.message}`);
            return [];
        }),
        fetchAll(TABLES.taneishaAccounts, { 'q.select': 'ID_Customer,CompanyName' }).catch(err => {
            console.error(`  ❌ Taneisha accounts failed: ${err.message}`);
            return [];
        }),
        fetchAll(TABLES.nikaAccounts, { 'q.select': 'ID_Customer,CompanyName' }).catch(err => {
            console.error(`  ❌ Nika accounts failed: ${err.message}`);
            return [];
        })
    ]);

    const custFetchTime = ((Date.now() - startCustFetch) / 1000).toFixed(1);
    console.log(`\n  Customer mapping tables (fetched in ${custFetchTime}s):`);
    console.log(`    Sales_Reps_2026:       ${salesRepsRecs.length.toLocaleString()} records`);
    console.log(`    Company_Contacts:      ${contactsRecs.length.toLocaleString()} records`);
    console.log(`    House_Accounts:        ${houseRecs.length.toLocaleString()} records`);
    console.log(`    Taneisha_Accounts:     ${taneishaRecs.length.toLocaleString()} records`);
    console.log(`    Nika_Accounts:         ${nikaRecs.length.toLocaleString()} records`);

    // Build unified company → customer_id lookup map
    // Priority: CSV (authoritative) → Sales_Reps → Contacts → Rep accounts → House
    const companyToCustomerId = buildCompanyCustomerMap(
        salesRepsRecs, contactsRecs, houseRecs, taneishaRecs, nikaRecs
    );
    console.log(`  Combined lookup map: ${Object.keys(companyToCustomerId).length.toLocaleString()} unique companies`);
    if (csvLoaded) {
        console.log(`  (includes ${Object.keys(csvCompanyMap).length.toLocaleString()} from CSV — highest priority)`);
    }

    // Build customer_id → sales_rep lookup map
    const customerToRep = buildCustomerToRepMap(salesRepsRecs, taneishaRecs, nikaRecs);

    // -----------------------------------------------
    // Step 2: Merge into unified records
    // -----------------------------------------------
    console.log('\n🔀 Step 2: Merging into unified records...');
    const unifiedRecords = buildUnifiedRecords(masterRecords, shopworksRecords, thumbnailRecords, artRecords, companyToCustomerId, customerToRep);

    // Count unique design numbers
    const uniqueDesigns = new Set(unifiedRecords.map(r => r.Design_Number));
    const withCustomerId = unifiedRecords.filter(r => r.Customer_ID).length;
    const withThumbnail = unifiedRecords.filter(r => r.Thumbnail_URL).length;
    const withDstPreview = unifiedRecords.filter(r => r.DST_Preview_URL).length;
    const withMockup = unifiedRecords.filter(r => r.Mockup_URL).length;
    const withArtwork = unifiedRecords.filter(r => r.Artwork_URL).length;
    const withDesignName = unifiedRecords.filter(r => r.Design_Name).length;
    const withStitchData = unifiedRecords.filter(r => r.Stitch_Count > 0).length;

    console.log(`\n  Unified records: ${unifiedRecords.length.toLocaleString()} total rows`);
    console.log(`  Unique design numbers: ${uniqueDesigns.size.toLocaleString()}`);
    console.log(`  With Customer_ID: ${withCustomerId.toLocaleString()} (${(withCustomerId / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With stitch data: ${withStitchData.toLocaleString()} (${(withStitchData / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With design name: ${withDesignName.toLocaleString()} (${(withDesignName / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With thumbnail: ${withThumbnail.toLocaleString()} (${(withThumbnail / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With DST preview: ${withDstPreview.toLocaleString()} (${(withDstPreview / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With mockup: ${withMockup.toLocaleString()} (${(withMockup / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With artwork: ${withArtwork.toLocaleString()} (${(withArtwork / unifiedRecords.length * 100).toFixed(1)}%)`);

    const withSalesRep = unifiedRecords.filter(r => r.Sales_Rep).length;
    const withCustomerType = unifiedRecords.filter(r => r.Customer_Type).length;
    console.log(`  With Sales_Rep: ${withSalesRep.toLocaleString()} (${(withSalesRep / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With Customer_Type: ${withCustomerType.toLocaleString()} (${(withCustomerType / unifiedRecords.length * 100).toFixed(1)}%)`);

    // Show sample records
    console.log('\n  Sample records (first 5):');
    for (const rec of unifiedRecords.slice(0, 5)) {
        const repTag = rec.Sales_Rep ? ` [${rec.Sales_Rep}]` : '';
        const typeTag = rec.Customer_Type ? ` (${rec.Customer_Type})` : '';
        console.log(`    Design #${rec.Design_Number} — "${rec.Design_Name}" (${rec.Company}${repTag}${typeTag}) — ${rec.Stitch_Count} stitches, ${rec.Stitch_Tier}`);
    }

    // CSV export short-circuits BOTH modes — it never touches Caspio.
    if (CSV_OUT) {
        const out = writeCsv(unifiedRecords, CSV_OUT);
        console.log('\n' + '='.repeat(60));
        console.log('CSV EXPORT COMPLETE — nothing written to Caspio.');
        console.log(`  File:    ${CSV_OUT}`);
        console.log(`  Rows:    ${out.rows.toLocaleString()} (+1 header)`);
        console.log(`  Size:    ${(out.bytes / 1048576).toFixed(1)} MB`);
        console.log(`  Columns: ${CSV_COLUMNS.length} — ${CSV_COLUMNS.join(', ')}`);
        console.log('');
        console.log('  Import into Caspio table: Design_Lookup_2026');
        console.log('  The table must be EMPTIED first — this is a full replace,');
        console.log('  not an append. Every row is regenerated from source each run.');
        console.log('='.repeat(60));
        return;
    }

    if (!LIVE_MODE) {
        console.log('\n' + '='.repeat(60));
        console.log('DRY RUN COMPLETE — No data written.');
        console.log(`To write ${unifiedRecords.length} records to ${TABLES.unified}, run:`);
        console.log('  node scripts/sync-design-lookup.js --live');
        console.log('='.repeat(60));
        return;
    }

    // -----------------------------------------------
    // Step 3: Clear existing unified table
    // -----------------------------------------------
    console.log('\n🗑️  Step 3: Clearing existing unified table...');
    const before = await countRecords(TABLES.unified);
    console.log(`  Table currently holds ${fmtCount(before)} rows`);
    try {
        const del = await deleteAllRecords(TABLES.unified);
        console.log(`  Deleted ${fmtCount(del.totalDeleted)}; ${fmtCount(del.remaining)} remaining`);

        // 🔴 ABORT rather than insert on top. Inserting into a table that still
        // holds rows is what produced 4-5 duplicate copies of every design
        // (see deleteAllRecords). A no-op run is recoverable; a stacked one is
        // not, and it silently corrupts every consumer of this table.
        if (del.remaining !== 0) {
            console.error(`\n❌ ABORTED — ${fmtCount(del.remaining)} rows survived the delete.`);
            console.error('   Refusing to insert on top: that is exactly how this table');
            console.error('   accumulated ~4x duplicate rows in February.');
            console.error('   The table is UNCHANGED apart from whatever the delete removed.');
            process.exitCode = 1;
            return;
        }
    } catch (err) {
        console.error(`\n❌ ABORTED — delete failed: ${err.message}`);
        console.error('   Nothing was inserted; the table is unchanged.');
        process.exitCode = 1;
        return;
    }

    // -----------------------------------------------
    // Step 4: Insert all records (concurrent individual POSTs)
    // Note: Caspio REST v3 does NOT support batch/array POST.
    // We use concurrency (5 parallel requests) to maximize throughput.
    // -----------------------------------------------
    // Concurrency 4 + adaptive pacing, NOT 10 + a 50ms sleep. The fast settings
    // tripped Caspio's per-second limiter on 2026-08-05 and 429'd the whole
    // account (reads included) after 2,520 rows. Slower and finishing beats
    // faster and leaving the table half-written.
    console.log('\n📤 Step 4: Inserting records (concurrency=4, adaptive pacing)...');
    const startWrite = Date.now();

    const stats = await insertWithConcurrency(TABLES.unified, unifiedRecords, 4, (done, total, elapsed, s, delayMs) => {
        console.log(`  Progress: ${done}/${total} (${elapsed}s) — inserted=${s.inserted}, errors=${s.errors}, pacing=${delayMs}ms`);
    });

    // A partially-written table is the dangerous outcome: it reads as valid and
    // silently under-serves every consumer. Say so loudly and exit non-zero.
    if (stats.errors > 0) {
        console.error(`\n❌ ${stats.errors} record(s) never landed — the table is INCOMPLETE.`);
        const byStatus = {};
        for (const f of stats.failures || []) byStatus[f.status || 'unknown'] = (byStatus[f.status || 'unknown'] || 0) + 1;
        console.error(`   Failure statuses: ${JSON.stringify(byStatus)}`);
        console.error(`   Re-run the sync once Caspio is healthy — it is a full refresh, so a clean re-run fixes it.`);
        process.exitCode = 1;
    }

    const writeTime = ((Date.now() - startWrite) / 1000).toFixed(1);

    // -----------------------------------------------
    // Summary
    // -----------------------------------------------
    console.log('\n' + '='.repeat(60));
    console.log('SYNC COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Records processed: ${unifiedRecords.length.toLocaleString()}`);
    console.log(`  Inserted:  ${stats.inserted.toLocaleString()}`);
    console.log(`  Errors:    ${stats.errors.toLocaleString()}`);
    console.log(`  Write time: ${writeTime}s`);
    console.log(`  Finished: ${new Date().toISOString()}`);

    if (parseFloat(writeTime) > 0) {
        console.log(`\n  Speed: ${(stats.inserted / parseFloat(writeTime)).toFixed(0)} records/sec`);
    }

    if (stats.errors > 0) {
        console.log('\n⚠️  Some records had errors — review output above.');
        process.exit(1);
    }
}

// Run
main().catch(err => {
    console.error('\n💥 Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
