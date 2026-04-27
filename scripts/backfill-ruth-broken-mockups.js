#!/usr/bin/env node
/**
 * Backfill: Re-link broken Box mockup URLs on Ruth's Digitizing_Mockups table
 *
 * Sister of `backfill-steve-broken-mockups.js`. Same problem, different
 * table:
 *   - Caspio: Digitizing_Mockups (id col `ID`, design col `Design_Number`,
 *     company col `Company_Name`)
 *   - Each row has up to 7 mockup slots: Box_Mockup_1..6 + Box_Reference_File
 *   - Box parent: BOX_MOCKUP_FOLDER_ID (Ruth's "Digitizing Mockups" folder)
 *
 * For each row with at least one broken slot, this script:
 *   1. Searches Ruth's Box folder for a sub-folder matching the design#
 *      (Pass 1) or company name (Pass 2).
 *   2. Picks the best image inside (HIGH confidence = filename contains
 *      design#, MEDIUM = canonical folder name).
 *   3. Replaces the broken slot's URL with a fresh
 *      `/api/box/thumbnail/{fileId}` proxy URL.
 *
 * Default mode is DRY-RUN. Pass --apply to actually write to Caspio.
 *
 * Usage:
 *   node scripts/backfill-ruth-broken-mockups.js              # Dry-run
 *   node scripts/backfill-ruth-broken-mockups.js --apply      # Write updates
 *   node scripts/backfill-ruth-broken-mockups.js --verbose    # Per-record detail
 *   node scripts/backfill-ruth-broken-mockups.js --since=2026-01-01  # Wider date filter
 *
 * Env vars required:
 *   CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET
 *   BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID, BOX_MOCKUP_FOLDER_ID
 *
 * Related: same recovery algorithm is exposed at
 *   POST /api/mockups/:id/auto-recover-mockup
 *   POST /api/mockups/auto-recover-mockups-bulk
 * via `src/utils/recover-broken-ruth-mockup.js`. Ruth's dashboard
 * "Broken Links" modal calls those routes for on-demand recovery; this
 * script remains for full-table sweeps + reporting.
 */

require('dotenv').config();
const axios = require('axios');

// ─── CLI flags ────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const sinceArg = process.argv.find(a => a.startsWith('--since='));
const SINCE = sinceArg ? sinceArg.split('=')[1] : '2026-01-01';

// ─── Config ───────────────────────────────────────────────────────────
const PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CASPIO_API_BASE = `https://${CASPIO_DOMAIN}/integrations/rest/v3`;
const BOX_API_BASE = 'https://api.box.com/2.0';
const MOCKUPS_TABLE = 'Digitizing_Mockups';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;

const SLOT_FIELDS = [
    'Box_Mockup_1', 'Box_Mockup_2', 'Box_Mockup_3',
    'Box_Mockup_4', 'Box_Mockup_5', 'Box_Mockup_6',
    'Box_Reference_File'
];

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

// ─── Box auth ─────────────────────────────────────────────────────────
let boxToken = null;
let boxTokenExpiry = 0;

async function getBoxToken() {
    const now = Math.floor(Date.now() / 1000);
    if (boxToken && now < boxTokenExpiry - 60) return boxToken;
    const resp = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.BOX_CLIENT_ID,
        client_secret: process.env.BOX_CLIENT_SECRET,
        box_subject_type: 'enterprise',
        box_subject_id: process.env.BOX_ENTERPRISE_ID
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    boxToken = resp.data.access_token;
    boxTokenExpiry = now + resp.data.expires_in;
    return boxToken;
}

// ─── Caspio auth ──────────────────────────────────────────────────────
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

// ─── Step 1: Fetch records with at least one slot populated ──────────
async function fetchCandidates() {
    const token = await getCaspioToken();
    const select = ['ID', 'Design_Number', 'Company_Name', 'Status', 'Submitted_Date',
        ...SLOT_FIELDS].join(',');
    const slotNotNull = SLOT_FIELDS.map(f => `${f} IS NOT NULL`).join(' OR ');
    const where = `(${slotNotNull}) AND Submitted_Date >= '${SINCE}'`
        + ` AND (Is_Deleted=0 OR Is_Deleted IS NULL)`;
    const url = `${CASPIO_API_BASE}/tables/${MOCKUPS_TABLE}/records`
        + `?q.where=${encodeURIComponent(where)}`
        + `&q.select=${encodeURIComponent(select)}`
        + `&q.limit=1000`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 30000
    });
    return resp.data.Result || [];
}

// Extract Box fileId from a /api/box/thumbnail/{id} URL.
function extractFileId(url) {
    if (!url) return null;
    const m = String(url).match(/\/api\/box\/thumbnail\/(\d+)/);
    return m ? m[1] : null;
}

// HEAD a Box fileId — true if the file exists in Box.
async function fileIdExists(fileId) {
    if (!fileId) return false;
    const token = await getBoxToken();
    try {
        const resp = await axios.head(`${BOX_API_BASE}/files/${fileId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 8000,
            validateStatus: () => true
        });
        return resp.status === 200;
    } catch (err) {
        return false;
    }
}

// ─── Step 2: Box folder search ───────────────────────────────────────
const folderCache = new Map();

async function findFolderByDesign(designStr) {
    if (!designStr) return null;
    if (folderCache.has(designStr)) return folderCache.get(designStr);

    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: designStr,
                type: 'folder',
                ancestor_folder_ids: process.env.BOX_MOCKUP_FOLDER_ID,
                fields: 'id,name,type',
                limit: 10
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const entries = resp.data.entries || [];
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name.startsWith(designStr)) {
                folderCache.set(designStr, entry);
                return entry;
            }
        }
    } catch (err) {
        if (VERBOSE) console.log(`  Box search failed for #${designStr}: ${err.message}`);
    }
    folderCache.set(designStr, null);
    return null;
}

async function findFolderByCompany(companyName) {
    if (!companyName || !companyName.trim()) return null;
    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: companyName.trim(),
                type: 'folder',
                ancestor_folder_ids: process.env.BOX_MOCKUP_FOLDER_ID,
                fields: 'id,name,type',
                limit: 10
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const entries = resp.data.entries || [];
        const lc = companyName.trim().toLowerCase();
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name.toLowerCase().includes(lc)) {
                return entry;
            }
        }
    } catch (err) {
        if (VERBOSE) console.log(`  Box company search failed for "${companyName}": ${err.message}`);
    }
    return null;
}

// ─── Step 3: Pick best image in folder for design# ──────────────────
async function findMockupFile(folderId, folderName, designStr) {
    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/folders/${folderId}/items`, {
            params: { fields: 'id,type,name,modified_at', limit: 200 },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 30000
        });
        const allImages = (resp.data.entries || [])
            .filter(e => e.type === 'file' && IMAGE_EXT_RE.test(e.name || ''))
            .sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));

        if (allImages.length === 0) return { file: null, reason: 'NO_IMAGE' };

        // HIGH: design# in filename
        const designMatched = allImages.filter(f => (f.name || '').indexOf(designStr) !== -1);
        if (designMatched.length > 0) {
            return { file: designMatched[0], reason: 'DESIGN_NUMBER_MATCH', confidence: 'HIGH' };
        }

        // MEDIUM: folder name canonical (exact prefix + non-digit separator)
        const sep = (folderName || '').charAt(designStr.length);
        const folderExactPrefix = (folderName || '').startsWith(designStr)
            && (sep === '' || /[^\d]/.test(sep));
        if (folderExactPrefix) {
            return { file: allImages[0], reason: 'FOLDER_NAME_TRUST', confidence: 'MEDIUM' };
        }

        return {
            file: null,
            reason: 'NO_FILENAME_MATCH',
            candidates: allImages.slice(0, 3).map(f => f.name)
        };
    } catch (err) {
        if (VERBOSE) console.log(`  Box folder list failed for ${folderId}: ${err.message}`);
        return { file: null, reason: 'ERROR' };
    }
}

// ─── Step 4: Update Caspio ───────────────────────────────────────────
async function updateMockupSlot(id, slotField, newUrl, boxFolderId) {
    const token = await getCaspioToken();
    const endpoint = `${CASPIO_API_BASE}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
    const payload = { [slotField]: newUrl };
    if (boxFolderId) payload.Box_Folder_ID = boxFolderId;
    await axios.put(endpoint, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────
function normalizeStatus(raw) {
    if (!raw) return '';
    if (typeof raw === 'object') {
        const vals = Object.values(raw);
        return vals.length > 0 ? String(vals[0]).trim() : '';
    }
    return String(raw).trim();
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(72));
    console.log('Backfill: Re-link broken Box mockup URLs on Ruth\'s queue');
    console.log('Mode:', APPLY ? 'APPLY (writing to Caspio)' : 'DRY-RUN (no writes)');
    console.log('Since:', SINCE);
    console.log('='.repeat(72));

    console.log('\n[1/4] Fetching Digitizing_Mockups records with at least one slot populated...');
    const allRecs = await fetchCandidates();
    console.log(`  Pulled ${allRecs.length} records`);

    if (allRecs.length === 0) {
        console.log('\nNothing to do. Exiting.');
        return;
    }

    // Filter cancelled records
    const candidates = allRecs.filter(r => {
        const status = normalizeStatus(r.Status).toLowerCase();
        if (status === 'cancelled' || status === 'cancel' || status === 'canceled') return false;
        return true;
    });
    const skippedCancelled = allRecs.length - candidates.length;
    if (skippedCancelled > 0) console.log(`  Skipping ${skippedCancelled} cancelled records.`);

    console.log('\n[2/4] HEAD-checking every populated slot URL against Box...');
    // brokenSlots[i] = { rec, slotField, currentFileId }
    const brokenSlots = [];
    let totalSlotsScanned = 0;
    let liveSlots = 0;
    let unrecognizedSlots = 0;

    for (const rec of candidates) {
        for (const field of SLOT_FIELDS) {
            const url = rec[field];
            if (!url) continue;
            totalSlotsScanned++;
            const fileId = extractFileId(url);
            if (!fileId) {
                // Older shared/static or other URL shape — flag as broken so
                // the recovery pass either fixes it or reports it.
                unrecognizedSlots++;
                brokenSlots.push({ rec, slotField: field, currentFileId: null, reason: 'NON_PROXY_URL' });
                continue;
            }
            const exists = await fileIdExists(fileId);
            if (exists) {
                liveSlots++;
            } else {
                brokenSlots.push({ rec, slotField: field, currentFileId: fileId, reason: 'BOX_404' });
            }
        }
    }
    console.log(`  Slots scanned:     ${totalSlotsScanned}`);
    console.log(`  Live in Box:       ${liveSlots}`);
    console.log(`  Non-proxy URLs:    ${unrecognizedSlots}`);
    console.log(`  Box 404 (broken):  ${brokenSlots.length - unrecognizedSlots}`);
    console.log(`  Total to recover:  ${brokenSlots.length}`);

    if (brokenSlots.length === 0) {
        console.log('\nNo broken slots. Exiting.');
        return;
    }

    console.log('\n[3/4] Searching Box for replacement file for each broken slot...');
    const updates = [];
    const noFolder = [];
    const noImage = [];
    const noFilenameMatch = [];
    const noDesignNum = [];

    for (let i = 0; i < brokenSlots.length; i++) {
        const { rec, slotField, currentFileId } = brokenSlots[i];
        const designStr = String(rec.Design_Number || '').trim();
        const company = rec.Company_Name || '';
        process.stdout.write(`  [${i + 1}/${brokenSlots.length}] ID=${rec.ID} ${slotField} #${designStr || '(none)'} ${company.slice(0, 28)}... `);

        if (!designStr) {
            console.log('SKIP (no Design_Number)');
            noDesignNum.push({ rec, slotField });
            continue;
        }

        let folder = await findFolderByDesign(designStr);
        if (!folder && company) folder = await findFolderByCompany(company);
        if (!folder) {
            console.log('NO FOLDER');
            noFolder.push({ rec, slotField });
            continue;
        }

        const result = await findMockupFile(folder.id, folder.name, designStr);
        if (result.reason === 'NO_IMAGE') {
            console.log(`NO IMAGE in folder "${folder.name}"`);
            noImage.push({ rec, slotField, folder });
            continue;
        }
        if (result.reason === 'NO_FILENAME_MATCH') {
            console.log(`SKIP — folder "${folder.name}" has images but none contain "${designStr}" (candidates: ${(result.candidates || []).join(', ')})`);
            noFilenameMatch.push({ rec, slotField, folder, candidates: result.candidates });
            continue;
        }
        if (!result.file) {
            console.log(`SKIP (folder list error)`);
            continue;
        }

        const file = result.file;
        if (currentFileId === file.id) {
            // Same fileId — Box says it doesn't exist but our fileId match
            // is still pointing at the canonical file. This is unusual; log
            // and skip so we don't loop forever.
            console.log(`SKIP (Box says fileId ${file.id} both matches AND 404s)`);
            continue;
        }

        const newUrl = `${PROXY_BASE}/api/box/thumbnail/${file.id}`;
        updates.push({ rec, slotField, folder, file, newUrl, confidence: result.confidence });
        const confTag = result.confidence === 'HIGH' ? '' : ` [${result.confidence} via ${result.reason}]`;
        console.log(`UPDATE: ${currentFileId || '(non-proxy)'} → ${file.id} (${file.name})${confTag}`);
    }

    console.log('\n[4/4] Match summary:');
    console.log(`  ✓ Will update slot:        ${updates.length}`);
    console.log(`  · No Box folder found:     ${noFolder.length}`);
    console.log(`  · Folder found, no image:  ${noImage.length}`);
    console.log(`  · No filename match:       ${noFilenameMatch.length}`);
    console.log(`  · No Design_Number:        ${noDesignNum.length}`);
    console.log(`  · Cancelled (filtered):    ${skippedCancelled}`);

    if (VERBOSE && noFolder.length) {
        console.log('\n  Records with no Box folder match:');
        noFolder.forEach(({ rec, slotField }) => console.log(`    ID=${rec.ID} ${slotField} #${rec.Design_Number} ${rec.Company_Name}`));
    }
    if (VERBOSE && noImage.length) {
        console.log('\n  Records with folder but no image:');
        noImage.forEach(({ rec, slotField, folder }) => console.log(`    ID=${rec.ID} ${slotField} #${rec.Design_Number} ${rec.Company_Name} → folder "${folder.name}" (id ${folder.id})`));
    }

    if (updates.length === 0) {
        console.log('\nNo updates to apply.');
        return;
    }

    console.log(`\n${APPLY ? 'Applying' : 'Would apply'} ${updates.length} updates:`);
    let applied = 0;
    let failed = 0;
    for (const u of updates) {
        const newShort = u.newUrl.split('/').pop();
        const line = `  ID=${u.rec.ID} ${u.slotField} #${u.rec.Design_Number} "${(u.rec.Company_Name || '').slice(0, 28)}": → /api/box/thumbnail/${newShort} (file: ${u.file.name})`;
        if (APPLY) {
            try {
                await updateMockupSlot(u.rec.ID, u.slotField, u.newUrl, u.folder.id);
                applied++;
                console.log(`  ✓ ${line.trimStart()}`);
            } catch (err) {
                failed++;
                console.log(`  ✗ ${line.trimStart()}`);
                console.log(`     ERROR: ${err.response?.status || ''} ${err.message}`);
            }
        } else {
            console.log(line);
        }
    }

    console.log('\n' + '='.repeat(72));
    if (APPLY) {
        console.log(`Done. Applied ${applied} updates, ${failed} failed.`);
    } else {
        console.log(`Dry-run complete. Pass --apply to write ${updates.length} updates to Caspio.`);
    }
    console.log('='.repeat(72));
}

main().catch(err => {
    console.error('\nFATAL:', err.response?.data || err.message);
    process.exit(1);
});
