#!/usr/bin/env node
/**
 * Backfill Customer_ID within Design_Lookup_2026 (self-join + external)
 *
 * Pass 1 — Self-join: Records sharing the same normalized Company name are
 *          grouped together. If ANY record in a group has Customer_ID filled,
 *          ALL empty records in that group get the same ID.
 *
 * Pass 2 — External lookup: Records still missing Customer_ID are matched
 *          against the CSV company list + Caspio customer tables.
 *
 * Usage:
 *   node scripts/backfill-design-lookup-ids.js           # Dry-run (preview only)
 *   node scripts/backfill-design-lookup-ids.js --live     # Write to Caspio
 *
 * This script targets Design_Lookup_2026 directly (the unified table),
 * unlike backfill-customer-ids.js which targets the source tables.
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
// Company name normalization
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
            if (page > 200) break; // safety cap
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

function escapeSQL(str) {
    if (!str) return '';
    return str.replace(/'/g, "''");
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================
// Build external company map (CSV + Caspio tables)
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

    // Add Caspio tables to csvCompanyMap (CSV has priority — already loaded)
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
// Main
// ============================================

async function main() {
    console.log('='.repeat(60));
    console.log('Backfill Customer_ID in Design_Lookup_2026');
    console.log(`Mode: ${LIVE_MODE ? '🔴 LIVE' : '🟢 DRY RUN'}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    const startTime = Date.now();

    if (!CASPIO_DOMAIN || !CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('FATAL: Missing Caspio credentials. Set CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET');
        process.exit(1);
    }

    // Load CSV + Caspio company maps
    loadCompanyCSV();
    await buildFullCompanyMap();

    // -----------------------------------------------
    // Fetch all Design_Lookup_2026 records
    // -----------------------------------------------
    console.log('\n📋 Fetching Design_Lookup_2026...');
    const allRecs = await fetchAll('Design_Lookup_2026', {
        'q.select': 'ID_Unique,Design_Number,Company,Customer_ID'
    });
    console.log(`  Total records: ${allRecs.length.toLocaleString()}`);

    // Count existing fill rate
    const filledBefore = allRecs.filter(r => {
        const id = String(r.Customer_ID || '').trim();
        return id && id !== '0';
    }).length;
    const missingBefore = allRecs.length - filledBefore;
    console.log(`  Already filled: ${filledBefore.toLocaleString()} (${(filledBefore / allRecs.length * 100).toFixed(1)}%)`);
    console.log(`  Missing: ${missingBefore.toLocaleString()} (${(missingBefore / allRecs.length * 100).toFixed(1)}%)`);

    // -----------------------------------------------
    // Pass 1: Self-join within table
    // Group by normalized company, propagate existing IDs
    // -----------------------------------------------
    console.log('\n' + '─'.repeat(50));
    console.log('🔗 Pass 1: Self-Join (propagate within table)');
    console.log('─'.repeat(50));

    // Group by normalized company
    const companyGroups = {};
    let noCompany = 0;
    for (const rec of allRecs) {
        const company = (rec.Company || '').trim();
        if (!company) { noCompany++; continue; }
        const normalized = normalizeCompanyName(company);
        if (!normalized) { noCompany++; continue; }

        if (!companyGroups[normalized]) {
            companyGroups[normalized] = { customerIds: {}, records: [], companies: new Set() };
        }
        const group = companyGroups[normalized];
        const custId = String(rec.Customer_ID || '').trim();
        if (custId && custId !== '0') {
            group.customerIds[custId] = (group.customerIds[custId] || 0) + 1;
        }
        group.records.push(rec);
        group.companies.add(company);
    }

    const totalGroups = Object.keys(companyGroups).length;
    const groupsWithIds = Object.values(companyGroups).filter(g => Object.keys(g.customerIds).length > 0).length;
    console.log(`  Company groups: ${totalGroups.toLocaleString()}`);
    console.log(`  Groups with Customer_IDs: ${groupsWithIds.toLocaleString()}`);
    console.log(`  Records with no company: ${noCompany}`);

    let selfJoinFilled = 0;
    let selfJoinErrors = 0;
    let selfJoinSamples = [];
    let selfJoinGroupsDone = 0;

    // Build list of groups that have IDs and need propagation
    const groupsToUpdate = [];
    for (const [normalized, group] of Object.entries(companyGroups)) {
        const idCounts = group.customerIds;
        if (Object.keys(idCounts).length === 0) continue;

        // Pick most common Customer_ID
        const bestId = Object.entries(idCounts).sort((a, b) => b[1] - a[1])[0][0];

        // Count how many records in this group need updating
        const needUpdate = group.records.filter(r => {
            const currId = String(r.Customer_ID || '').trim();
            return !currId || currId === '0';
        });

        if (needUpdate.length > 0) {
            groupsToUpdate.push({ normalized, group, bestId, count: needUpdate.length });
        }
    }

    console.log(`  Groups needing propagation: ${groupsToUpdate.length.toLocaleString()} (${groupsToUpdate.reduce((s, g) => s + g.count, 0).toLocaleString()} records)`);

    // Update by company name variant (one PUT per unique company spelling, updates ALL matching records at once)
    for (const { normalized, group, bestId, count } of groupsToUpdate) {
        // For each unique company name spelling in this group, do one bulk update
        // Try both Customer_ID=0 and Customer_ID IS NULL to catch all empty records
        for (const companyName of group.companies) {
            if (LIVE_MODE) {
                let totalUpdated = 0;
                // First: records where Customer_ID = 0
                try {
                    const r1 = await updateRecord('Design_Lookup_2026',
                        `Company='${escapeSQL(companyName)}' AND Customer_ID=0`,
                        { Customer_ID: bestId });
                    totalUpdated += r1?.RecordsAffected || 0;
                    await sleep(50);
                } catch (err) {
                    // May get 400 if no records match — that's ok
                    if (err.response?.status !== 400) {
                        selfJoinErrors++;
                        if (selfJoinErrors <= 5) console.error(`    ❌ "${companyName}" (=0): ${err.message}`);
                    }
                }
                // Second: records where Customer_ID IS NULL
                try {
                    const r2 = await updateRecord('Design_Lookup_2026',
                        `Company='${escapeSQL(companyName)}' AND Customer_ID IS NULL`,
                        { Customer_ID: bestId });
                    totalUpdated += r2?.RecordsAffected || 0;
                    await sleep(50);
                } catch (err) {
                    if (err.response?.status !== 400) {
                        selfJoinErrors++;
                        if (selfJoinErrors <= 5) console.error(`    ❌ "${companyName}" (NULL): ${err.message}`);
                    }
                }
                selfJoinFilled += totalUpdated;
                if (selfJoinGroupsDone < 5 && totalUpdated > 0) {
                    console.log(`    ✅ "${companyName}": ${totalUpdated} records → custId ${bestId}`);
                }
            } else {
                selfJoinFilled += count;
                if (selfJoinSamples.length < 10) {
                    selfJoinSamples.push({ company: companyName, count, custId: bestId });
                }
            }
        }
        selfJoinGroupsDone++;
        if (selfJoinGroupsDone % 200 === 0) {
            console.log(`    ... ${selfJoinGroupsDone}/${groupsToUpdate.length} groups processed (${selfJoinFilled.toLocaleString()} records updated)`);
        }
    }

    console.log(`\n  Self-join result: ${selfJoinFilled.toLocaleString()} records updated in ${selfJoinGroupsDone} groups${selfJoinErrors > 0 ? `, ${selfJoinErrors} errors` : ''}`);
    if (!LIVE_MODE && selfJoinSamples.length > 0) {
        console.log('  Samples:');
        for (const s of selfJoinSamples) {
            console.log(`    [DRY] "${s.company}" (${s.count} records): custId→${s.custId}`);
        }
    }

    // -----------------------------------------------
    // Pass 2: External lookup for remaining gaps
    // -----------------------------------------------
    console.log('\n' + '─'.repeat(50));
    console.log('🔍 Pass 2: External Lookup (CSV + Caspio tables)');
    console.log('─'.repeat(50));

    let externalFilled = 0;
    let externalErrors = 0;
    let externalSamples = [];
    let externalGroupsDone = 0;
    let stillMissing = 0;
    let stillMissingCompanies = new Set();

    // Build list of groups with NO internal IDs but possible external matches
    const externalGroups = [];
    for (const [normalized, group] of Object.entries(companyGroups)) {
        if (Object.keys(group.customerIds).length > 0) continue; // self-join handled

        const sampleCompany = Array.from(group.companies)[0];
        const lookup = lookupCustomerByCompany(sampleCompany);

        if (!lookup) {
            const missingInGroup = group.records.filter(r => {
                const currId = String(r.Customer_ID || '').trim();
                return !currId || currId === '0';
            }).length;
            stillMissing += missingInGroup;
            stillMissingCompanies.add(sampleCompany);
            continue;
        }

        const needUpdate = group.records.filter(r => {
            const currId = String(r.Customer_ID || '').trim();
            return !currId || currId === '0';
        });

        if (needUpdate.length > 0) {
            externalGroups.push({ group, lookup, count: needUpdate.length });
        }
    }

    console.log(`  External matches found: ${externalGroups.length} groups (${externalGroups.reduce((s, g) => s + g.count, 0)} records)`);

    for (const { group, lookup, count } of externalGroups) {
        for (const companyName of group.companies) {
            if (LIVE_MODE) {
                let totalUpdated = 0;
                try {
                    const r1 = await updateRecord('Design_Lookup_2026',
                        `Company='${escapeSQL(companyName)}' AND Customer_ID=0`,
                        { Customer_ID: lookup.customerId });
                    totalUpdated += r1?.RecordsAffected || 0;
                    await sleep(50);
                } catch (err) {
                    if (err.response?.status !== 400) {
                        externalErrors++;
                        if (externalErrors <= 5) console.error(`    ❌ "${companyName}" (=0): ${err.message}`);
                    }
                }
                try {
                    const r2 = await updateRecord('Design_Lookup_2026',
                        `Company='${escapeSQL(companyName)}' AND Customer_ID IS NULL`,
                        { Customer_ID: lookup.customerId });
                    totalUpdated += r2?.RecordsAffected || 0;
                    await sleep(50);
                } catch (err) {
                    if (err.response?.status !== 400) {
                        externalErrors++;
                        if (externalErrors <= 5) console.error(`    ❌ "${companyName}" (NULL): ${err.message}`);
                    }
                }
                externalFilled += totalUpdated;
                if (externalGroupsDone < 5 && totalUpdated > 0) {
                    console.log(`    ✅ "${companyName}": ${totalUpdated} records → custId ${lookup.customerId} [${lookup.matchType}]`);
                }
            } else {
                externalFilled += count;
                if (externalSamples.length < 10) {
                    externalSamples.push({ company: companyName, count, custId: lookup.customerId, match: lookup.matchType });
                }
            }
        }
        externalGroupsDone++;
    }

    console.log(`\n  External lookup result: ${externalFilled.toLocaleString()} records updated in ${externalGroupsDone} groups${externalErrors > 0 ? `, ${externalErrors} errors` : ''}`);
    if (!LIVE_MODE && externalSamples.length > 0) {
        console.log('  Samples:');
        for (const s of externalSamples) {
            console.log(`    [DRY] "${s.company}" (${s.count} records): custId→${s.custId} [${s.match}]`);
        }
    }

    // -----------------------------------------------
    // Summary
    // -----------------------------------------------
    const totalFilled = selfJoinFilled + externalFilled;
    const finalMissing = missingBefore - totalFilled;
    const finalFilled = filledBefore + totalFilled;
    const finalRate = (finalFilled / allRecs.length * 100).toFixed(1);

    console.log('\n' + '='.repeat(60));
    console.log('BACKFILL COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Total records:      ${allRecs.length.toLocaleString()}`);
    console.log(`  Before:             ${filledBefore.toLocaleString()} filled (${(filledBefore / allRecs.length * 100).toFixed(1)}%)`);
    console.log(`  Self-join filled:   ${selfJoinFilled.toLocaleString()}`);
    console.log(`  External filled:    ${externalFilled.toLocaleString()}`);
    console.log(`  Total new fills:    ${totalFilled.toLocaleString()}`);
    console.log(`  After:              ${finalFilled.toLocaleString()} filled (${finalRate}%)`);
    console.log(`  Still missing:      ${(stillMissing + noCompany).toLocaleString()} (${noCompany} no company name, ${stillMissing} unmatched)`);
    console.log(`  Duration:           ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);

    if (stillMissingCompanies.size > 0 && stillMissingCompanies.size <= 30) {
        console.log(`\n  Unmatched companies (${stillMissingCompanies.size}):`);
        const sorted = Array.from(stillMissingCompanies).sort();
        for (const c of sorted) {
            console.log(`    - ${c}`);
        }
    } else if (stillMissingCompanies.size > 30) {
        console.log(`\n  ${stillMissingCompanies.size} unmatched unique companies (too many to list)`);
    }

    if (!LIVE_MODE) {
        console.log('\nTo apply updates, run:');
        console.log('  node scripts/backfill-design-lookup-ids.js --live');
    }
}

main().catch(err => {
    console.error('\n💥 Fatal:', err.message);
    process.exit(1);
});
