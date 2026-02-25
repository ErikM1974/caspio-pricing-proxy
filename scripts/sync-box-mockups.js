#!/usr/bin/env node
/**
 * Sync Box Mockups — Fill empty Mockup_URL + insert missing designs
 *
 * Reads box-steve-mockups.json (design# → Box mockup URL mapping),
 * queries Design_Lookup_2026, and:
 *   1. UPDATES existing records that are missing Mockup_URL
 *   2. INSERTS new records for designs found in Steve's Box but not in the DB
 *      (flagged for manual review via Art_Notes)
 *
 * Uses box-steve-folder-meta.json for company names on new inserts.
 *
 * Usage:
 *   node scripts/sync-box-mockups.js           # Dry-run (preview only)
 *   node scripts/sync-box-mockups.js --live     # Write to Caspio
 *   node scripts/sync-box-mockups.js --verbose  # Show per-record details
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

const UNIFIED_TABLE = 'Design_Lookup_2026';
const CONCURRENCY = 10;
const MAPPING_FILE = path.join(__dirname, 'data', 'box-steve-mockups.json');
const METADATA_FILE = path.join(__dirname, 'data', 'box-steve-folder-meta.json');

// ============================================
// Caspio API helpers (same pattern as sync-box-thumbnails.js)
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
                params: reqParams,
                timeout: 30000
            });

            const records = resp.data?.Result || [];
            allResults = allResults.concat(records);

            if (VERBOSE) {
                console.log(`  [Fetch] ${tableName} page ${page}: ${records.length} records (total: ${allResults.length})`);
            }

            if (records.length < pageSize) break;
            page++;
            if (page > 50) {
                console.warn(`  [Fetch] ${tableName}: Hit 50-page safety limit at ${allResults.length} records`);
                break;
            }
        } catch (err) {
            if (err.response?.status === 404) return [];
            throw err;
        }
    }

    return allResults;
}

async function updateRecords(tableName, whereClause, data) {
    if (!LIVE_MODE) return 0;

    const token = await getToken();
    const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;

    const resp = await axios.put(url, data, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        params: { 'q.where': whereClause },
        timeout: 15000
    });

    return resp.data?.RecordsAffected || resp.data || 0;
}

async function insertRecord(tableName, data) {
    if (!LIVE_MODE) return true;

    const token = await getToken();
    const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;

    const resp = await axios.post(url, data, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });

    return resp.data || true;
}

// ============================================
// Main sync logic
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Box Mockup Sync — Fill empty Mockup_URL from Box.com');
    console.log(`Mode: ${LIVE_MODE ? '🔴 LIVE (writing to Caspio)' : '🟢 DRY RUN (preview only)'}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    if (!CASPIO_DOMAIN || !CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('FATAL: Missing CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, or CASPIO_CLIENT_SECRET');
        process.exit(1);
    }

    // Step 1: Load Box mapping
    console.log('\n📦 Step 1: Loading Box mockup mapping...');

    if (!fs.existsSync(MAPPING_FILE)) {
        console.error(`FATAL: Mapping file not found: ${MAPPING_FILE}`);
        console.error('Run scan-box-mockups.js first to generate the mapping.');
        process.exit(1);
    }

    const boxMapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    const boxDesignCount = Object.keys(boxMapping).length;
    console.log(`  Loaded ${boxDesignCount.toLocaleString()} design → mockup URL mappings`);

    const sampleEntries = Object.entries(boxMapping).slice(0, 3);
    for (const [dn, url] of sampleEntries) {
        console.log(`    Design #${dn} → ${url.substring(0, 70)}...`);
    }

    // Load folder metadata (for company names when inserting new records)
    let folderMeta = {};
    if (fs.existsSync(METADATA_FILE)) {
        folderMeta = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
        console.log(`  Loaded ${Object.keys(folderMeta).length.toLocaleString()} folder metadata entries`);
    } else {
        console.log('  ⚠ No folder metadata file — new records will have empty Company field');
        console.log('  Run: node scripts/scan-box-mockups.js --token=TOKEN --metadata-only');
    }

    // Step 2: Fetch current records
    console.log('\n📥 Step 2: Fetching Design_Lookup_2026 records...');
    const startFetch = Date.now();

    const records = await fetchAll(UNIFIED_TABLE, {
        'q.select': 'Design_Number,Mockup_URL'
    });

    const fetchTime = ((Date.now() - startFetch) / 1000).toFixed(1);
    console.log(`  Fetched ${records.length.toLocaleString()} records in ${fetchTime}s`);

    // Step 3: Analyze
    console.log('\n🔍 Step 3: Analyzing mockup coverage...');

    const withMockup = records.filter(r => r.Mockup_URL && r.Mockup_URL.trim().length > 10);
    const withoutMockup = records.filter(r => !r.Mockup_URL || r.Mockup_URL.trim().length <= 10);

    console.log(`  Already have mockup: ${withMockup.length.toLocaleString()} records`);
    console.log(`  Missing mockup: ${withoutMockup.length.toLocaleString()} records`);

    // Build set of all design numbers in the DB
    const allDbDesignNumbers = new Set(records.map(r => String(r.Design_Number)));

    // Group missing-mockup records by design number
    const missingByDN = {};
    for (const rec of withoutMockup) {
        const dn = String(rec.Design_Number);
        if (!missingByDN[dn]) missingByDN[dn] = 0;
        missingByDN[dn]++;
    }

    // Categorize Box designs: UPDATE (in DB, missing mockup) vs INSERT (not in DB at all)
    const toUpdate = {};
    const toInsert = {};
    let matchCount = 0;
    let noMatchCount = 0;

    for (const dn of Object.keys(missingByDN)) {
        if (boxMapping[dn]) {
            toUpdate[dn] = boxMapping[dn];
            matchCount++;
        } else {
            noMatchCount++;
        }
    }

    // Find designs in Box mapping that aren't in the DB at all → INSERT candidates
    for (const dn of Object.keys(boxMapping)) {
        if (!allDbDesignNumbers.has(dn)) {
            toInsert[dn] = boxMapping[dn];
        }
    }

    const totalRowsToUpdate = Object.entries(toUpdate).reduce((sum, [dn]) => sum + missingByDN[dn], 0);

    console.log(`\n  UPDATE: ${matchCount.toLocaleString()} designs in DB missing mockup (${totalRowsToUpdate.toLocaleString()} rows)`);
    console.log(`  INSERT: ${Object.keys(toInsert).length.toLocaleString()} designs in Box NOT in DB (will add as new records)`);
    console.log(`  Missing designs without Box mockup: ${noMatchCount.toLocaleString()} designs`);

    // Sample updates
    if (matchCount > 0) {
        console.log('\n  Sample updates (first 10):');
        const sampleUpdates = Object.entries(toUpdate).slice(0, 10);
        for (const [dn, url] of sampleUpdates) {
            console.log(`    Design #${dn} (${missingByDN[dn]} rows) → ${url.substring(0, 60)}...`);
        }
    }

    // Sample inserts
    if (Object.keys(toInsert).length > 0) {
        console.log('\n  Sample inserts (first 10):');
        const sampleInserts = Object.entries(toInsert).slice(0, 10);
        for (const [dn, url] of sampleInserts) {
            const meta = folderMeta[dn];
            const company = meta?.company || '(unknown)';
            console.log(`    Design #${dn} — "${company}" → ${url.substring(0, 50)}...`);
        }
    }

    if (matchCount === 0 && Object.keys(toInsert).length === 0) {
        console.log('\n✅ No records to update or insert — everything is in sync.');
        return;
    }

    if (!LIVE_MODE) {
        console.log('\n' + '='.repeat(60));
        console.log('DRY RUN COMPLETE — No data written.');
        if (matchCount > 0) {
            console.log(`  Would UPDATE: ${matchCount} designs (${totalRowsToUpdate} rows)`);
        }
        if (Object.keys(toInsert).length > 0) {
            console.log(`  Would INSERT: ${Object.keys(toInsert).length} new design records`);
        }
        console.log('  To write changes: node scripts/sync-box-mockups.js --live');
        console.log('='.repeat(60));
        return;
    }

    let updated = 0;
    let updateErrors = 0;
    let inserted = 0;
    let insertErrors = 0;

    // -----------------------------------------------
    // Step 4: Update existing records with mockup URLs
    // -----------------------------------------------
    if (matchCount > 0) {
        console.log(`\n✏️  Step 4: Updating ${matchCount} designs in Caspio...`);
        const startWrite = Date.now();

        const designNums = Object.keys(toUpdate);

        for (let i = 0; i < designNums.length; i += CONCURRENCY) {
            const chunk = designNums.slice(i, i + CONCURRENCY);

            const results = await Promise.allSettled(
                chunk.map(dn => {
                    const whereClause = `Design_Number=${dn} AND (Mockup_URL IS NULL OR Mockup_URL='')`;
                    return updateRecords(UNIFIED_TABLE, whereClause, {
                        Mockup_URL: toUpdate[dn]
                    });
                })
            );

            for (let j = 0; j < results.length; j++) {
                if (results[j].status === 'fulfilled') {
                    updated++;
                    if (VERBOSE) console.log(`    ✓ Design #${chunk[j]} updated`);
                } else {
                    updateErrors++;
                    const errMsg = results[j].reason?.response?.data?.Message || results[j].reason?.message || 'unknown';
                    if (updateErrors <= 20) console.error(`    ❌ Design #${chunk[j]}: ${errMsg}`);
                }
            }

            if ((i + CONCURRENCY) % 500 < CONCURRENCY && i > 0) {
                const elapsed = ((Date.now() - startWrite) / 1000).toFixed(0);
                console.log(`    Progress: ${updated}/${matchCount} designs (${elapsed}s)`);
            }

            await sleep(100);
        }

        const writeTime = ((Date.now() - startWrite) / 1000).toFixed(1);
        console.log(`  ✅ Updates done: ${updated} designs in ${writeTime}s (${updateErrors} errors)`);
    }

    // -----------------------------------------------
    // Step 5: Insert new records for designs only in Box
    // -----------------------------------------------
    const insertList = Object.keys(toInsert);
    if (insertList.length > 0) {
        console.log(`\n🆕 Step 5: Inserting ${insertList.length} new design records...`);
        const startInsert = Date.now();

        for (let i = 0; i < insertList.length; i += CONCURRENCY) {
            const chunk = insertList.slice(i, i + CONCURRENCY);

            const results = await Promise.allSettled(
                chunk.map(dn => {
                    const meta = folderMeta[dn] || {};
                    const company = (meta.company || '').substring(0, 255);

                    return insertRecord(UNIFIED_TABLE, {
                        Design_Number: parseInt(dn, 10),
                        Design_Name: company || `Design ${dn}`,
                        Company: company,
                        Mockup_URL: toInsert[dn],
                        Is_Active: 'true',
                        Art_Notes: `Auto-added from Steve Art Box – needs manual review. Folder: ${(meta.folderName || dn).substring(0, 200)}`,
                        Date_Updated: new Date().toISOString().split('T')[0]
                    });
                })
            );

            for (let j = 0; j < results.length; j++) {
                if (results[j].status === 'fulfilled') {
                    inserted++;
                    if (VERBOSE) {
                        const meta = folderMeta[chunk[j]] || {};
                        console.log(`    ✓ Design #${chunk[j]} inserted (${meta.company || 'no company'})`);
                    }
                } else {
                    insertErrors++;
                    const errMsg = results[j].reason?.response?.data?.Message || results[j].reason?.message || 'unknown';
                    if (insertErrors <= 20) console.error(`    ❌ Design #${chunk[j]}: ${errMsg}`);
                }
            }

            if ((i + CONCURRENCY) % 200 < CONCURRENCY && i > 0) {
                const elapsed = ((Date.now() - startInsert) / 1000).toFixed(0);
                console.log(`    Progress: ${inserted}/${insertList.length} inserts (${elapsed}s)`);
            }

            await sleep(100);
        }

        const insertTime = ((Date.now() - startInsert) / 1000).toFixed(1);
        console.log(`  ✅ Inserts done: ${inserted} new records in ${insertTime}s (${insertErrors} errors)`);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SYNC COMPLETE');
    console.log(`  Designs updated (mockup URL): ${updated.toLocaleString()}`);
    console.log(`  New designs inserted: ${inserted.toLocaleString()}`);
    console.log(`  Update errors: ${updateErrors}`);
    console.log(`  Insert errors: ${insertErrors}`);
    console.log('='.repeat(60));
}

main().catch(err => {
    console.error('\n💥 FATAL ERROR:', err.message);
    if (err.response?.data) console.error('  API response:', JSON.stringify(err.response.data).substring(0, 500));
    process.exit(1);
});
