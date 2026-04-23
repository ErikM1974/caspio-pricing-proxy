#!/usr/bin/env node
/**
 * Backfill Digitizing_Mockups from Orphan Box Folders
 *
 * Thin CLI wrapper around src/utils/detect-orphan-mockups.js. For every
 * Box folder under BOX_MOCKUP_FOLDER_ID that isn't linked to a Caspio row
 * and isn't a duplicate of a live row, create a legacy Caspio row pointing
 * at the folder.
 *
 * Every backfilled row is stamped:
 *   Submitted_By  = 'legacy-import@nwcustomapparel.com'
 *   Request_Type  = 'Legacy Import'
 *   Status        = 'Completed'
 * so Ruth can filter / bulk-reverse if needed.
 *
 * Quality filters (applied by default — pass --includeAll to disable):
 *   - Skip folders with NO image inside
 *   - Skip design numbers that look like test data (1-4 or 6+ digits)
 *
 * Usage:
 *   node scripts/backfill-mockups-from-box.js               # Dry-run, cleaned
 *   node scripts/backfill-mockups-from-box.js --apply       # Insert the clean set
 *   node scripts/backfill-mockups-from-box.js --includeAll  # Disable quality filters
 *   node scripts/backfill-mockups-from-box.js --verbose     # Per-folder detail
 *
 * Env vars required (same as the backend):
 *   CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET
 *   BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID, BOX_MOCKUP_FOLDER_ID
 */

require('dotenv').config();
const axios = require('axios');
const { detectOrphans } = require('../src/utils/detect-orphan-mockups');

// ─── CLI flags ────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const INCLUDE_ALL = process.argv.includes('--includeAll');

// ─── Config ───────────────────────────────────────────────────────────
const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CASPIO_API_BASE = `https://${CASPIO_DOMAIN}/integrations/rest/v3`;
const MOCKUPS_TABLE = 'Digitizing_Mockups';
const LEGACY_SUBMITTER = 'legacy-import@nwcustomapparel.com';
const LEGACY_REQUEST_TYPE = 'Legacy Import';

// ─── Sanity ───────────────────────────────────────────────────────────
const required = {
    CASPIO_ACCOUNT_DOMAIN: process.env.CASPIO_ACCOUNT_DOMAIN,
    CASPIO_CLIENT_ID: process.env.CASPIO_CLIENT_ID,
    CASPIO_CLIENT_SECRET: process.env.CASPIO_CLIENT_SECRET,
    BOX_CLIENT_ID: process.env.BOX_CLIENT_ID,
    BOX_CLIENT_SECRET: process.env.BOX_CLIENT_SECRET,
    BOX_ENTERPRISE_ID: process.env.BOX_ENTERPRISE_ID,
    BOX_MOCKUP_FOLDER_ID: process.env.BOX_MOCKUP_FOLDER_ID
};
for (const [k, v] of Object.entries(required)) {
    if (!v) {
        console.error(`ERROR: ${k} is not set in env.`);
        process.exit(1);
    }
}

// ─── Caspio insert helper (POST dedup guard bypassed via allowDuplicate=true) ──
let caspioToken = null;
let caspioTokenExpiry = 0;

async function getCaspioToken() {
    const now = Math.floor(Date.now() / 1000);
    if (caspioToken && now < caspioTokenExpiry - 60) return caspioToken;
    const resp = await axios.post(`https://${CASPIO_DOMAIN}/oauth/token`, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CASPIO_CLIENT_ID,
        client_secret: process.env.CASPIO_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    caspioToken = resp.data.access_token;
    caspioTokenExpiry = now + resp.data.expires_in;
    return caspioToken;
}

async function insertCaspioRow(payload) {
    const token = await getCaspioToken();
    // Write directly to Caspio — bypasses the app's dedup guard. This script
    // has already done stricter dedup (on both Box_Folder_ID AND (design, company))
    // via detectOrphans, so the app-level guard would be redundant.
    const resp = await axios.post(`${CASPIO_API_BASE}/tables/${MOCKUPS_TABLE}/records`, payload, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30000
    });
    const loc = resp.headers.location || '';
    const match = loc.match(/ID[=](\d+)/i);
    return match ? parseInt(match[1], 10) : null;
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(70));
    console.log('Backfill Digitizing_Mockups from orphan Box folders');
    console.log('Mode:', APPLY ? 'APPLY (writing to Caspio)' : 'DRY-RUN (no writes)');
    console.log('='.repeat(70));

    console.log('\nScanning Box + Caspio...');
    const report = await detectOrphans({
        applyQualityFilters: !INCLUDE_ALL,
        inspectFolderContents: true
    });

    console.log(`  Box folders:          ${report.boxTotal}`);
    console.log(`  Caspio rows total:    ${report.caspioTotal} (live: ${report.liveCount}, soft-deleted: ${report.softDeletedCount})`);
    console.log(`  Linked folder IDs:    ${report.linkedCount}`);
    console.log(`  Dup of live row:      ${report.dedupSkipped.length} skipped`);
    if (!INCLUDE_ALL) {
        console.log(`  Test design#:         ${report.testSkipped.length} skipped`);
        console.log(`  Empty folders:        ${report.emptySkipped.length} skipped`);
    }
    console.log(`  Clean orphans:        ${report.orphans.length}`);

    if (VERBOSE) {
        if (report.dedupSkipped.length) {
            console.log('\n  Skipped (duplicates of live rows):');
            for (const s of report.dedupSkipped) {
                console.log(`    - [${s.folder.id}] "${s.folder.name}"`);
            }
        }
        if (report.testSkipped.length) {
            console.log('\n  Filtered as test design#:');
            for (const s of report.testSkipped) {
                console.log(`    - [${s.folder.id}] "${s.folder.name}"`);
            }
        }
        if (report.emptySkipped.length) {
            console.log('\n  Filtered as empty folders:');
            for (const s of report.emptySkipped) {
                console.log(`    - [${s.folder.id}] "${s.folder.name}"`);
            }
        }
    }

    if (report.orphans.length === 0) {
        console.log('\nNothing to backfill — Box and Caspio are in sync.');
        return;
    }

    console.log('\n' + (APPLY ? 'Inserting:' : 'Would insert (dry-run):'));
    let inserted = 0;
    let failed = 0;

    for (const o of report.orphans) {
        const payload = {
            Design_Number: o.designNumber || '',
            Design_Name: o.companyName,
            Company_Name: o.companyName,
            Id_Customer: 0,
            Mockup_Type: '',
            Status: 'Completed',
            Submitted_By: LEGACY_SUBMITTER,
            Request_Type: LEGACY_REQUEST_TYPE,
            Box_Folder_ID: String(o.folder.id),
            Box_Mockup_1: o.mockup1Url,
            Revision_Count: 0,
            Is_Deleted: false
        };

        const line = `  [${o.folder.id}] "${o.folder.name}"  →  Design=${payload.Design_Number || '(blank)'}, Mockup_1=${o.mockup1Url ? 'yes' : 'no'}`;

        if (APPLY) {
            try {
                const newId = await insertCaspioRow(payload);
                console.log(`  ✓ Inserted ID=${newId}  "${o.folder.name}"`);
                inserted++;
            } catch (err) {
                const body = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
                console.error(`  ✗ FAILED "${o.folder.name}": ${body}`);
                failed++;
            }
        } else {
            console.log(line);
        }
    }

    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    console.log(`Clean orphans to insert: ${report.orphans.length}`);
    if (APPLY) {
        console.log(`Inserted:                ${inserted}`);
        console.log(`Failed:                  ${failed}`);
    } else {
        console.log(`(Dry-run — no writes.    Pass --apply to insert ${report.orphans.length} rows)`);
    }
}

main().catch(err => {
    console.error('\nFATAL:', err.response ? JSON.stringify(err.response.data) : err.message);
    process.exit(1);
});
