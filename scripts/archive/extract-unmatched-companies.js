#!/usr/bin/env node
/**
 * Extract unmatched companies from Design_Lookup_2026
 * (records with a Company name but Customer_ID = 0 or NULL)
 * Outputs CSV: Company, RecordCount, SampleDesignNumbers
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const CASPIO_TOKEN_URL = `https://${CASPIO_DOMAIN}/oauth/token`;
const CASPIO_API_BASE = `https://${CASPIO_DOMAIN}/integrations/rest/v3`;

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
        const resp = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            params: reqParams, timeout: 30000
        });
        const records = resp.data?.Result || [];
        allResults = allResults.concat(records);
        if (records.length < pageSize) break;
        page++;
        if (page > 200) break;
    }
    return allResults;
}

function escapeCSV(str) {
    if (!str) return '';
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

async function main() {
    console.log('Fetching records with missing Customer_ID from Design_Lookup_2026...');

    // Fetch records where Customer_ID = 0 (most of them)
    const zeroRecords = await fetchAll('Design_Lookup_2026', {
        'q.select': 'Company,Design_Number,Customer_ID,Is_Active',
        'q.where': "Customer_ID=0 AND Company<>''"
    });
    console.log(`  Records with Customer_ID=0 and a company name: ${zeroRecords.length}`);

    // Also fetch records where Customer_ID IS NULL (some may exist)
    let nullRecords = [];
    try {
        nullRecords = await fetchAll('Design_Lookup_2026', {
            'q.select': 'Company,Design_Number,Customer_ID,Is_Active',
            'q.where': "Customer_ID IS NULL AND Company<>''"
        });
        console.log(`  Records with Customer_ID IS NULL and a company name: ${nullRecords.length}`);
    } catch (err) {
        console.log(`  NULL query returned error (likely 0 results): ${err.message}`);
    }

    const allMissing = [...zeroRecords, ...nullRecords];
    console.log(`  Total unmatched records with company names: ${allMissing.length}`);

    // Group by company name
    const companyGroups = {};
    for (const rec of allMissing) {
        const company = (rec.Company || '').trim();
        if (!company) continue;

        if (!companyGroups[company]) {
            companyGroups[company] = {
                company,
                count: 0,
                designNumbers: new Set(),
                isActive: new Set()
            };
        }
        companyGroups[company].count++;
        if (rec.Design_Number) {
            companyGroups[company].designNumbers.add(String(rec.Design_Number));
        }
        if (rec.Is_Active !== undefined && rec.Is_Active !== null) {
            companyGroups[company].isActive.add(String(rec.Is_Active));
        }
    }

    // Sort by record count descending
    const sorted = Object.values(companyGroups).sort((a, b) => b.count - a.count);

    console.log(`\n  Unique companies without Customer_ID: ${sorted.length}`);
    console.log(`  Total records: ${sorted.reduce((sum, g) => sum + g.count, 0)}`);

    // Build CSV
    const csvLines = ['Company,Record_Count,Sample_Design_Numbers,Is_Active_Values'];
    for (const group of sorted) {
        const sampleDesigns = [...group.designNumbers].slice(0, 5).join('; ');
        const activeVals = [...group.isActive].join('; ');
        csvLines.push(`${escapeCSV(group.company)},${group.count},${escapeCSV(sampleDesigns)},${escapeCSV(activeVals)}`);
    }

    const csvContent = csvLines.join('\n');
    const outputPath = path.join(__dirname, 'data', 'unmatched-companies.csv');
    fs.writeFileSync(outputPath, csvContent, 'utf8');
    console.log(`\n✅ CSV written to: ${outputPath}`);
    console.log(`   ${sorted.length} companies, ${sorted.reduce((sum, g) => sum + g.count, 0)} total records`);

    // Quick summary
    console.log('\n--- Top 20 by record count ---');
    for (const g of sorted.slice(0, 20)) {
        console.log(`  ${g.company}: ${g.count} records (designs: ${[...g.designNumbers].slice(0, 3).join(', ')})`);
    }

    // Stats
    const singleRecord = sorted.filter(g => g.count === 1).length;
    const twoToFive = sorted.filter(g => g.count >= 2 && g.count <= 5).length;
    const sixPlus = sorted.filter(g => g.count >= 6).length;
    console.log(`\n--- Distribution ---`);
    console.log(`  1 record: ${singleRecord} companies`);
    console.log(`  2-5 records: ${twoToFive} companies`);
    console.log(`  6+ records: ${sixPlus} companies`);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
