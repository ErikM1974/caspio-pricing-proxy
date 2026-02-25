#!/usr/bin/env node
/**
 * Sync Box Thumbnails — Fill empty Thumbnail_URL from Box.com shared links
 *
 * Reads box-design-previews.json (design# → Box download URL mapping),
 * queries Design_Lookup_2026 for records missing thumbnails, and updates
 * those records with Box CDN URLs.
 *
 * The mapping file is pre-built from Box "Design Previews" folder (ID: 366607792663)
 * containing 11,463 JPG thumbnails with public shared links.
 *
 * Usage:
 *   node scripts/sync-box-thumbnails.js           # Dry-run (preview only)
 *   node scripts/sync-box-thumbnails.js --live     # Write to Caspio
 *   node scripts/sync-box-thumbnails.js --verbose  # Show per-record details
 *
 * Designed for manual runs or Heroku Scheduler (monthly).
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
const MAPPING_FILE = path.join(__dirname, 'data', 'box-design-previews.json');

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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * Fetch all pages from a Caspio table.
 */
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

/**
 * Update records matching a WHERE clause.
 * Caspio REST v3: PUT /tables/{table}/records?q.where=... with body = fields to update.
 * Returns number of records affected.
 */
async function updateRecords(tableName, whereClause, data) {
    if (!LIVE_MODE) return 0;

    const token = await getToken();
    const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;

    const resp = await axios.put(url, data, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        params: { 'q.where': whereClause },
        timeout: 15000
    });

    // Caspio PUT returns number of records updated
    return resp.data?.RecordsAffected || resp.data || 0;
}

// ============================================
// Main sync logic
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Box Thumbnail Sync — Fill empty Thumbnail_URL from Box.com');
    console.log(`Mode: ${LIVE_MODE ? '🔴 LIVE (writing to Caspio)' : '🟢 DRY RUN (preview only)'}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    // Validate env
    if (!CASPIO_DOMAIN || !CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('FATAL: Missing CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, or CASPIO_CLIENT_SECRET');
        process.exit(1);
    }

    // -----------------------------------------------
    // Step 1: Load Box mapping file
    // -----------------------------------------------
    console.log('\n📦 Step 1: Loading Box design previews mapping...');

    if (!fs.existsSync(MAPPING_FILE)) {
        console.error(`FATAL: Mapping file not found: ${MAPPING_FILE}`);
        console.error('Run the Box URL extraction first (via Claude MCP tools).');
        process.exit(1);
    }

    const boxMapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    const boxDesignCount = Object.keys(boxMapping).length;
    console.log(`  Loaded ${boxDesignCount.toLocaleString()} design → URL mappings`);

    // Sample
    const sampleEntries = Object.entries(boxMapping).slice(0, 3);
    for (const [dn, url] of sampleEntries) {
        console.log(`    Design #${dn} → ${url.substring(0, 70)}...`);
    }

    // -----------------------------------------------
    // Step 2: Fetch current Design_Lookup_2026 records
    // -----------------------------------------------
    console.log('\n📥 Step 2: Fetching Design_Lookup_2026 records...');
    const startFetch = Date.now();

    const records = await fetchAll(UNIFIED_TABLE, {
        'q.select': 'Design_Number,Thumbnail_URL'
    });

    const fetchTime = ((Date.now() - startFetch) / 1000).toFixed(1);
    console.log(`  Fetched ${records.length.toLocaleString()} records in ${fetchTime}s`);

    // -----------------------------------------------
    // Step 3: Find records needing Box thumbnail
    // -----------------------------------------------
    console.log('\n🔍 Step 3: Analyzing thumbnail coverage...');

    const withThumbnail = records.filter(r => r.Thumbnail_URL && r.Thumbnail_URL.trim().length > 10);
    const withoutThumbnail = records.filter(r => !r.Thumbnail_URL || r.Thumbnail_URL.trim().length <= 10);

    console.log(`  Already have thumbnail: ${withThumbnail.length.toLocaleString()} records`);
    console.log(`  Missing thumbnail: ${withoutThumbnail.length.toLocaleString()} records`);

    // Group missing records by design number (one design can have multiple rows/variants)
    const missingByDN = {};
    for (const rec of withoutThumbnail) {
        const dn = String(rec.Design_Number);
        if (!missingByDN[dn]) missingByDN[dn] = 0;
        missingByDN[dn]++;
    }

    // Find which missing designs have a Box URL
    const toUpdate = {};
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

    const totalRowsToUpdate = Object.entries(toUpdate).reduce((sum, [dn]) => sum + missingByDN[dn], 0);

    console.log(`\n  Missing designs with Box match: ${matchCount.toLocaleString()} designs (${totalRowsToUpdate.toLocaleString()} rows)`);
    console.log(`  Missing designs without Box match: ${noMatchCount.toLocaleString()} designs (still no thumbnail)`);

    // Also check: Box designs that already have thumbnails (overlap)
    const alreadyHaveThumbnailDNs = new Set(withThumbnail.map(r => String(r.Design_Number)));
    const boxOverlap = Object.keys(boxMapping).filter(dn => alreadyHaveThumbnailDNs.has(dn)).length;
    const boxNew = Object.keys(boxMapping).filter(dn => !alreadyHaveThumbnailDNs.has(dn)).length;
    console.log(`\n  Box coverage analysis:`);
    console.log(`    Box designs already in DB with thumbnail: ${boxOverlap.toLocaleString()} (no change needed)`);
    console.log(`    Box designs that will ADD new thumbnails: ${boxNew.toLocaleString()}`);

    if (matchCount === 0) {
        console.log('\n✅ No records to update — all designs with Box thumbnails already have URLs.');
        return;
    }

    // Show sample updates
    console.log('\n  Sample updates (first 10):');
    const sampleUpdates = Object.entries(toUpdate).slice(0, 10);
    for (const [dn, url] of sampleUpdates) {
        console.log(`    Design #${dn} (${missingByDN[dn]} rows) → ${url.substring(0, 60)}...`);
    }

    if (!LIVE_MODE) {
        console.log('\n' + '='.repeat(60));
        console.log('DRY RUN COMPLETE — No data written.');
        console.log(`To update ${matchCount} designs (${totalRowsToUpdate} rows), run:`);
        console.log('  node scripts/sync-box-thumbnails.js --live');
        console.log('='.repeat(60));
        return;
    }

    // -----------------------------------------------
    // Step 4: Update records in Caspio
    // -----------------------------------------------
    console.log(`\n✏️  Step 4: Updating ${matchCount} designs in Caspio...`);
    const startWrite = Date.now();

    const designNums = Object.keys(toUpdate);
    let updated = 0;
    let errors = 0;

    for (let i = 0; i < designNums.length; i += CONCURRENCY) {
        const chunk = designNums.slice(i, i + CONCURRENCY);

        const results = await Promise.allSettled(
            chunk.map(dn => {
                const whereClause = `Design_Number=${dn} AND (Thumbnail_URL IS NULL OR Thumbnail_URL='')`;
                return updateRecords(UNIFIED_TABLE, whereClause, {
                    Thumbnail_URL: toUpdate[dn]
                });
            })
        );

        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled') {
                updated++;
                if (VERBOSE) {
                    console.log(`    ✓ Design #${chunk[j]} updated`);
                }
            } else {
                errors++;
                const errMsg = results[j].reason?.response?.data?.Message || results[j].reason?.message || 'unknown';
                if (errors <= 20) {
                    console.error(`    ❌ Design #${chunk[j]}: ${errMsg}`);
                }
            }
        }

        // Progress every 500 designs
        if ((i + CONCURRENCY) % 500 < CONCURRENCY && i > 0) {
            const elapsed = ((Date.now() - startWrite) / 1000).toFixed(0);
            const rate = (updated / (elapsed || 1)).toFixed(1);
            console.log(`    Progress: ${updated}/${matchCount} designs (${elapsed}s, ${rate}/sec)`);
        }

        // Small delay between chunks
        await sleep(100);
    }

    const writeTime = ((Date.now() - startWrite) / 1000).toFixed(1);

    // -----------------------------------------------
    // Step 5: Summary
    // -----------------------------------------------
    console.log('\n' + '='.repeat(60));
    console.log('SYNC COMPLETE');
    console.log(`  Designs updated: ${updated.toLocaleString()}`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Write time: ${writeTime}s`);
    console.log(`  New thumbnail coverage: +${updated} designs from Box.com`);
    console.log('='.repeat(60));
}

main().catch(err => {
    console.error('\n💥 FATAL ERROR:', err.message);
    if (err.response?.data) console.error('  API response:', JSON.stringify(err.response.data).substring(0, 500));
    process.exit(1);
});
