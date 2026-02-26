#!/usr/bin/env node
/**
 * Backfill Customer_ID into source design tables
 *
 * Uses the same Company → Customer_ID mapping from the CSV + Caspio tables
 * to UPDATE records in the original source tables that are missing Customer_ID.
 *
 * Target tables:
 *   1. Digitized_Designs_Master_2026 (Customer_ID field)
 *   2. ArtRequests (Shopwork_customer_number field)
 *
 * Usage:
 *   node scripts/backfill-customer-ids.js           # Dry-run (preview only)
 *   node scripts/backfill-customer-ids.js --live     # Write to Caspio
 *
 * Note: ShopWorks_Designs does NOT have a Customer_ID field — it only has Company_Name.
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

// ============================================
// Company → Customer_ID CSV mapping
// ============================================

const CSV_PATTERNS = ['company-customer-ids.csv', 'company-customers.csv', 'customer-ids.csv', 'Full Company List 2026.csv'];
let csvCompanyMap = {};

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
    console.log(`[Init] Loaded ${count.toLocaleString()} company→customer mappings from CSV (with correct spellings)`);
}

loadCompanyCSV();

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
            if (page > 50) break;
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function lookupCustomerByCompany(company) {
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

    // Prefix match
    if (normalized.length >= 8) {
        const prefix = normalized.substring(0, Math.min(normalized.length, 15));
        for (const [key, val] of Object.entries(csvCompanyMap)) {
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

// Customer_ID → Sales_Rep mapping
let customerToRep = {};

// Also build map from Caspio customer tables + Sales_Rep assignments
async function buildFullCompanyMap() {
    console.log('\n📥 Fetching customer mapping tables...');

    const [salesReps, contacts, house, taneisha, nika] = await Promise.all([
        fetchAll('Sales_Reps_2026', { 'q.select': 'ID_Customer,CompanyName,Account_Tier' }).catch(() => []),
        fetchAll('Company_Contacts_Merge_ODBC', { 'q.select': 'id_Customer,CustomerCompanyName' }).catch(() => []),
        fetchAll('House_Accounts', { 'q.select': 'ID_Customer,CompanyName' }).catch(() => []),
        fetchAll('Taneisha_All_Accounts_Caspio', { 'q.select': 'ID_Customer,CompanyName' }).catch(() => []),
        fetchAll('Nika_All_Accounts_Caspio', { 'q.select': 'ID_Customer,CompanyName' }).catch(() => [])
    ]);

    console.log(`  SalesReps: ${salesReps.length}, Contacts: ${contacts.length}, House: ${house.length}, Taneisha: ${taneisha.length}, Nika: ${nika.length}`);

    // Add Caspio tables to csvCompanyMap (CSV has priority — already loaded)
    let added = 0;
    function addMapping(company, custId) {
        if (!company || !custId || custId === '0') return;
        const n = normalizeCompanyName(company);
        if (n && !csvCompanyMap[n]) { csvCompanyMap[n] = { custId: String(custId).trim(), correctName: company.trim() }; added++; }
    }
    for (const r of salesReps) addMapping(r.CompanyName, r.ID_Customer);
    for (const r of contacts) addMapping(r.CustomerCompanyName, r.id_Customer);
    for (const r of taneisha) addMapping(r.CompanyName, r.ID_Customer);
    for (const r of nika) addMapping(r.CompanyName, r.ID_Customer);
    for (const r of house) addMapping(r.CompanyName, r.ID_Customer);

    console.log(`  Added ${added} from Caspio tables (total map: ${Object.keys(csvCompanyMap).length.toLocaleString()} companies)`);

    // Build Customer_ID → Sales_Rep map
    for (const rec of taneisha) {
        const id = String(rec.ID_Customer || '').trim();
        if (id && id !== '0') customerToRep[id] = 'Taneisha';
    }
    for (const rec of nika) {
        const id = String(rec.ID_Customer || '').trim();
        if (id && id !== '0') customerToRep[id] = 'Nika';
    }
    // Parse Account_Tier from Sales_Reps_2026 for rep assignment
    for (const rec of salesReps) {
        const id = String(rec.ID_Customer || '').trim();
        if (!id || id === '0' || customerToRep[id]) continue;
        const tier = (rec.Account_Tier || '').toUpperCase();
        if (tier.includes('TANEISHA')) customerToRep[id] = 'Taneisha';
        else if (tier.includes('NIKA')) customerToRep[id] = 'Nika';
    }

    const tCount = Object.values(customerToRep).filter(r => r === 'Taneisha').length;
    const nCount = Object.values(customerToRep).filter(r => r === 'Nika').length;
    console.log(`  Customer→Rep map: ${Object.keys(customerToRep).length} customers (Taneisha=${tCount}, Nika=${nCount})`);
}

// ============================================
// Main
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Backfill Customer_ID into Source Design Tables');
    console.log(`Mode: ${LIVE_MODE ? '🔴 LIVE' : '🟢 DRY RUN'}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    if (!CASPIO_DOMAIN || !CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('FATAL: Missing Caspio credentials');
        process.exit(1);
    }

    await buildFullCompanyMap();

    // -----------------------------------------------
    // Table 1: Digitized_Designs_Master_2026
    // Updates: missing Customer_ID + corrects Company name spelling
    // -----------------------------------------------
    console.log('\n' + '─'.repeat(50));
    console.log('📋 Table 1: Digitized_Designs_Master_2026');
    console.log('─'.repeat(50));

    const masterRecs = await fetchAll('Digitized_Designs_Master_2026', {
        'q.select': 'ID_Unique,Design_Number,Company,Customer_ID'
    });
    console.log(`  Total records: ${masterRecs.length.toLocaleString()}`);

    let masterCustIdFilled = 0;
    let masterNameFixed = 0;
    let masterSkipped = 0;
    let masterErrors = 0;

    for (let i = 0; i < masterRecs.length; i++) {
        const rec = masterRecs[i];
        const company = (rec.Company || '').trim();
        if (!company) { masterSkipped++; continue; }

        const hasCustId = rec.Customer_ID && String(rec.Customer_ID).trim() && String(rec.Customer_ID).trim() !== '0';
        const lookup = lookupCustomerByCompany(company);
        if (!lookup) { masterSkipped++; continue; }

        const updates = {};
        if (!hasCustId && lookup.customerId) {
            updates.Customer_ID = lookup.customerId;
        }
        if (lookup.correctName && lookup.correctName !== company) {
            updates.Company = lookup.correctName;
        }

        if (Object.keys(updates).length === 0) { masterSkipped++; continue; }

        if (LIVE_MODE) {
            try {
                await updateRecord('Digitized_Designs_Master_2026',
                    `ID_Unique=${rec.ID_Unique}`,
                    updates
                );
                if (updates.Customer_ID) masterCustIdFilled++;
                if (updates.Company) masterNameFixed++;
                if ((masterCustIdFilled + masterNameFixed) <= 5) {
                    const changes = [];
                    if (updates.Customer_ID) changes.push(`custId→${updates.Customer_ID}`);
                    if (updates.Company) changes.push(`name: "${company}" → "${updates.Company}"`);
                    console.log(`    ✅ Design #${rec.Design_Number}: ${changes.join(', ')}`);
                }
                await sleep(50);
            } catch (err) {
                masterErrors++;
                if (masterErrors <= 5) console.error(`    ❌ Design #${rec.Design_Number}: ${err.message}`);
            }
        } else {
            if (updates.Customer_ID) masterCustIdFilled++;
            if (updates.Company) masterNameFixed++;
            if ((masterCustIdFilled + masterNameFixed) <= 10) {
                const changes = [];
                if (updates.Customer_ID) changes.push(`custId→${updates.Customer_ID}`);
                if (updates.Company) changes.push(`name: "${company}" → "${updates.Company}"`);
                console.log(`    [DRY] Design #${rec.Design_Number}: ${changes.join(', ')}`);
            }
        }

        if ((i + 1) % 1000 === 0) {
            console.log(`  Progress: ${i + 1}/${masterRecs.length} (custIdFilled=${masterCustIdFilled}, nameFixed=${masterNameFixed})`);
        }
    }

    console.log(`\n  Master results: custIdFilled=${masterCustIdFilled}, nameFixed=${masterNameFixed}, skipped=${masterSkipped}, errors=${masterErrors}`);

    // -----------------------------------------------
    // Table 2: ArtRequests
    // Fields: ID_Design, Design_Num_SW, CompanyName, Shopwork_customer_number, Sales_Rep
    // -----------------------------------------------
    console.log('\n' + '─'.repeat(50));
    console.log('📋 Table 2: ArtRequests');
    console.log('─'.repeat(50));

    const artRecs = await fetchAll('ArtRequests', {
        'q.select': 'ID_Design,Design_Num_SW,CompanyName,Company_Mockup,Shopwork_customer_number,Sales_Rep'
    });
    console.log(`  Total records: ${artRecs.length.toLocaleString()}`);

    let artCustIdFilled = 0;
    let artNameFixed = 0;
    let artRepFilled = 0;
    let artMockupMatches = 0;
    let artSkipped = 0;
    let artErrors = 0;

    for (let i = 0; i < artRecs.length; i++) {
        const rec = artRecs[i];
        const company = (rec.CompanyName || '').trim() || (rec.Company_Mockup || '').trim();
        const companyFromMockup = company && !(rec.CompanyName || '').trim() && (rec.Company_Mockup || '').trim();
        if (!company) { artSkipped++; continue; }

        const hasCustId = rec.Shopwork_customer_number &&
            String(rec.Shopwork_customer_number).trim() &&
            String(rec.Shopwork_customer_number).trim() !== '0';

        const lookup = lookupCustomerByCompany(company);
        if (!lookup) { artSkipped++; continue; }

        const updates = {};
        if (!hasCustId && lookup.customerId) {
            updates.Shopwork_customer_number = lookup.customerId;
            if (companyFromMockup) artMockupMatches++;
        }
        if (lookup.correctName && lookup.correctName !== company) {
            // If company came from Company_Mockup, also update CompanyName
            updates.CompanyName = lookup.correctName;
        }

        // Fill Sales_Rep if empty — use existing or newly-found customer ID to determine rep
        const effectiveCustId = hasCustId ? String(rec.Shopwork_customer_number).trim() : (lookup.customerId || '');
        const hasSalesRep = rec.Sales_Rep && String(rec.Sales_Rep).trim();
        if (!hasSalesRep && effectiveCustId && customerToRep[effectiveCustId]) {
            updates.Sales_Rep = customerToRep[effectiveCustId];
        }

        if (Object.keys(updates).length === 0) { artSkipped++; continue; }

        if (LIVE_MODE) {
            try {
                await updateRecord('ArtRequests',
                    `ID_Design=${rec.ID_Design}`,
                    updates
                );
                if (updates.Shopwork_customer_number) artCustIdFilled++;
                if (updates.CompanyName) artNameFixed++;
                if (updates.Sales_Rep) artRepFilled++;
                if ((artCustIdFilled + artNameFixed + artRepFilled) <= 5) {
                    const changes = [];
                    if (updates.Shopwork_customer_number) changes.push(`custId→${updates.Shopwork_customer_number}`);
                    if (updates.CompanyName) changes.push(`name: "${company}" → "${updates.CompanyName}"`);
                    if (updates.Sales_Rep) changes.push(`rep→${updates.Sales_Rep}`);
                    console.log(`    ✅ Art #${rec.ID_Design} (Design #${rec.Design_Num_SW}): ${changes.join(', ')}`);
                }
                await sleep(50);
            } catch (err) {
                artErrors++;
                if (artErrors <= 5) console.error(`    ❌ Art #${rec.ID_Design}: ${err.message}`);
            }
        } else {
            if (updates.Shopwork_customer_number) artCustIdFilled++;
            if (updates.CompanyName) artNameFixed++;
            if (updates.Sales_Rep) artRepFilled++;
            if ((artCustIdFilled + artNameFixed + artRepFilled) <= 15) {
                const changes = [];
                if (updates.Shopwork_customer_number) changes.push(`custId→${updates.Shopwork_customer_number}`);
                if (updates.CompanyName) changes.push(`name: "${company}" → "${updates.CompanyName}"`);
                if (updates.Sales_Rep) changes.push(`rep→${updates.Sales_Rep}`);
                console.log(`    [DRY] Art #${rec.ID_Design} (Design #${rec.Design_Num_SW}): ${changes.join(', ')}`);
            }
        }

        if ((i + 1) % 500 === 0) {
            console.log(`  Progress: ${i + 1}/${artRecs.length} (custIdFilled=${artCustIdFilled}, nameFixed=${artNameFixed}, repFilled=${artRepFilled})`);
        }
    }

    console.log(`\n  ArtRequests results: custIdFilled=${artCustIdFilled} (${artMockupMatches} via Company_Mockup), nameFixed=${artNameFixed}, repFilled=${artRepFilled}, skipped=${artSkipped}, errors=${artErrors}`);

    // -----------------------------------------------
    // Summary
    // -----------------------------------------------
    console.log('\n' + '='.repeat(60));
    console.log('BACKFILL COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Master:      custIdFilled=${masterCustIdFilled}, nameFixed=${masterNameFixed}, skipped=${masterSkipped}, errors=${masterErrors}`);
    console.log(`  ArtRequests: custIdFilled=${artCustIdFilled} (${artMockupMatches} via Company_Mockup), nameFixed=${artNameFixed}, repFilled=${artRepFilled}, skipped=${artSkipped}, errors=${artErrors}`);
    console.log(`  Total: ${masterCustIdFilled + artCustIdFilled} customer IDs filled, ${masterNameFixed + artNameFixed} names corrected, ${artRepFilled} sales reps filled`);

    if (!LIVE_MODE) {
        console.log('\nTo apply updates, run:');
        console.log('  node scripts/backfill-customer-ids.js --live');
    }
}

main().catch(err => {
    console.error('\n💥 Fatal:', err.message);
    process.exit(1);
});
