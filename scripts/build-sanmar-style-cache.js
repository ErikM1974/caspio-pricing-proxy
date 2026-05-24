#!/usr/bin/env node
/**
 * build-sanmar-style-cache.js
 *
 * Walks Sanmar_Bulk_251816_Feb2024 once, extracts every unique STYLE value,
 * writes scripts/.sanmar-styles.cache.json (an array of strings).
 *
 * Used by aggregate-industry-lookalikes-v2.js to authoritatively cross-check
 * MO line item PartNumbers — "is this PN actually a SanMar catalog style?"
 *
 * Re-run when SanMar adds new styles (quarterly or so).
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const OUTPUT = path.join(__dirname, '.sanmar-styles.cache.json');

async function rawGet(resourcePath, params = {}) {
    const token = await getCaspioAccessToken();
    return (await axios.get(`${config.caspio.apiBaseUrl}${resourcePath}`, {
        params, headers: { Authorization: `Bearer ${token}` }, timeout: 60000,
    })).data;
}

(async () => {
    console.log('Walking Sanmar_Bulk_251816_Feb2024 for unique STYLE values...');
    const styles = new Set();
    let page = 1;
    let totalRows = 0;
    const start = Date.now();

    while (true) {
        const r = await rawGet('/tables/Sanmar_Bulk_251816_Feb2024/records', {
            'q.select': 'STYLE',
            'q.pageSize': 1000,
            'q.pageNumber': page,
        });
        const got = (r.Result || []);
        totalRows += got.length;
        for (const row of got) {
            const s = String(row.STYLE || '').trim().toUpperCase();
            if (s) styles.add(s);
        }
        if (got.length < 1000) break;
        page++;
        if (page % 25 === 0) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(0);
            console.log(`  page ${page} · ${totalRows} rows scanned · ${styles.size} unique styles · ${elapsed}s elapsed`);
        }
        if (page > 500) {
            console.log('  bailout at 500 pages = 500K rows');
            break;
        }
    }

    const arr = [...styles].sort();
    fs.writeFileSync(OUTPUT, JSON.stringify(arr), 'utf8');
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n✓ Scanned ${totalRows} bulk rows in ${elapsed}s`);
    console.log(`✓ Found ${arr.length} unique SanMar STYLE values`);
    console.log(`✓ Cached to ${OUTPUT} (${Math.round(fs.statSync(OUTPUT).size / 1024)} KB)`);
    console.log(`\nSample (first 20): ${arr.slice(0, 20).join(', ')}`);
})().catch(e => {
    console.error('FATAL:', e.response?.data || e.message);
    process.exit(1);
});
