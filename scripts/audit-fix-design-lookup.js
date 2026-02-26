#!/usr/bin/env node
/**
 * Design_Lookup_2026 — Data Quality Audit & Fix
 *
 * 7-phase cleanup script that addresses multiple data quality issues
 * found during full CSV export audit (159,009 rows).
 *
 * Usage:
 *   node scripts/audit-fix-design-lookup.js               # Dry-run (CSV report only)
 *   node scripts/audit-fix-design-lookup.js --live         # Apply all fixes
 *   node scripts/audit-fix-design-lookup.js --phase=7      # Run only one phase
 *   node scripts/audit-fix-design-lookup.js --verbose      # Extra logging
 *
 * Phases:
 *   1. DEAD Deactivation (~7,303 rows)
 *   2. Empty Record Deactivation (~4,300 rows)
 *   3. Test Entry Deactivation (~24 rows)
 *   4. Art_Notes Newline Cleanup (~50-100 rows)
 *   5. Customer_Type Enrichment (~50-80K rows)
 *   6. Sales_Rep Enrichment (~40-60K rows)
 *   7. Design_Name Company Parsing + Fuzzy Match (~16,600 rows)
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

// Parse --phase=N
const phaseArg = process.argv.find(a => a.startsWith('--phase='));
const ONLY_PHASE = phaseArg ? parseInt(phaseArg.split('=')[1], 10) : null;

const TABLE = 'Design_Lookup_2026';

// Fuzzy matching thresholds
const AUTO_FIX_THRESHOLD = 0.90;
const REVIEW_THRESHOLD = 0.75;
const MIN_FUZZY_LENGTH = 4;

// ============================================
// Shared utilities (from backfill & fuzzy scripts)
// ============================================

function normalizeCompanyName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .trim()
        .replace(/[.,;:!?'"()[\]{}]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\b(inc|llc|ltd|corp|co|the|and)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeSQL(str) {
    if (!str) return '';
    return str.replace(/'/g, "''");
}

function escapeCSV(str) {
    if (str == null) return '';
    str = String(str);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================
// CSV company list loading
// ============================================

const CSV_PATTERNS = ['company-customer-ids.csv', 'company-customers.csv', 'customer-ids.csv', 'Full Company List 2026.csv'];
let csvCompanyMap = {};

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
                i++;
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

// Build customerIdToType and customerIdToName maps from the CSV
let customerIdToType = {};
let customerIdToName = {};

function loadCompanyCSV() {
    const dataDir = path.join(__dirname, 'data');
    let csvFile = null;
    for (const pattern of CSV_PATTERNS) {
        const candidate = path.join(dataDir, pattern);
        if (fs.existsSync(candidate)) { csvFile = candidate; break; }
    }
    if (!csvFile && fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir);
        for (const f of files) {
            if (f.endsWith('.csv') && (f.toLowerCase().includes('company') || f.toLowerCase().includes('customer'))) {
                csvFile = path.join(dataDir, f);
                break;
            }
        }
    }
    if (!csvFile) { console.warn('[Init] No CSV file found'); return; }

    console.log(`[Init] Loading CSV: ${path.basename(csvFile)}`);
    const raw = fs.readFileSync(csvFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return;

    const header = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
    const companyCol = header.findIndex(h => /^(company|companyname|company_name|customercompanyname|name)$/i.test(h));
    const idCol = header.findIndex(h => /^(id_customer|customer_id|customerid|id|shopworks_id)$/i.test(h));
    const typeCol = header.findIndex(h => /^(customertype|customer_type|type)$/i.test(h));
    if (companyCol === -1 || idCol === -1) { console.warn('[Init] CSV header not recognized'); return; }

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (!fields || fields.length <= Math.max(companyCol, idCol)) continue;
        const company = (fields[companyCol] || '').trim();
        const custId = (fields[idCol] || '').trim();
        const custType = typeCol >= 0 && fields[typeCol] ? fields[typeCol].trim() : '';
        if (!company || !custId || custId === '0') continue;

        // Company name → customer mapping
        const normalized = normalizeCompanyName(company);
        if (normalized && !csvCompanyMap[normalized]) {
            csvCompanyMap[normalized] = { custId, correctName: company };
            count++;
        }

        // Customer ID → type mapping (for Phase 5)
        if (custType && !customerIdToType[custId]) {
            customerIdToType[custId] = custType;
        }

        // Customer ID → name mapping
        if (!customerIdToName[custId]) {
            customerIdToName[custId] = company;
        }
    }
    console.log(`[Init] Loaded ${count.toLocaleString()} company→customer mappings from CSV`);
    console.log(`[Init] Loaded ${Object.keys(customerIdToType).length.toLocaleString()} customerID→type mappings`);
}

function lookupCustomerByCompany(company, strictPrefix) {
    if (!company) return null;
    const normalized = normalizeCompanyName(company);
    if (!normalized) return null;

    // Exact match
    const entry = csvCompanyMap[normalized];
    if (entry) {
        return {
            customerId: typeof entry === 'object' ? entry.custId : entry,
            correctName: typeof entry === 'object' ? entry.correctName : null,
            matchType: 'exact'
        };
    }

    // Prefix match — require longer prefix for Phase 7 (strictPrefix=true) to reduce false positives
    const minLen = strictPrefix ? 12 : 8;
    if (normalized.length >= minLen) {
        const prefix = normalized.substring(0, Math.min(normalized.length, 15));
        for (const [key, val] of Object.entries(csvCompanyMap)) {
            // In strict mode, require the key to be at least 8 chars and cover at least 40% of candidate length
            if (strictPrefix && (key.length < 8 || key.length < normalized.length * 0.4)) continue;
            if (key.startsWith(prefix) || prefix.startsWith(key.substring(0, Math.min(key.length, 15)))) {
                return {
                    customerId: typeof val === 'object' ? val.custId : val,
                    correctName: typeof val === 'object' ? val.correctName : null,
                    matchType: 'prefix'
                };
            }
        }
    }
    return null;
}

// ============================================
// Caspio API helpers
// ============================================

let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (accessToken && now < tokenExpiry - 60) return accessToken;
    const resp = await axios.post(CASPIO_TOKEN_URL, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CASPIO_CLIENT_ID,
        client_secret: CASPIO_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    accessToken = resp.data.access_token;
    tokenExpiry = now + resp.data.expires_in;
    return accessToken;
}

async function fetchAll(tableName, params = {}) {
    const token = await getToken();
    let allResults = [];
    let page = 1;
    const pageSize = 1000;
    while (true) {
        const reqParams = { ...params, 'q.pageNumber': page, 'q.pageSize': pageSize };
        const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;
        try {
            const resp = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                params: reqParams, timeout: 30000
            });
            const records = resp.data?.Result || [];
            allResults = allResults.concat(records);
            if (records.length < pageSize) break;
            page++;
            if (page > 200) break;
        } catch (err) {
            if (err.response?.status === 404) return [];
            throw err;
        }
    }
    return allResults;
}

async function updateRecord(tableName, whereClause, updateData) {
    if (!LIVE_MODE) return { dryRun: true, RecordsAffected: 0 };
    const token = await getToken();
    const url = `${CASPIO_API_BASE}/tables/${tableName}/records?q.where=${encodeURIComponent(whereClause)}`;
    const resp = await axios.put(url, updateData, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });
    return resp.data;
}

// ============================================
// Build full company map (CSV + Caspio tables)
// ============================================

// Also build rep maps for Phase 6
let customerIdToRep = {};

async function buildFullCompanyMap() {
    console.log('\n📥 Fetching customer mapping tables from Caspio...');
    const [salesReps, contacts, house, taneisha, nika] = await Promise.all([
        fetchAll('Sales_Reps_2026', { 'q.select': 'ID_Customer,CompanyName' }).catch(() => []),
        fetchAll('Company_Contacts_Merge_ODBC', { 'q.select': 'id_Customer,CustomerCompanyName' }).catch(() => []),
        fetchAll('House_Accounts', { 'q.select': 'ID_Customer,CompanyName' }).catch(() => []),
        fetchAll('Taneisha_All_Accounts_Caspio', { 'q.select': 'ID_Customer,CompanyName' }).catch(() => []),
        fetchAll('Nika_All_Accounts_Caspio', { 'q.select': 'ID_Customer,CompanyName' }).catch(() => [])
    ]);
    console.log(`  SalesReps: ${salesReps.length}, Contacts: ${contacts.length}, House: ${house.length}, Taneisha: ${taneisha.length}, Nika: ${nika.length}`);

    let added = 0;
    function addMapping(company, custId) {
        if (!company || !custId || String(custId).trim() === '0') return;
        const n = normalizeCompanyName(company);
        if (n && !csvCompanyMap[n]) { csvCompanyMap[n] = { custId: String(custId).trim(), correctName: company.trim() }; added++; }
    }
    for (const r of salesReps) addMapping(r.CompanyName, r.ID_Customer);
    for (const r of contacts) addMapping(r.CustomerCompanyName, r.id_Customer);
    for (const r of taneisha) addMapping(r.CompanyName, r.ID_Customer);
    for (const r of nika) addMapping(r.CompanyName, r.ID_Customer);
    for (const r of house) addMapping(r.CompanyName, r.ID_Customer);

    // Build rep maps for Phase 6
    for (const r of taneisha) {
        const id = String(r.ID_Customer || '').trim();
        if (id && id !== '0') customerIdToRep[id] = 'Taneisha';
    }
    for (const r of nika) {
        const id = String(r.ID_Customer || '').trim();
        if (id && id !== '0') customerIdToRep[id] = 'Nika';
    }

    console.log(`  Added ${added} from Caspio tables (total map: ${Object.keys(csvCompanyMap).length.toLocaleString()} companies)`);
    console.log(`  Rep assignments: Taneisha=${Object.values(customerIdToRep).filter(v => v === 'Taneisha').length}, Nika=${Object.values(customerIdToRep).filter(v => v === 'Nika').length}`);
}

// ============================================
// Fuzzy matching algorithms (from fuzzy-match-companies.js)
// ============================================

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    if (a.length > b.length) [a, b] = [b, a];
    const m = a.length, n = b.length;
    let prev = Array.from({ length: m + 1 }, (_, i) => i);
    let curr = new Array(m + 1);
    for (let j = 1; j <= n; j++) {
        curr[0] = j;
        for (let i = 1; i <= m; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[m];
}

function levSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
}

function tokenSimilarity(a, b) {
    const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 1));
    const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 1));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let intersection = 0;
    for (const t of tokensA) { if (tokensB.has(t)) intersection++; }
    const union = new Set([...tokensA, ...tokensB]).size;
    return intersection / union;
}

function computeMatchScore(unmatchedRaw, officialRaw) {
    const unmatchedNorm = normalizeCompanyName(unmatchedRaw);
    const officialNorm = normalizeCompanyName(officialRaw);
    if (unmatchedNorm === officialNorm) return { score: 1.0, method: 'exact-normalized' };

    const levNorm = levSimilarity(unmatchedNorm, officialNorm);
    const levRaw = levSimilarity(unmatchedRaw.toLowerCase(), officialRaw.toLowerCase());
    const stripAll = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const levStripped = levSimilarity(stripAll(unmatchedRaw), stripAll(officialRaw));
    const tokenScore = tokenSimilarity(unmatchedNorm, officialNorm);

    const containsBonus = (unmatchedNorm.includes(officialNorm) || officialNorm.includes(unmatchedNorm)) ? 0.08 : 0;
    const firstWordA = unmatchedNorm.split(' ')[0] || '';
    const firstWordB = officialNorm.split(' ')[0] || '';
    const firstWordBonus = (firstWordA === firstWordB && firstWordA.length >= 3) ? 0.05 : 0;

    const baseScore = Math.max(levNorm, levRaw, levStripped, tokenScore);
    const composite = Math.min(1.0, baseScore + containsBonus + firstWordBonus);

    let method = 'composite';
    if (baseScore === levStripped && levStripped > levNorm && levStripped > levRaw) method = 'stripped-match';
    else if (baseScore === levNorm || baseScore === levRaw) method = 'levenshtein';
    else if (baseScore === tokenScore) method = 'token-match';

    return { score: composite, method };
}

function findBestMatch(unmatchedName, officialEntries) {
    const normalized = normalizeCompanyName(unmatchedName);
    if (normalized.length < MIN_FUZZY_LENGTH) {
        return { bestMatch: null, bestScore: 0, method: 'too-short' };
    }
    let bestMatch = null, bestScore = 0, bestMethod = 'none';
    for (const entry of officialEntries) {
        const lenRatio = normalized.length / Math.max(entry.normalized.length, 1);
        if (lenRatio > 2.5 || lenRatio < 0.4) continue;
        const result = computeMatchScore(unmatchedName, entry.raw);
        if (result.score > bestScore) {
            bestScore = result.score;
            bestMatch = entry;
            bestMethod = result.method;
        }
        if (bestScore >= 1.0) break;
    }
    return { bestMatch, bestScore, method: bestMethod };
}

// ============================================
// Design_Name parser (Phase 7)
// ============================================

// Leading design code with optional comma/space after (P####, T####, M####, R####, J####, C####, W####)
const LEADING_CODE_RE = /^[PTMRJCW]\d{2,5}[\s,&]*(?:&\s*[PTMRJCW]?\d{2,5}[\s,]*)*/i;

// Placement keywords to strip (case-insensitive, used as both leading and trailing patterns)
const PLACEMENT_PATTERNS = [
    'left chest', 'right chest', 'l\\/c', 'lc', 'r\\/c', 'rc',
    'full back', 'fb',
    'cap front', 'cap back', 'cap side', 'cap',
    'hat front', 'hat back', 'hat',
    'apron front', 'apron',
    'left sleeve', 'right sleeve', 'sleeve',
    'front', 'back',
    'hood', 'visor', 'pocket',
    'blanket', 'towel', 'tote', 'bag',
    'toboggan', 'beanie',
    'screenprint', 'screen print',
];
const PLACEMENT_RE = new RegExp(
    '(?:^|[,\\s]+)(?:' + PLACEMENT_PATTERNS.join('|') + ')(?:[,\\s]+|$)',
    'gi'
);

// Trailing descriptors to strip
const TRAILING_RE = /\s*(?:w\/\s*logo|w\/\s*text|w\/\s*fill|w\/\s*name|-\s*revised|-\s*new\b|-\s*old\b|-\s*updated|-\s*redo|-\s*fixed|OLD\s*LOGO|NEW\s*LOGO|DONOT\s*USE|DO\s*NOT\s*USE|\(reduced\)|\(new\)|\(old\)|\(revised\))\s*$/i;

// Trailing year (4-digit standalone year 1990-2029)
const TRAILING_YEAR_RE = /\s+(?:19|20)\d{2}\s*$/;

// Blacklist: parsed candidates that are descriptions, not companies
const PARSED_BLACKLIST = new Set([
    'blank', 'american', 'national', 'flag', 'logo', 'design', 'custom',
    'eagle', 'stars', 'compass', 'golf', 'ball', 'clip', 'magnet',
    'chrome', 'oval', 'circle', 'square', 'shield', 'patch',
    'blue', 'red', 'green', 'black', 'white', 'gold', 'silver',
    'large', 'small', 'medium', 'new', 'old', 'revised',
    'embroidery', 'screenprint', 'digitizing',
]);

function parseCompanyFromDesignName(designName) {
    if (!designName) return null;

    let text = designName.trim();

    // Step 1: Strip leading design code(s) — e.g., "P2641, " or "M5277 & M5278 "
    text = text.replace(LEADING_CODE_RE, '').trim();
    // Strip leading comma/space/colon artifacts (handles "Cap: ..." patterns)
    text = text.replace(/^[,:;\s]+/, '').trim();

    if (!text) return null;

    // Step 2: Strip placement keywords (may appear at start, end, or middle)
    // Multiple passes to catch nested placements like "L/C Left Chest"
    for (let pass = 0; pass < 3; pass++) {
        const before = text;
        text = text.replace(PLACEMENT_RE, ' ').trim();
        text = text.replace(/^[,\s:]+/, '').replace(/[,\s:]+$/, '').trim();
        if (text === before) break;
    }

    if (!text) return null;

    // Step 3: Strip trailing year
    text = text.replace(TRAILING_YEAR_RE, '').trim();

    // Step 4: Strip trailing descriptors
    text = text.replace(TRAILING_RE, '').trim();
    // Second pass for chained trailing descriptors
    text = text.replace(TRAILING_RE, '').trim();

    // Step 5: Clean up remaining artifacts
    text = text.replace(/^[-,;:\s]+/, '').replace(/[-,;:\s]+$/, '').trim();

    // Must have at least 3 chars remaining to be a company candidate
    if (text.length < 3) return null;

    // Skip if it's purely a design description (numbers only, hash codes, etc.)
    if (/^\d+$/.test(text)) return null;
    if (/^#\d+/.test(text)) return null;

    // Skip blacklisted single-word generic terms
    const normalized = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (PARSED_BLACKLIST.has(normalized)) return null;

    // Skip if too generic (single word under 5 chars)
    const words = text.split(/\s+/);
    if (words.length === 1 && text.length < 5) return null;

    return text;
}

// ============================================
// CSV Report Builder
// ============================================

const csvRows = []; // Accumulated across all phases

function addCSVRow(phase, action, designNumber, designName, currentCompany, parsedCompany, bestMatch, customerId, customerType, salesRep, score, recordCount, notes) {
    csvRows.push([
        phase, action,
        escapeCSV(designNumber), escapeCSV(designName), escapeCSV(currentCompany),
        escapeCSV(parsedCompany), escapeCSV(bestMatch),
        customerId || '', customerType || '', salesRep || '',
        score != null ? Math.round(score * 1000) / 1000 : '',
        recordCount || '',
        escapeCSV(notes)
    ].join(','));
}

function writeCSV() {
    const header = 'Phase,Action,Design_Number,Design_Name,Current_Company,Parsed_Company,Best_Match,Customer_ID,Customer_Type,Sales_Rep,Score,Record_Count,Notes';
    const today = new Date().toISOString().slice(0, 10);
    const csvPath = path.join(os.homedir(), 'Downloads', `design-lookup-audit-${today}.csv`);
    fs.writeFileSync(csvPath, [header, ...csvRows].join('\n'), 'utf8');
    return csvPath;
}

// ============================================
// Phase summary tracking
// ============================================

const phaseSummary = {};

function logPhase(phase, key, value) {
    if (!phaseSummary[phase]) phaseSummary[phase] = {};
    phaseSummary[phase][key] = value;
}

// ============================================
// Phase 1: DEAD Deactivation
// ============================================

async function phase1_DeadDeactivation() {
    console.log('\n' + '═'.repeat(60));
    console.log('Phase 1: DEAD Deactivation');
    console.log('═'.repeat(60));

    // One bulk PUT: Customer_Type='DEAD' AND Is_Active='true' → Is_Active='false'
    try {
        const result = await updateRecord(TABLE,
            "Customer_Type='DEAD' AND Is_Active='true'",
            { Is_Active: 'false' });

        const affected = result?.RecordsAffected || 0;
        logPhase(1, 'records', affected);
        logPhase(1, 'action', 'Set Is_Active=false where Customer_Type=DEAD');

        if (LIVE_MODE) {
            console.log(`  ✅ ${affected} DEAD records deactivated`);
        } else {
            // Estimate by fetching count
            const deadRecs = await fetchAll(TABLE, {
                'q.select': 'Design_Number',
                'q.where': "Customer_Type='DEAD' AND Is_Active='true'"
            });
            console.log(`  🔵 [DRY RUN] Would deactivate ${deadRecs.length.toLocaleString()} DEAD records`);
            logPhase(1, 'records', deadRecs.length);
            addCSVRow(1, 'DEACTIVATE', '', '', '', '', '', '', 'DEAD', '', '', deadRecs.length, 'Set Is_Active=false for all DEAD customers');
        }
    } catch (err) {
        console.error(`  ❌ Phase 1 error: ${err.message}`);
        logPhase(1, 'error', err.message);
    }
}

// ============================================
// Phase 2: Empty Record Deactivation
// ============================================

async function phase2_EmptyDeactivation() {
    console.log('\n' + '═'.repeat(60));
    console.log('Phase 2: Empty Record Deactivation');
    console.log('═'.repeat(60));

    // Fetch ArtRequests-range records (50000+) that are still active
    console.log('  Fetching Design_Number >= 50000 AND Is_Active=true...');
    const recs = await fetchAll(TABLE, {
        'q.select': 'ID_Unique,Design_Number,Design_Name,Company,Customer_ID,Stitch_Count,Thumbnail_URL,Artwork_URL,Mockup_URL,DST_Preview_URL,Art_Notes',
        'q.where': "Design_Number>=50000 AND Is_Active='true'"
    });
    console.log(`  Fetched ${recs.length.toLocaleString()} records in 50000+ range`);

    // Filter for truly empty — no Design_Name, no Company, no Customer_ID, no images, no stitch data
    const emptyRecs = recs.filter(r => {
        const name = (r.Design_Name || '').trim();
        const company = (r.Company || '').trim();
        const custId = String(r.Customer_ID || '').trim();
        const stitches = parseInt(r.Stitch_Count || '0', 10);
        const thumb = (r.Thumbnail_URL || '').trim();
        const artwork = (r.Artwork_URL || '').trim();
        const mockup = (r.Mockup_URL || '').trim();
        const dst = (r.DST_Preview_URL || '').trim();
        const notes = (r.Art_Notes || '').trim();

        return !name && !company && (!custId || custId === '0') &&
               stitches === 0 && !thumb && !artwork && !mockup && !dst && !notes;
    });

    console.log(`  Truly empty records: ${emptyRecs.length.toLocaleString()}`);
    logPhase(2, 'records', emptyRecs.length);

    if (emptyRecs.length === 0) {
        console.log('  Nothing to do.');
        return;
    }

    // Batch by chunks of design numbers for efficient WHERE clauses
    let totalDeactivated = 0;
    let errors = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < emptyRecs.length; i += BATCH_SIZE) {
        const batch = emptyRecs.slice(i, i + BATCH_SIZE);
        const designNumbers = batch.map(r => r.Design_Number);

        // Build WHERE clause with IN list
        const inList = designNumbers.join(',');
        const where = `Design_Number IN (${inList}) AND Is_Active='true' AND Design_Name='' AND Company=''`;

        try {
            const result = await updateRecord(TABLE, where, { Is_Active: 'false' });
            totalDeactivated += result?.RecordsAffected || 0;
            await sleep(100);
        } catch (err) {
            errors++;
            if (errors <= 3) console.error(`    ❌ Batch error: ${err.message}`);
        }

        if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= emptyRecs.length) {
            console.log(`    ... ${Math.min(i + BATCH_SIZE, emptyRecs.length)}/${emptyRecs.length} processed`);
        }
    }

    if (LIVE_MODE) {
        console.log(`  ✅ ${totalDeactivated} empty records deactivated${errors > 0 ? `, ${errors} errors` : ''}`);
    } else {
        console.log(`  🔵 [DRY RUN] Would deactivate ${emptyRecs.length} empty records`);
        addCSVRow(2, 'DEACTIVATE', '', '', '', '', '', '', '', '', '', emptyRecs.length, 'Empty ArtRequests shells (50000+ range, no metadata)');
    }
}

// ============================================
// Phase 3: Test Entry Deactivation
// ============================================

async function phase3_TestDeactivation() {
    console.log('\n' + '═'.repeat(60));
    console.log('Phase 3: Test Entry Deactivation');
    console.log('═'.repeat(60));

    // Safe patterns — regex anchored to avoid false positives with "Demolition", "DeMolay", etc.
    const SAFE_TEST_PATTERNS = [
        /^erik\s+test/i,
        /^acme\s+test/i,
        /^test\s+design/i,
        /^erik\s+final\s+test/i,
        /^test$/i,
        /test\s+design\s*$/i,
        /\(test\s+design\)/i,
    ];

    // Fetch records matching test patterns — use specific queries to avoid "DEMO" false positives
    console.log('  Searching for test entries...');
    let testRecs = [];
    for (const testName of ['Erik Test', 'ACME TEST', 'Erik Final Test', 'Test Design', 'test']) {
        try {
            const recs = await fetchAll(TABLE, {
                'q.select': 'ID_Unique,Design_Number,Design_Name,Company,Is_Active',
                'q.where': `Design_Name LIKE '%${escapeSQL(testName)}%' AND Is_Active='true'`
            });
            testRecs = testRecs.concat(recs);
        } catch (err) {
            // Some queries may fail — that's ok
        }
    }

    // Deduplicate by Design_Number + Design_Name
    const seen = new Set();
    testRecs = testRecs.filter(r => {
        const key = `${r.Design_Number}-${r.Design_Name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Filter out obvious false positives (Demolition, DeMolay, Testament, Contest, etc.)
    const FALSE_POSITIVE_RE = /\b(demolit|demolay|demolay|contest|atest|latest|greatest|protest|testament|fastest|attest|detest)\b/i;
    testRecs = testRecs.filter(r => {
        const name = (r.Design_Name || '').trim();
        // Only keep if "test" appears as a standalone word (not inside other words)
        if (FALSE_POSITIVE_RE.test(name)) return false;
        // Must have "test" as a standalone word
        return /\btest\b/i.test(name);
    });

    console.log(`  Found ${testRecs.length} potential test entries`);

    // Classify: safe patterns → auto-deactivate, others → REVIEW-TEST
    const autoDeactivate = [];
    const reviewTest = [];

    for (const rec of testRecs) {
        const name = (rec.Design_Name || '').trim();
        const isSafe = SAFE_TEST_PATTERNS.some(re => re.test(name));
        if (isSafe) {
            autoDeactivate.push(rec);
        } else {
            reviewTest.push(rec);
        }
    }

    console.log(`  Safe auto-deactivate: ${autoDeactivate.length}`);
    console.log(`  Needs review: ${reviewTest.length}`);
    logPhase(3, 'auto', autoDeactivate.length);
    logPhase(3, 'review', reviewTest.length);

    // Deactivate safe entries
    let deactivated = 0;
    for (const rec of autoDeactivate) {
        try {
            const where = `Design_Number=${rec.Design_Number} AND Design_Name='${escapeSQL(rec.Design_Name)}' AND Is_Active='true'`;
            const result = await updateRecord(TABLE, where, { Is_Active: 'false' });
            deactivated += result?.RecordsAffected || 0;
            await sleep(50);
        } catch (err) {
            // Skip errors
        }
        addCSVRow(3, 'DEACTIVATE', rec.Design_Number, rec.Design_Name, rec.Company, '', '', '', '', '', '', 1, 'Test entry — safe list');
    }

    // Log review items
    for (const rec of reviewTest) {
        addCSVRow(3, 'REVIEW-TEST', rec.Design_Number, rec.Design_Name, rec.Company, '', '', '', '', '', '', 1, 'Possible test entry — needs manual review');
        if (VERBOSE) console.log(`    ⚠️  REVIEW: "${rec.Design_Name}" (Design #${rec.Design_Number})`);
    }

    if (LIVE_MODE) {
        console.log(`  ✅ ${deactivated} test entries deactivated`);
    } else {
        console.log(`  🔵 [DRY RUN] Would deactivate ${autoDeactivate.length} test entries`);
    }
}

// ============================================
// Phase 4: Art_Notes Newline Cleanup
// ============================================

async function phase4_ArtNotesCleanup() {
    console.log('\n' + '═'.repeat(60));
    console.log('Phase 4: Art_Notes Newline Cleanup');
    console.log('═'.repeat(60));

    // Fetch records with non-empty Art_Notes
    console.log('  Fetching records with Art_Notes...');
    const recs = await fetchAll(TABLE, {
        'q.select': 'ID_Unique,Design_Number,Art_Notes',
        'q.where': "Art_Notes<>''"
    });
    console.log(`  Records with Art_Notes: ${recs.length.toLocaleString()}`);

    // Filter for those containing newlines
    const needFix = recs.filter(r => {
        const notes = r.Art_Notes || '';
        return notes.includes('\n') || notes.includes('\r');
    });

    console.log(`  Records with newlines: ${needFix.length}`);
    logPhase(4, 'records', needFix.length);

    if (needFix.length === 0) {
        console.log('  Nothing to do.');
        return;
    }

    // Group by Design_Number to avoid redundant updates (same design = same Art_Notes)
    const designGroups = {};
    for (const rec of needFix) {
        const dn = String(rec.Design_Number);
        if (!designGroups[dn]) {
            designGroups[dn] = rec; // Keep first occurrence
        }
    }
    const uniqueDesigns = Object.keys(designGroups).length;
    console.log(`  Unique design numbers to update: ${uniqueDesigns}`);

    let fixed = 0;
    let errors = 0;
    let processed = 0;

    for (const [designNum, rec] of Object.entries(designGroups)) {
        const cleanNotes = rec.Art_Notes
            .replace(/\r\n/g, '; ')
            .replace(/\r/g, '; ')
            .replace(/\n/g, '; ')
            .replace(/;\s*;/g, ';')
            .replace(/\s+/g, ' ')
            .trim();

        try {
            // Use Design_Number as WHERE key (ID_Unique is empty in this table)
            const where = `Design_Number=${designNum}`;
            const result = await updateRecord(TABLE, where, { Art_Notes: cleanNotes });
            fixed += result?.RecordsAffected || 0;
            await sleep(50);
        } catch (err) {
            errors++;
            if (errors <= 3) console.error(`    ❌ Design #${designNum}: ${err.message}`);
        }

        addCSVRow(4, 'FIX-NOTES', designNum, '', '', '', '', '', '', '', '', 1,
            `Newlines replaced with "; " separator`);

        processed++;
        if (processed % 200 === 0) {
            console.log(`    ... ${processed}/${uniqueDesigns} designs processed (${fixed} records updated)`);
        }

        if (VERBOSE && fixed <= 5) {
            console.log(`    📝 Design #${designNum}: "${rec.Art_Notes.substring(0, 60)}..." → cleaned`);
        }
    }

    if (LIVE_MODE) {
        console.log(`  ✅ ${fixed} Art_Notes records cleaned across ${uniqueDesigns} designs${errors > 0 ? `, ${errors} errors` : ''}`);
    } else {
        console.log(`  🔵 [DRY RUN] Would clean ${needFix.length} Art_Notes records across ${uniqueDesigns} designs`);
    }
}

// ============================================
// Phase 5: Customer_Type Enrichment
// ============================================

async function phase5_CustomerTypeEnrichment() {
    console.log('\n' + '═'.repeat(60));
    console.log('Phase 5: Customer_Type Enrichment');
    console.log('═'.repeat(60));

    // Fetch records with Customer_ID > 0 but empty Customer_Type
    console.log('  Fetching records with Customer_ID > 0 and empty Customer_Type...');
    const recs = await fetchAll(TABLE, {
        'q.select': 'Customer_ID',
        'q.where': "Customer_ID>0 AND Customer_Type=''"
    });
    console.log(`  Records needing Customer_Type: ${recs.length.toLocaleString()}`);

    // Group by unique Customer_ID
    const uniqueIds = {};
    for (const rec of recs) {
        const id = String(rec.Customer_ID || '').trim();
        if (!id || id === '0') continue;
        uniqueIds[id] = (uniqueIds[id] || 0) + 1;
    }
    const uniqueIdCount = Object.keys(uniqueIds).length;
    console.log(`  Unique Customer_IDs: ${uniqueIdCount.toLocaleString()}`);

    // Match against customerIdToType map
    let matchCount = 0;
    let matchRecords = 0;
    let noTypeCount = 0;
    let noTypeRecords = 0;
    let enriched = 0;
    let errors = 0;

    const idsToUpdate = [];
    for (const [custId, recCount] of Object.entries(uniqueIds)) {
        const custType = customerIdToType[custId];
        if (custType) {
            idsToUpdate.push({ custId, custType, recCount });
            matchCount++;
            matchRecords += recCount;
        } else {
            noTypeCount++;
            noTypeRecords += recCount;
        }
    }

    console.log(`  Matched to Customer_Type: ${matchCount} IDs (${matchRecords.toLocaleString()} records)`);
    console.log(`  No type found: ${noTypeCount} IDs (${noTypeRecords.toLocaleString()} records)`);
    logPhase(5, 'matched', matchRecords);
    logPhase(5, 'unmatched', noTypeRecords);

    // Apply updates — one PUT per unique Customer_ID
    for (let i = 0; i < idsToUpdate.length; i++) {
        const { custId, custType, recCount } = idsToUpdate[i];
        try {
            const where = `Customer_ID=${custId} AND Customer_Type=''`;
            const result = await updateRecord(TABLE, where, { Customer_Type: custType });
            enriched += result?.RecordsAffected || 0;
            await sleep(50);
        } catch (err) {
            if (err.response?.status !== 400) {
                errors++;
                if (errors <= 5) console.error(`    ❌ CustID ${custId}: ${err.message}`);
            }
        }

        if ((i + 1) % 500 === 0 || i + 1 === idsToUpdate.length) {
            console.log(`    ... ${i + 1}/${idsToUpdate.length} Customer_IDs processed`);
        }
    }

    if (LIVE_MODE) {
        console.log(`  ✅ ${enriched.toLocaleString()} records enriched with Customer_Type${errors > 0 ? `, ${errors} errors` : ''}`);
    } else {
        console.log(`  🔵 [DRY RUN] Would enrich ${matchRecords.toLocaleString()} records with Customer_Type`);
        addCSVRow(5, 'ENRICH-TYPE', '', '', '', '', '', '', '', '', '', matchRecords, `${matchCount} unique Customer_IDs matched to types`);
    }
}

// ============================================
// Phase 6: Sales_Rep Enrichment
// ============================================

async function phase6_SalesRepEnrichment() {
    console.log('\n' + '═'.repeat(60));
    console.log('Phase 6: Sales_Rep Enrichment');
    console.log('═'.repeat(60));

    // Fetch records with Customer_ID > 0 but empty Sales_Rep
    console.log('  Fetching records with Customer_ID > 0 and empty Sales_Rep...');
    const recs = await fetchAll(TABLE, {
        'q.select': 'Customer_ID',
        'q.where': "Customer_ID>0 AND Sales_Rep=''"
    });
    console.log(`  Records needing Sales_Rep: ${recs.length.toLocaleString()}`);

    // Group by unique Customer_ID
    const uniqueIds = {};
    for (const rec of recs) {
        const id = String(rec.Customer_ID || '').trim();
        if (!id || id === '0') continue;
        uniqueIds[id] = (uniqueIds[id] || 0) + 1;
    }
    const uniqueIdCount = Object.keys(uniqueIds).length;
    console.log(`  Unique Customer_IDs: ${uniqueIdCount.toLocaleString()}`);

    // Match against customerIdToRep map
    let matchCount = 0;
    let matchRecords = 0;
    let noRepCount = 0;
    let noRepRecords = 0;
    let enriched = 0;
    let errors = 0;

    const idsToUpdate = [];
    for (const [custId, recCount] of Object.entries(uniqueIds)) {
        const rep = customerIdToRep[custId];
        if (rep) {
            idsToUpdate.push({ custId, rep, recCount });
            matchCount++;
            matchRecords += recCount;
        } else {
            noRepCount++;
            noRepRecords += recCount;
        }
    }

    console.log(`  Matched to Sales_Rep: ${matchCount} IDs (${matchRecords.toLocaleString()} records)`);
    console.log(`  No rep found: ${noRepCount} IDs (${noRepRecords.toLocaleString()} records)`);
    logPhase(6, 'matched', matchRecords);
    logPhase(6, 'unmatched', noRepRecords);

    // Apply updates — one PUT per unique Customer_ID
    for (let i = 0; i < idsToUpdate.length; i++) {
        const { custId, rep, recCount } = idsToUpdate[i];
        try {
            const where = `Customer_ID=${custId} AND Sales_Rep=''`;
            const result = await updateRecord(TABLE, where, { Sales_Rep: rep });
            enriched += result?.RecordsAffected || 0;
            await sleep(50);
        } catch (err) {
            if (err.response?.status !== 400) {
                errors++;
                if (errors <= 5) console.error(`    ❌ CustID ${custId}: ${err.message}`);
            }
        }

        if ((i + 1) % 500 === 0 || i + 1 === idsToUpdate.length) {
            console.log(`    ... ${i + 1}/${idsToUpdate.length} Customer_IDs processed`);
        }
    }

    if (LIVE_MODE) {
        console.log(`  ✅ ${enriched.toLocaleString()} records enriched with Sales_Rep${errors > 0 ? `, ${errors} errors` : ''}`);
    } else {
        console.log(`  🔵 [DRY RUN] Would enrich ${matchRecords.toLocaleString()} records with Sales_Rep`);
        addCSVRow(6, 'ENRICH-REP', '', '', '', '', '', '', '', '', '', matchRecords, `${matchCount} unique Customer_IDs matched to reps`);
    }
}

// ============================================
// Phase 7: Design_Name Company Parsing + Fuzzy Match
// ============================================

async function phase7_DesignNameParsing() {
    console.log('\n' + '═'.repeat(60));
    console.log('Phase 7: Design_Name Company Parsing + Fuzzy Match ⭐');
    console.log('═'.repeat(60));

    // Build official entries for fuzzy matching
    const officialEntries = Object.entries(csvCompanyMap).map(([normalized, data]) => ({
        normalized,
        raw: data.correctName,
        custId: data.custId
    }));
    console.log(`  Official company entries for matching: ${officialEntries.length.toLocaleString()}`);

    // Fetch orphan records: have Design_Name but no Company AND no Customer_ID
    console.log('  Fetching orphan records (Design_Name filled, Company empty, Customer_ID=0)...');
    const orphanRecs = await fetchAll(TABLE, {
        'q.select': 'ID_Unique,Design_Number,Design_Name,Company,Customer_ID,Is_Active',
        'q.where': "Company='' AND Customer_ID=0 AND Design_Name<>'' AND Is_Active='true'"
    });

    // Also try NULL Customer_ID
    let nullOrphans = [];
    try {
        nullOrphans = await fetchAll(TABLE, {
            'q.select': 'ID_Unique,Design_Number,Design_Name,Company,Customer_ID,Is_Active',
            'q.where': "Company='' AND Customer_ID IS NULL AND Design_Name<>'' AND Is_Active='true'"
        });
    } catch (err) { /* OK */ }

    const allOrphans = [...orphanRecs, ...nullOrphans];
    console.log(`  Orphan records: ${allOrphans.length.toLocaleString()} (${orphanRecs.length} with ID=0, ${nullOrphans.length} with ID=NULL)`);

    if (allOrphans.length === 0) {
        console.log('  Nothing to do.');
        logPhase(7, 'orphans', 0);
        return;
    }

    // Parse company from Design_Name for each record
    let parsed = 0, noParse = 0;
    let exactMatches = 0, fuzzyAutoFix = 0, fuzzyReview = 0, noMatch = 0;
    let exactRecords = 0, fuzzyAutoRecords = 0, fuzzyReviewRecords = 0, noMatchRecords = 0;
    let updated = 0;
    let errors = 0;

    // Group by Design_Number (many orphans share same design number with multiple DST variants)
    const designGroups = {};
    for (const rec of allOrphans) {
        const dn = String(rec.Design_Number);
        if (!designGroups[dn]) {
            designGroups[dn] = { records: [], designName: rec.Design_Name };
        }
        designGroups[dn].records.push(rec);
    }
    const groupCount = Object.keys(designGroups).length;
    console.log(`  Unique design numbers: ${groupCount.toLocaleString()}`);

    let groupsDone = 0;

    for (const [designNum, group] of Object.entries(designGroups)) {
        const designName = group.designName;
        const recCount = group.records.length;

        // Parse company candidate from Design_Name
        const companyCandidate = parseCompanyFromDesignName(designName);

        if (!companyCandidate) {
            noParse++;
            noMatchRecords += recCount;
            addCSVRow(7, 'NO-PARSE', designNum, designName, '', '', '', '', '', '', '', recCount, 'Could not extract company from Design_Name');
            groupsDone++;
            continue;
        }
        parsed++;

        // Step 1: Try exact match via lookupCustomerByCompany (strict prefix to reduce false positives)
        const exactLookup = lookupCustomerByCompany(companyCandidate, true);
        if (exactLookup) {
            exactMatches++;
            exactRecords += recCount;
            const custType = customerIdToType[exactLookup.customerId] || '';
            const rep = customerIdToRep[exactLookup.customerId] || '';

            addCSVRow(7, 'AUTO-FIX', designNum, designName, '', companyCandidate, exactLookup.correctName,
                exactLookup.customerId, custType, rep, 1.0, recCount, `Exact match (${exactLookup.matchType})`);

            // Apply update
            for (const rec of group.records) {
                try {
                    const updateData = {
                        Company: exactLookup.correctName,
                        Customer_ID: exactLookup.customerId
                    };
                    if (custType) updateData.Customer_Type = custType;
                    if (rep) updateData.Sales_Rep = rep;

                    const where = `Design_Number=${designNum} AND Company='' AND (Customer_ID=0 OR Customer_ID IS NULL)`;
                    const result = await updateRecord(TABLE, where, updateData);
                    updated += result?.RecordsAffected || 0;
                    await sleep(50);
                    break; // One bulk update per design number
                } catch (err) {
                    if (err.response?.status !== 400) {
                        errors++;
                        if (errors <= 5) console.error(`    ❌ Design #${designNum}: ${err.message}`);
                    }
                }
            }

            if (VERBOSE && exactMatches <= 10) {
                console.log(`    ✅ #${designNum} "${designName}" → "${exactLookup.correctName}" (custId: ${exactLookup.customerId}) [${exactLookup.matchType}]`);
            }
        } else {
            // Step 2: Fuzzy match
            const match = findBestMatch(companyCandidate, officialEntries);

            if (match.bestMatch && match.bestScore >= AUTO_FIX_THRESHOLD) {
                fuzzyAutoFix++;
                fuzzyAutoRecords += recCount;
                const custType = customerIdToType[match.bestMatch.custId] || '';
                const rep = customerIdToRep[match.bestMatch.custId] || '';

                addCSVRow(7, 'AUTO-FIX', designNum, designName, '', companyCandidate, match.bestMatch.raw,
                    match.bestMatch.custId, custType, rep, match.bestScore, recCount, `Fuzzy match (${match.method})`);

                // Apply update
                for (const rec of group.records) {
                    try {
                        const updateData = {
                            Company: match.bestMatch.raw,
                            Customer_ID: match.bestMatch.custId
                        };
                        if (custType) updateData.Customer_Type = custType;
                        if (rep) updateData.Sales_Rep = rep;

                        const where = `Design_Number=${designNum} AND Company='' AND (Customer_ID=0 OR Customer_ID IS NULL)`;
                        const result = await updateRecord(TABLE, where, updateData);
                        updated += result?.RecordsAffected || 0;
                        await sleep(50);
                        break;
                    } catch (err) {
                        if (err.response?.status !== 400) {
                            errors++;
                            if (errors <= 5) console.error(`    ❌ Design #${designNum}: ${err.message}`);
                        }
                    }
                }

                if (VERBOSE && fuzzyAutoFix <= 10) {
                    console.log(`    ✅ #${designNum} "${companyCandidate}" → "${match.bestMatch.raw}" (score: ${match.bestScore.toFixed(3)}, ${match.method})`);
                }
            } else if (match.bestMatch && match.bestScore >= REVIEW_THRESHOLD) {
                fuzzyReview++;
                fuzzyReviewRecords += recCount;

                addCSVRow(7, 'REVIEW', designNum, designName, '', companyCandidate, match.bestMatch.raw,
                    match.bestMatch.custId, '', '', match.bestScore, recCount, `Fuzzy review (${match.method})`);

                if (VERBOSE && fuzzyReview <= 10) {
                    console.log(`    ⚠️  #${designNum} "${companyCandidate}" ≈ "${match.bestMatch.raw}" (score: ${match.bestScore.toFixed(3)})`);
                }
            } else {
                noMatch++;
                noMatchRecords += recCount;

                const bestName = match.bestMatch ? match.bestMatch.raw : '';
                const bestScore = match.bestMatch ? match.bestScore : 0;
                addCSVRow(7, 'SKIP', designNum, designName, '', companyCandidate, bestName,
                    '', '', '', bestScore, recCount, match.method === 'too-short' ? 'Name too short for fuzzy' : 'No confident match');
            }
        }

        groupsDone++;
        if (groupsDone % 500 === 0) {
            console.log(`    ... ${groupsDone}/${groupCount} design groups processed (${exactMatches + fuzzyAutoFix} auto-fix, ${fuzzyReview} review, ${noMatch + noParse} skip)`);
        }
    }

    logPhase(7, 'orphans', allOrphans.length);
    logPhase(7, 'parsed', parsed);
    logPhase(7, 'noParse', noParse);
    logPhase(7, 'exactMatches', exactMatches);
    logPhase(7, 'fuzzyAutoFix', fuzzyAutoFix);
    logPhase(7, 'fuzzyReview', fuzzyReview);
    logPhase(7, 'noMatch', noMatch);
    logPhase(7, 'updated', updated);

    console.log(`\n  Phase 7 Results:`);
    console.log(`    Parsed company from Design_Name: ${parsed}/${groupCount} groups`);
    console.log(`    Exact matches:    ${exactMatches} groups (${exactRecords.toLocaleString()} records)`);
    console.log(`    Fuzzy AUTO-FIX:   ${fuzzyAutoFix} groups (${fuzzyAutoRecords.toLocaleString()} records)`);
    console.log(`    Fuzzy REVIEW:     ${fuzzyReview} groups (${fuzzyReviewRecords.toLocaleString()} records)`);
    console.log(`    No match/parse:   ${noMatch + noParse} groups (${noMatchRecords.toLocaleString()} records)`);
    if (LIVE_MODE) {
        console.log(`    Records updated:  ${updated.toLocaleString()}${errors > 0 ? ` (${errors} errors)` : ''}`);
    } else {
        console.log(`    🔵 [DRY RUN] Would update ${(exactRecords + fuzzyAutoRecords).toLocaleString()} records`);
    }
}

// ============================================
// Main
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Design_Lookup_2026 — Data Quality Audit & Fix');
    console.log(`Mode: ${LIVE_MODE ? '🔴 LIVE' : '🟢 DRY RUN'}`);
    if (ONLY_PHASE) console.log(`Running only Phase ${ONLY_PHASE}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    const startTime = Date.now();

    if (!CASPIO_DOMAIN || !CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('FATAL: Missing Caspio credentials. Set CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET');
        process.exit(1);
    }

    // Load reference data (needed by most phases)
    loadCompanyCSV();
    await buildFullCompanyMap();

    // Execute phases
    const phases = [
        { num: 1, fn: phase1_DeadDeactivation },
        { num: 2, fn: phase2_EmptyDeactivation },
        { num: 3, fn: phase3_TestDeactivation },
        { num: 4, fn: phase4_ArtNotesCleanup },
        { num: 5, fn: phase5_CustomerTypeEnrichment },
        { num: 6, fn: phase6_SalesRepEnrichment },
        { num: 7, fn: phase7_DesignNameParsing },
    ];

    for (const phase of phases) {
        if (ONLY_PHASE && phase.num !== ONLY_PHASE) continue;
        try {
            await phase.fn();
        } catch (err) {
            console.error(`\n❌ Phase ${phase.num} fatal error: ${err.message}`);
            logPhase(phase.num, 'fatal', err.message);
        }
    }

    // Write CSV report
    const csvPath = writeCSV();

    // Print summary
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log('\n' + '='.repeat(60));
    console.log('AUDIT COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Mode:     ${LIVE_MODE ? '🔴 LIVE' : '🟢 DRY RUN'}`);
    console.log(`  Duration: ${duration} minutes`);
    console.log(`  CSV:      ${csvPath}`);
    console.log(`  Rows:     ${csvRows.length} entries`);

    console.log('\n  Phase Summary:');
    for (const [phase, data] of Object.entries(phaseSummary).sort((a, b) => a[0] - b[0])) {
        const entries = Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toLocaleString() : v}`).join(', ');
        console.log(`    Phase ${phase}: ${entries}`);
    }

    if (!LIVE_MODE) {
        console.log('\nTo apply all fixes:');
        console.log('  node scripts/audit-fix-design-lookup.js --live');
        console.log('\nTo run a single phase:');
        console.log('  node scripts/audit-fix-design-lookup.js --phase=7 --live');
    }
}

main().catch(err => {
    console.error('\n💥 Fatal:', err.message);
    if (VERBOSE) console.error(err.stack);
    process.exit(1);
});
