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

// Source tables
const TABLES = {
    master: 'Digitized_Designs_Master_2026',
    shopworks: 'ShopWorks_Designs',
    thumbnail: 'Shopworks_Thumbnail_Report',
    artRequests: 'ArtRequests',
    unified: 'Design_Lookup_2026'
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
        'Design_Num_SW', 'ID_Design', 'CompanyName', 'CDN_Link',
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
 * Insert a single record into a Caspio table.
 * Note: Caspio REST v3 does NOT support batch/array POST — each record must be sent individually.
 */
async function insertRecord(tableName, record) {
    if (!LIVE_MODE) return { dryRun: true };

    const token = await getToken();
    const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;

    const resp = await axios.post(url, record, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });

    return resp.data;
}

/**
 * Insert records with concurrency control.
 * Sends CONCURRENCY requests in parallel, waits for all to finish, then next batch.
 */
async function insertWithConcurrency(tableName, records, concurrency = 5, onProgress = null) {
    if (!LIVE_MODE) return { dryRun: true, count: records.length };

    const stats = { inserted: 0, errors: 0 };
    const startTime = Date.now();

    for (let i = 0; i < records.length; i += concurrency) {
        const chunk = records.slice(i, i + concurrency);

        const results = await Promise.allSettled(
            chunk.map(rec => insertRecord(tableName, rec))
        );

        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled') {
                stats.inserted++;
            } else {
                stats.errors++;
                const errMsg = results[j].reason?.response?.data?.Message || results[j].reason?.message || 'unknown';
                if (stats.errors <= 10) {
                    console.error(`  ❌ Design #${chunk[j].Design_Number}: ${errMsg}`);
                }
            }
        }

        // Progress callback
        if (onProgress && (i + concurrency) % 500 < concurrency) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            onProgress(Math.min(i + concurrency, records.length), records.length, elapsed, stats);
        }

        // Small delay between chunks to avoid overwhelming Caspio
        await sleep(50);
    }

    return stats;
}

/**
 * Delete all records from a Caspio table (for full refresh).
 */
async function deleteAllRecords(tableName) {
    if (!LIVE_MODE) return { dryRun: true };

    const token = await getToken();
    const url = `${CASPIO_API_BASE}/tables/${tableName}/records`;

    // Delete with no WHERE = delete all
    const resp = await axios.delete(url, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 60000
    });

    return resp.data;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Merge logic (mirrors digitized-designs.js)
// ============================================

const PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

/**
 * Merge records from all 4 source tables into a unified map.
 * Key = Design_Number, Value = merged record fields for Design_Lookup_2026.
 *
 * Unlike the route's mergeDesignResults() which groups variants,
 * this preserves EACH VARIANT ROW from Master as a separate row in the
 * unified table (important: one design number can have garment/cap/sleeve
 * variants with different stitch counts).
 */
function buildUnifiedRecords(masterRecords, shopworksRecords, thumbnailRecords, artRecords) {
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

        // Customer ID priority: Master → ArtRequests
        // Note: Customer_ID in Master may be a Number, so coerce to String first
        const customerId = (rec.Customer_ID != null ? String(rec.Customer_ID) : '').trim()
            || (art?.Shopwork_customer_number != null ? String(art.Shopwork_customer_number) : '').trim()
            || '';

        // Company priority: Master → ArtRequests → ShopWorks
        const company = (rec.Company || '').trim()
            || (art?.CompanyName || '').trim()
            || (sw?.Company_Name || '').trim()
            || '';

        // Thumbnail URL priority: Master → Thumbnail Report → ArtRequests CDN
        const thumbnailUrl = (rec.Thumbnail_URL || '').trim()
            || (rec.DST_Preview_URL || '').trim()
            || (thumb?.thumbnailUrl || '')
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
            Artwork_URL: artworkUrl.substring(0, 255),
            Placement: (art?.Garment_Placement || '').substring(0, 255),
            Thread_Colors: (sw?.Thread_Colors || '').substring(0, 255),
            Last_Order_Date: sw?.Last_Order_Date || null,
            Order_Count: parseInt(sw?.Order_Count, 10) || 0,
            Art_Notes: (art?.NOTES || '').substring(0, 255),
            Is_Active: 'true',
            Date_Updated: new Date().toISOString()
        });
    }

    // Also add designs that exist ONLY in ShopWorks_Designs (not in Master)
    // These are designs we know about but don't have full stitch data for
    for (const [dn, sw] of Object.entries(swByDN)) {
        if (masterDesignNumbers.has(dn)) continue; // Already handled via Master

        const thumb = thumbByDN[dn];
        const art = artByDN[dn];

        const customerId = (art?.Shopwork_customer_number != null ? String(art.Shopwork_customer_number) : '').trim()
            || '';

        unifiedRecords.push({
            Design_Number: parseInt(dn, 10) || 0,
            Design_Name: (sw.Design_Name || thumb?.designName || '').substring(0, 255),
            Company: (sw.Company_Name || art?.CompanyName || '').substring(0, 255),
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
            Thumbnail_URL: (thumb?.thumbnailUrl || '').substring(0, 255),
            Artwork_URL: (art?.CDN_Link && art.CDN_Link.length > 30 ? art.CDN_Link : '').substring(0, 255),
            Placement: (art?.Garment_Placement || '').substring(0, 255),
            Thread_Colors: (sw.Thread_Colors || '').substring(0, 255),
            Last_Order_Date: sw.Last_Order_Date || null,
            Order_Count: parseInt(sw.Order_Count, 10) || 0,
            Art_Notes: (art?.NOTES || '').substring(0, 255),
            Is_Active: 'true',
            Date_Updated: new Date().toISOString()
        });
    }

    // Also add designs that exist ONLY in ArtRequests (not in Master or ShopWorks)
    for (const [dn, art] of Object.entries(artByDN)) {
        if (masterDesignNumbers.has(dn)) continue;
        if (swByDN[dn]) continue; // Already handled

        const thumb = thumbByDN[dn];

        unifiedRecords.push({
            Design_Number: parseInt(dn, 10) || 0,
            Design_Name: (thumb?.designName || '').substring(0, 255),
            Company: (art.CompanyName || '').substring(0, 255),
            Customer_ID: (art.Shopwork_customer_number != null ? String(art.Shopwork_customer_number) : '').trim().substring(0, 255),
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
            Thumbnail_URL: (thumb?.thumbnailUrl || '').substring(0, 255),
            Artwork_URL: (art.CDN_Link && art.CDN_Link.length > 30 ? art.CDN_Link : '').substring(0, 255),
            Placement: (art.Garment_Placement || '').substring(0, 255),
            Thread_Colors: '',
            Last_Order_Date: null,
            Order_Count: 0,
            Art_Notes: (art.NOTES || '').substring(0, 255),
            Is_Active: 'true',
            Date_Updated: new Date().toISOString()
        });
    }

    // Filter out records with invalid design numbers (0 or NaN)
    return unifiedRecords.filter(r => r.Design_Number > 0);
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
    // Step 2: Merge into unified records
    // -----------------------------------------------
    console.log('\n🔀 Step 2: Merging into unified records...');
    const unifiedRecords = buildUnifiedRecords(masterRecords, shopworksRecords, thumbnailRecords, artRecords);

    // Count unique design numbers
    const uniqueDesigns = new Set(unifiedRecords.map(r => r.Design_Number));
    const withCustomerId = unifiedRecords.filter(r => r.Customer_ID).length;
    const withThumbnail = unifiedRecords.filter(r => r.Thumbnail_URL).length;
    const withArtwork = unifiedRecords.filter(r => r.Artwork_URL).length;
    const withDesignName = unifiedRecords.filter(r => r.Design_Name).length;
    const withStitchData = unifiedRecords.filter(r => r.Stitch_Count > 0).length;

    console.log(`\n  Unified records: ${unifiedRecords.length.toLocaleString()} total rows`);
    console.log(`  Unique design numbers: ${uniqueDesigns.size.toLocaleString()}`);
    console.log(`  With Customer_ID: ${withCustomerId.toLocaleString()} (${(withCustomerId / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With stitch data: ${withStitchData.toLocaleString()} (${(withStitchData / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With design name: ${withDesignName.toLocaleString()} (${(withDesignName / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With thumbnail: ${withThumbnail.toLocaleString()} (${(withThumbnail / unifiedRecords.length * 100).toFixed(1)}%)`);
    console.log(`  With artwork: ${withArtwork.toLocaleString()} (${(withArtwork / unifiedRecords.length * 100).toFixed(1)}%)`);

    // Show sample records
    console.log('\n  Sample records (first 5):');
    for (const rec of unifiedRecords.slice(0, 5)) {
        console.log(`    Design #${rec.Design_Number} — "${rec.Design_Name}" (${rec.Company}) — ${rec.Stitch_Count} stitches, ${rec.Stitch_Tier}`);
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
    try {
        await deleteAllRecords(TABLES.unified);
        console.log(`  Cleared all records from ${TABLES.unified}`);
    } catch (err) {
        // 404 means table is empty — that's fine
        if (err.response?.status === 404 || err.response?.status === 400) {
            console.log(`  Table already empty or no records to delete`);
        } else {
            console.error(`  ⚠️  Delete failed (${err.message}) — will try inserting anyway`);
        }
    }

    // -----------------------------------------------
    // Step 4: Insert all records (concurrent individual POSTs)
    // Note: Caspio REST v3 does NOT support batch/array POST.
    // We use concurrency (5 parallel requests) to maximize throughput.
    // -----------------------------------------------
    console.log('\n📤 Step 4: Inserting records (concurrency=10)...');
    const startWrite = Date.now();

    const stats = await insertWithConcurrency(TABLES.unified, unifiedRecords, 10, (done, total, elapsed, s) => {
        console.log(`  Progress: ${done}/${total} (${elapsed}s) — inserted=${s.inserted}, errors=${s.errors}`);
    });

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
