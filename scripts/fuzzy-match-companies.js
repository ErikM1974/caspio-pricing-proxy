#!/usr/bin/env node
/**
 * Fuzzy Match & Fix Unmatched Company Names in Design_Lookup_2026
 *
 * Finds companies with Customer_ID=0 and a non-empty Company name,
 * then fuzzy-matches them against the official ShopWorks company list
 * (10,525 entries) to correct misspellings and fill Customer_IDs.
 *
 * Usage:
 *   node scripts/fuzzy-match-companies.js           # Dry-run (preview only)
 *   node scripts/fuzzy-match-companies.js --live     # Write to Caspio
 *   node scripts/fuzzy-match-companies.js --verbose  # Show all comparisons
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

const AUTO_FIX_THRESHOLD = 0.90;
const REVIEW_THRESHOLD = 0.75;
const MIN_FUZZY_LENGTH = 4; // Skip fuzzy for very short normalized names

// ============================================
// Company name normalization (from backfill script)
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
    if (!str) return '';
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================
// CSV company list loading (from backfill script)
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
    if (companyCol === -1 || idCol === -1) { console.warn('[Init] CSV header not recognized'); return; }

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (!fields || fields.length <= Math.max(companyCol, idCol)) continue;
        const company = (fields[companyCol] || '').trim();
        const custId = (fields[idCol] || '').trim();
        if (!company || !custId || custId === '0') continue;
        const normalized = normalizeCompanyName(company);
        if (normalized && !csvCompanyMap[normalized]) {
            csvCompanyMap[normalized] = { custId, correctName: company };
            count++;
        }
    }
    console.log(`[Init] Loaded ${count.toLocaleString()} company→customer mappings from CSV`);
}

// ============================================
// Caspio API helpers (from backfill script)
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
    if (!LIVE_MODE) return { dryRun: true };
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

    console.log(`  Added ${added} from Caspio tables (total map: ${Object.keys(csvCompanyMap).length.toLocaleString()} companies)`);
}

// ============================================
// Fuzzy matching algorithms
// ============================================

/**
 * Levenshtein distance — single-row DP, O(min(m,n)) space
 */
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

/**
 * Similarity score (0-1) based on Levenshtein distance
 */
function levSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Token Jaccard similarity — word-set overlap
 */
function tokenSimilarity(a, b) {
    const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 1));
    const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 1));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let intersection = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) intersection++;
    }
    const union = new Set([...tokensA, ...tokensB]).size;
    return intersection / union;
}

/**
 * Composite match score — uses MAX of individual methods + bonuses.
 * The weighted-average approach diluted strong Levenshtein signals
 * when token similarity was low (e.g., "ProEnd" vs "Pro End" splits differently).
 */
function computeMatchScore(unmatchedRaw, officialRaw) {
    const unmatchedNorm = normalizeCompanyName(unmatchedRaw);
    const officialNorm = normalizeCompanyName(officialRaw);

    // Exact normalized match
    if (unmatchedNorm === officialNorm) return { score: 1.0, method: 'exact-normalized' };

    // Levenshtein on normalized names (primary signal — catches typos)
    const levNorm = levSimilarity(unmatchedNorm, officialNorm);

    // Levenshtein on lowercased raw names (catches spacing/punctuation diffs)
    const levRaw = levSimilarity(unmatchedRaw.toLowerCase(), officialRaw.toLowerCase());

    // Levenshtein with all spaces/punctuation stripped (catches "ProEnd" vs "Pro End")
    const stripAll = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const levStripped = levSimilarity(stripAll(unmatchedRaw), stripAll(officialRaw));

    // Token overlap (catches word reordering)
    const tokenScore = tokenSimilarity(unmatchedNorm, officialNorm);

    // Contains bonus: one name fully contains the other
    const containsBonus = (unmatchedNorm.includes(officialNorm) || officialNorm.includes(unmatchedNorm)) ? 0.08 : 0;

    // First-word bonus (companies often share first word as primary identity)
    const firstWordA = unmatchedNorm.split(' ')[0] || '';
    const firstWordB = officialNorm.split(' ')[0] || '';
    const firstWordBonus = (firstWordA === firstWordB && firstWordA.length >= 3) ? 0.05 : 0;

    // Take the BEST individual method score, plus small bonuses
    const baseScore = Math.max(levNorm, levRaw, levStripped, tokenScore);
    const composite = Math.min(1.0, baseScore + containsBonus + firstWordBonus);

    // Pick dominant method for reporting
    let method = 'composite';
    if (baseScore === levStripped && levStripped > levNorm && levStripped > levRaw) method = 'stripped-match';
    else if (baseScore === levNorm || baseScore === levRaw) method = 'levenshtein';
    else if (baseScore === tokenScore) method = 'token-match';

    return { score: composite, method, levNorm, levRaw, levStripped, tokenScore };
}

// ============================================
// Entry classification helpers
// ============================================

function isTestEntry(name) {
    return /\b(test|acme test|erik test)\b/i.test(name);
}

function isMalformed(name) {
    return /^&\s*\d/.test(name.trim());
}

// ============================================
// Find best match for an unmatched company
// ============================================

function findBestMatch(unmatchedName, officialEntries) {
    const normalized = normalizeCompanyName(unmatchedName);

    // Guard: skip fuzzy for very short names
    if (normalized.length < MIN_FUZZY_LENGTH) {
        return { bestMatch: null, bestScore: 0, method: 'too-short' };
    }

    // Early termination: skip if length ratio is extreme (saves ~70% comparisons)
    let bestMatch = null;
    let bestScore = 0;
    let bestMethod = 'none';

    for (const entry of officialEntries) {
        // Pre-filter: skip if lengths differ by more than 2x
        const lenRatio = normalized.length / Math.max(entry.normalized.length, 1);
        if (lenRatio > 2.5 || lenRatio < 0.4) continue;

        const result = computeMatchScore(unmatchedName, entry.raw);

        if (result.score > bestScore) {
            bestScore = result.score;
            bestMatch = entry;
            bestMethod = result.method;
        }

        // Early exit: perfect score found
        if (bestScore >= 1.0) break;
    }

    return { bestMatch, bestScore, method: bestMethod };
}

// ============================================
// Main
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Fuzzy Match Unmatched Companies in Design_Lookup_2026');
    console.log(`Mode: ${LIVE_MODE ? '🔴 LIVE' : '🟢 DRY RUN'}`);
    console.log(`Auto-fix threshold: ≥ ${AUTO_FIX_THRESHOLD}`);
    console.log(`Review threshold: ≥ ${REVIEW_THRESHOLD}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    const startTime = Date.now();

    if (!CASPIO_DOMAIN || !CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('FATAL: Missing Caspio credentials.');
        process.exit(1);
    }

    // Step 1: Load reference data
    loadCompanyCSV();
    await buildFullCompanyMap();

    // Build flat list of official entries for fuzzy matching
    const officialEntries = Object.entries(csvCompanyMap).map(([normalized, data]) => ({
        normalized,
        raw: data.correctName,
        custId: data.custId
    }));
    console.log(`\n📊 Official company entries for matching: ${officialEntries.length.toLocaleString()}`);

    // Step 2: Fetch unmatched records
    console.log('\n📋 Fetching unmatched records from Design_Lookup_2026...');
    const unmatchedRecs = await fetchAll('Design_Lookup_2026', {
        'q.select': 'Company,Design_Number,Customer_ID',
        'q.where': "Customer_ID=0 AND Company<>''"
    });
    console.log(`  Records with Customer_ID=0 and company name: ${unmatchedRecs.length}`);

    // Also try NULL
    let nullRecs = [];
    try {
        nullRecs = await fetchAll('Design_Lookup_2026', {
            'q.select': 'Company,Design_Number,Customer_ID',
            'q.where': "Customer_ID IS NULL AND Company<>''"
        });
        console.log(`  Records with Customer_ID IS NULL: ${nullRecs.length}`);
    } catch (err) {
        // OK if no null records
    }

    const allUnmatched = [...unmatchedRecs, ...nullRecs];

    // Step 3: Group by raw company name
    const rawGroups = {};
    for (const rec of allUnmatched) {
        const company = (rec.Company || '').trim();
        if (!company) continue;
        if (!rawGroups[company]) {
            rawGroups[company] = { count: 0, designs: new Set() };
        }
        rawGroups[company].count++;
        if (rec.Design_Number) rawGroups[company].designs.add(String(rec.Design_Number));
    }

    const rawCompanyCount = Object.keys(rawGroups).length;
    console.log(`  Unique raw company names: ${rawCompanyCount}`);

    // Step 4: Merge by normalized name (consolidate internal dupes)
    const normalizedGroups = {};
    for (const [rawName, data] of Object.entries(rawGroups)) {
        const norm = normalizeCompanyName(rawName);
        if (!norm) continue;
        if (!normalizedGroups[norm]) {
            normalizedGroups[norm] = { rawSpellings: [], totalCount: 0, designs: new Set(), primaryRaw: null, primaryCount: 0 };
        }
        const g = normalizedGroups[norm];
        g.rawSpellings.push(rawName);
        g.totalCount += data.count;
        for (const d of data.designs) g.designs.add(d);
        // Track which raw spelling has the most records (for display)
        if (data.count > g.primaryCount) {
            g.primaryRaw = rawName;
            g.primaryCount = data.count;
        }
    }

    const normGroupCount = Object.keys(normalizedGroups).length;
    const mergedDupes = rawCompanyCount - normGroupCount;
    console.log(`  Normalized groups: ${normGroupCount} (${mergedDupes} internal dupes merged)`);

    // Step 5: Fuzzy match each normalized group
    console.log(`\n🔍 Running fuzzy matching (${normGroupCount} groups × ${officialEntries.length.toLocaleString()} official = ${(normGroupCount * officialEntries.length).toLocaleString()} comparisons)...`);

    const results = []; // { primaryRaw, rawSpellings, count, bestMatch, score, method, action }
    let autoFixCount = 0, reviewCount = 0, skipCount = 0, tooShortCount = 0, testCount = 0, malformedCount = 0;
    let autoFixRecords = 0, reviewRecords = 0, skipRecords = 0;
    let groupsDone = 0;

    for (const [norm, group] of Object.entries(normalizedGroups)) {
        const primaryRaw = group.primaryRaw;
        let action, bestMatchName = '', bestMatchCustId = '', score = 0, method = 'none';

        // Classify special entries
        if (isTestEntry(primaryRaw)) {
            action = 'TEST';
            testCount++;
            skipRecords += group.totalCount;
        } else if (isMalformed(primaryRaw)) {
            action = 'MALFORMED';
            malformedCount++;
            skipRecords += group.totalCount;
        } else {
            // Run fuzzy match
            const match = findBestMatch(primaryRaw, officialEntries);
            score = match.bestScore;
            method = match.method;

            if (method === 'too-short') {
                action = 'TOO-SHORT';
                tooShortCount++;
                skipRecords += group.totalCount;
            } else if (match.bestMatch && score >= AUTO_FIX_THRESHOLD) {
                action = 'AUTO-FIX';
                bestMatchName = match.bestMatch.raw;
                bestMatchCustId = match.bestMatch.custId;
                autoFixCount++;
                autoFixRecords += group.totalCount;
            } else if (match.bestMatch && score >= REVIEW_THRESHOLD) {
                action = 'REVIEW';
                bestMatchName = match.bestMatch.raw;
                bestMatchCustId = match.bestMatch.custId;
                reviewCount++;
                reviewRecords += group.totalCount;
            } else {
                action = 'SKIP';
                if (match.bestMatch) {
                    bestMatchName = match.bestMatch.raw;
                    bestMatchCustId = match.bestMatch.custId;
                }
                skipCount++;
                skipRecords += group.totalCount;
            }
        }

        results.push({
            primaryRaw,
            rawSpellings: group.rawSpellings,
            count: group.totalCount,
            normalized: norm,
            bestMatchName,
            bestMatchCustId,
            score: Math.round(score * 1000) / 1000,
            method,
            action,
            sampleDesigns: [...group.designs].slice(0, 3).join('; ')
        });

        groupsDone++;
        if (groupsDone % 50 === 0) {
            console.log(`  ... ${groupsDone}/${normGroupCount} groups processed`);
        }
    }

    // Sort results: AUTO-FIX first (by score desc), then REVIEW, then rest
    const actionOrder = { 'AUTO-FIX': 0, 'REVIEW': 1, 'TOO-SHORT': 2, 'TEST': 3, 'MALFORMED': 4, 'SKIP': 5 };
    results.sort((a, b) => {
        const orderDiff = (actionOrder[a.action] || 9) - (actionOrder[b.action] || 9);
        if (orderDiff !== 0) return orderDiff;
        return b.score - a.score;
    });

    // Step 6: Apply auto-fixes to Caspio
    console.log('\n' + '─'.repeat(50));
    console.log(`📝 Applying auto-fixes (${autoFixCount} groups, ${autoFixRecords} records)`);
    console.log('─'.repeat(50));

    let totalUpdated = 0;
    let updateErrors = 0;

    const autoFixes = results.filter(r => r.action === 'AUTO-FIX');
    for (let i = 0; i < autoFixes.length; i++) {
        const fix = autoFixes[i];

        if (i < 15 || VERBOSE) {
            console.log(`  ${LIVE_MODE ? '✅' : '🔵'} "${fix.primaryRaw}" → "${fix.bestMatchName}" (custId: ${fix.bestMatchCustId}, score: ${fix.score}, ${fix.count} records)`);
        }

        if (LIVE_MODE) {
            for (const rawSpelling of fix.rawSpellings) {
                try {
                    const r1 = await updateRecord('Design_Lookup_2026',
                        `Company='${escapeSQL(rawSpelling)}' AND Customer_ID=0`,
                        { Company: fix.bestMatchName, Customer_ID: fix.bestMatchCustId });
                    totalUpdated += r1?.RecordsAffected || 0;
                    await sleep(100);
                } catch (err) {
                    if (err.response?.status !== 400) {
                        updateErrors++;
                        if (updateErrors <= 5) console.error(`    ❌ "${rawSpelling}" (=0): ${err.message}`);
                    }
                }
                try {
                    const r2 = await updateRecord('Design_Lookup_2026',
                        `Company='${escapeSQL(rawSpelling)}' AND Customer_ID IS NULL`,
                        { Company: fix.bestMatchName, Customer_ID: fix.bestMatchCustId });
                    totalUpdated += r2?.RecordsAffected || 0;
                    await sleep(100);
                } catch (err) {
                    if (err.response?.status !== 400) {
                        updateErrors++;
                        if (updateErrors <= 5) console.error(`    ❌ "${rawSpelling}" (NULL): ${err.message}`);
                    }
                }
            }
        }
    }

    if (LIVE_MODE) {
        console.log(`\n  Updated: ${totalUpdated} records${updateErrors > 0 ? `, ${updateErrors} errors` : ''}`);
    }

    // Step 7: Show review items
    const reviewItems = results.filter(r => r.action === 'REVIEW');
    if (reviewItems.length > 0) {
        console.log('\n' + '─'.repeat(50));
        console.log(`⚠️  Needs Manual Review (${reviewItems.length} groups, ${reviewRecords} records)`);
        console.log('─'.repeat(50));
        for (const item of reviewItems) {
            console.log(`  "${item.primaryRaw}" → "${item.bestMatchName}" (score: ${item.score}, ${item.count} recs)`);
        }
    }

    // Step 8: Write CSV
    const csvLines = ['Unmatched_Company,Record_Count,Best_Match,Customer_ID,Score,Method,Action,All_Raw_Spellings,Sample_Designs'];
    for (const r of results) {
        csvLines.push([
            escapeCSV(r.primaryRaw),
            r.count,
            escapeCSV(r.bestMatchName),
            r.bestMatchCustId,
            r.score,
            r.method,
            r.action,
            escapeCSV(r.rawSpellings.join('; ')),
            escapeCSV(r.sampleDesigns)
        ].join(','));
    }

    const csvContent = csvLines.join('\n');
    const downloadsPath = path.join(os.homedir(), 'Downloads', 'fuzzy-match-results.csv');
    fs.writeFileSync(downloadsPath, csvContent, 'utf8');
    console.log(`\n📄 CSV written: ${downloadsPath}`);

    // Step 9: Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n' + '='.repeat(60));
    console.log('FUZZY MATCH COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Mode:               ${LIVE_MODE ? '🔴 LIVE' : '🟢 DRY RUN'}`);
    console.log(`  Raw companies:      ${rawCompanyCount}`);
    console.log(`  Normalized groups:  ${normGroupCount} (${mergedDupes} internal dupes merged)`);
    console.log('');
    console.log(`  AUTO-FIX (≥${AUTO_FIX_THRESHOLD}):  ${autoFixCount} groups (${autoFixRecords} records)`);
    console.log(`  REVIEW (≥${REVIEW_THRESHOLD}):    ${reviewCount} groups (${reviewRecords} records)`);
    console.log(`  SKIP (<${REVIEW_THRESHOLD}):      ${skipCount} groups (${skipRecords} records)`);
    console.log(`  TOO-SHORT:          ${tooShortCount} groups`);
    console.log(`  TEST:               ${testCount} groups`);
    console.log(`  MALFORMED:          ${malformedCount} groups`);
    if (LIVE_MODE) {
        console.log(`  Records updated:    ${totalUpdated}${updateErrors > 0 ? ` (${updateErrors} errors)` : ''}`);
    }
    console.log(`  Duration:           ${duration}s`);
    console.log(`\n  CSV: ${downloadsPath}`);

    if (!LIVE_MODE) {
        console.log('\nTo apply auto-fixes, run:');
        console.log('  node scripts/fuzzy-match-companies.js --live');
    }
}

main().catch(err => {
    console.error('\n💥 Fatal:', err.message);
    process.exit(1);
});
