#!/usr/bin/env node
/**
 * Backfill: Re-link broken Box_File_Mockup URLs on Steve's art requests
 *
 * Problem: ~23 ArtRequests records have Box_File_Mockup pointing at
 * `box.com/shared/static/{token}.jpg` URLs that Box now returns 404 for.
 * The shared links have expired or the underlying files moved/regenerated;
 * the actual files still exist in Steve's Box folder under different
 * fileIds/tokens. Steve's gallery shows red "Link broken" warnings.
 *
 * This script: for each broken record, search Steve's Box folder for a
 * sub-folder starting with the Design_Num_SW, pick the first image inside,
 * and update Box_File_Mockup to a fresh `/api/box/thumbnail/{fileId}` proxy
 * URL (the new format that doesn't go stale).
 *
 * Default mode is DRY-RUN. Pass --apply to actually write to Caspio.
 *
 * Usage:
 *   node scripts/backfill-steve-broken-mockups.js              # Dry-run
 *   node scripts/backfill-steve-broken-mockups.js --apply      # Write updates
 *   node scripts/backfill-steve-broken-mockups.js --verbose    # Per-record detail
 *
 * Env vars required:
 *   CASPIO_ACCOUNT_DOMAIN, CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET
 *   BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID, BOX_ART_FOLDER_ID
 */

require('dotenv').config();
const axios = require('axios');

// ─── CLI flags ────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

// ─── Config ───────────────────────────────────────────────────────────
const PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CASPIO_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN;
const CASPIO_API_BASE = `https://${CASPIO_DOMAIN}/integrations/rest/v3`;
const BOX_API_BASE = 'https://api.box.com/2.0';
const ART_REQUESTS_TABLE = 'ArtRequests';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
const STALE_URL_RE = /box\.com\/shared\/static/i;

// ─── Sanity ───────────────────────────────────────────────────────────
const required = {
    CASPIO_ACCOUNT_DOMAIN: process.env.CASPIO_ACCOUNT_DOMAIN,
    CASPIO_CLIENT_ID: process.env.CASPIO_CLIENT_ID,
    CASPIO_CLIENT_SECRET: process.env.CASPIO_CLIENT_SECRET,
    BOX_CLIENT_ID: process.env.BOX_CLIENT_ID,
    BOX_CLIENT_SECRET: process.env.BOX_CLIENT_SECRET,
    BOX_ENTERPRISE_ID: process.env.BOX_ENTERPRISE_ID,
    BOX_ART_FOLDER_ID: process.env.BOX_ART_FOLDER_ID
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

// ─── Step 1: Pull all candidate ArtRequests ──────────────────────────
// Pull every record with a non-null Box_File_Mockup, then HEAD-test each
// URL to find the actually-broken ones. This catches three failure modes:
//   (a) Stale `box.com/shared/static/{token}.jpg` shared links (Box 404)
//   (b) `/api/box/thumbnail/{fileId}` proxy URLs whose Box file was deleted
//   (c) Anything else that returns non-2xx
async function fetchAllRecordsWithMockup() {
    const token = await getCaspioToken();
    const select = 'PK_ID,ID_Design,Design_Num_SW,CompanyName,Status,Box_File_Mockup';
    const url = `${CASPIO_API_BASE}/tables/${ART_REQUESTS_TABLE}/records` +
        `?q.where=${encodeURIComponent("Box_File_Mockup IS NOT NULL")}` +
        `&q.select=${encodeURIComponent(select)}` +
        `&q.limit=1000`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 30000
    });
    return resp.data.Result || [];
}

// HEAD-test a Box_File_Mockup URL. Returns true if the URL is broken
// (404 / 5xx / non-image content type / network error).
async function isUrlBroken(rawUrl) {
    if (!rawUrl) return false;
    let testUrl = rawUrl;
    // Older shared/static URLs go through the proxy; HEAD that endpoint
    if (testUrl.indexOf('/api/box/') === -1 && /box\.com\/shared\/static/i.test(testUrl)) {
        testUrl = `${PROXY_BASE}/api/box/shared-image?url=${encodeURIComponent(rawUrl)}`;
    }
    try {
        const resp = await axios.head(testUrl, {
            timeout: 10000,
            validateStatus: () => true,
            maxRedirects: 3
        });
        if (resp.status >= 400) return true;
        const ct = resp.headers['content-type'] || '';
        // If proxy returns JSON instead of image, it's an error response
        if (ct.indexOf('application/json') !== -1) return true;
        return false;
    } catch (err) {
        return true;
    }
}

// ─── Step 2: Box folder search by design# ─────────────────────────────
const folderCache = new Map();

async function findArtFolderByDesign(designStr) {
    if (!designStr) return null;
    if (folderCache.has(designStr)) return folderCache.get(designStr);

    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: designStr,
                type: 'folder',
                ancestor_folder_ids: process.env.BOX_ART_FOLDER_ID,
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

async function findArtFolderByCompany(companyName) {
    if (!companyName || !companyName.trim()) return null;
    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: companyName.trim(),
                type: 'folder',
                ancestor_folder_ids: process.env.BOX_ART_FOLDER_ID,
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

// ─── Step 3: First image in folder ────────────────────────────────────
async function firstImageInFolder(folderId) {
    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/folders/${folderId}/items`, {
            params: { fields: 'id,type,name,modified_at', limit: 200 },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 30000
        });
        // Sort newest-first within images so the actual mockup floats above
        // any source PSDs / older revisions.
        const images = (resp.data.entries || [])
            .filter(e => e.type === 'file' && IMAGE_EXT_RE.test(e.name || ''))
            .sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
        return images[0] || null;
    } catch (err) {
        if (VERBOSE) console.log(`  Box folder list failed for ${folderId}: ${err.message}`);
        return null;
    }
}

// ─── Step 4: Update Caspio ────────────────────────────────────────────
async function updateBoxFileMockup(pkId, newUrl) {
    const token = await getCaspioToken();
    const endpoint = `${CASPIO_API_BASE}/tables/${ART_REQUESTS_TABLE}/records?q.where=PK_ID=${pkId}`;
    await axios.put(endpoint, { Box_File_Mockup: newUrl }, {
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
    console.log('Backfill: Re-link broken Box_File_Mockup URLs on Steve\'s queue');
    console.log('Mode:', APPLY ? 'APPLY (writing to Caspio)' : 'DRY-RUN (no writes)');
    console.log('='.repeat(72));

    console.log('\n[1/5] Fetching all ArtRequests with non-null Box_File_Mockup...');
    const allRecs = await fetchAllRecordsWithMockup();
    console.log(`  Pulled ${allRecs.length} records with a Box_File_Mockup value`);

    if (allRecs.length === 0) {
        console.log('\nNothing to do. Exiting.');
        return;
    }

    // Filter out cancelled records up front
    const active = allRecs.filter(r => {
        const status = normalizeStatus(r.Status).toLowerCase();
        if (status === 'cancelled' || status === 'cancel' || status === 'canceled') return false;
        return true;
    });
    const skippedCancelled = allRecs.length - active.length;
    if (skippedCancelled > 0) {
        console.log(`  Skipping ${skippedCancelled} cancelled records.`);
    }

    console.log(`\n[2/5] HEAD-testing each Box_File_Mockup URL (this may take a minute)...`);
    const broken = [];
    let healthy = 0;
    for (let i = 0; i < active.length; i++) {
        const rec = active[i];
        const isBroken = await isUrlBroken(rec.Box_File_Mockup);
        if (isBroken) {
            broken.push(rec);
            if (VERBOSE) console.log(`  [BROKEN] PK=${rec.PK_ID} #${rec.Design_Num_SW} ${rec.CompanyName}`);
        } else {
            healthy++;
        }
        if ((i + 1) % 20 === 0) process.stdout.write(`  Tested ${i + 1}/${active.length}...\n`);
    }
    console.log(`  Healthy URLs: ${healthy}`);
    console.log(`  Broken URLs:  ${broken.length}`);

    if (broken.length === 0) {
        console.log('\nNo broken URLs found. Nothing to backfill.');
        return;
    }

    const candidates = broken;
    console.log(`\n[3/5] Searching Box for matching folders + images...`);
    const updates = [];
    const noFolderMatch = [];
    const noImageInFolder = [];
    const noDesignNum = [];

    for (let i = 0; i < candidates.length; i++) {
        const rec = candidates[i];
        const designStr = String(rec.Design_Num_SW || '').trim();
        const company = rec.CompanyName || '';
        process.stdout.write(`  [${i + 1}/${candidates.length}] PK=${rec.PK_ID} #${designStr || '(none)'} ${company.slice(0, 30)}... `);

        if (!designStr) {
            console.log('SKIP (no Design_Num_SW)');
            noDesignNum.push(rec);
            continue;
        }

        let folder = await findArtFolderByDesign(designStr);
        if (!folder && company) folder = await findArtFolderByCompany(company);
        if (!folder) {
            console.log('NO FOLDER');
            noFolderMatch.push(rec);
            continue;
        }

        const file = await firstImageInFolder(folder.id);
        if (!file) {
            console.log(`NO IMAGE in folder "${folder.name}"`);
            noImageInFolder.push({ rec, folder });
            continue;
        }

        const newUrl = `${PROXY_BASE}/api/box/thumbnail/${file.id}`;
        if (newUrl === rec.Box_File_Mockup) {
            console.log('ALREADY OK (skipping)');
            continue;
        }
        updates.push({ rec, folder, file, newUrl });
        console.log(`MATCHED → ${file.name}`);
    }

    console.log(`\n[4/5] Match summary:`);
    console.log(`  ✓ Matched + would update:  ${updates.length}`);
    console.log(`  · No Box folder found:     ${noFolderMatch.length}`);
    console.log(`  · Folder found, no image:  ${noImageInFolder.length}`);
    console.log(`  · No Design_Num_SW:        ${noDesignNum.length}`);
    console.log(`  · Cancelled (filtered):    ${skippedCancelled}`);

    if (VERBOSE && noFolderMatch.length) {
        console.log('\n  Records with no Box folder match:');
        noFolderMatch.forEach(r => console.log(`    PK=${r.PK_ID} #${r.Design_Num_SW} ${r.CompanyName}`));
    }
    if (VERBOSE && noImageInFolder.length) {
        console.log('\n  Records with folder but no image:');
        noImageInFolder.forEach(({ rec, folder }) => console.log(`    PK=${rec.PK_ID} #${rec.Design_Num_SW} ${rec.CompanyName} → folder "${folder.name}" (id ${folder.id})`));
    }

    if (updates.length === 0) {
        console.log('\nNo updates to apply.');
        return;
    }

    console.log(`\n[5/5] ${APPLY ? 'Applying' : 'Would apply'} ${updates.length} updates:`);
    let applied = 0;
    let failed = 0;
    for (const u of updates) {
        const oldShort = (u.rec.Box_File_Mockup || '').split('/').pop().slice(0, 36);
        const newShort = u.newUrl.split('/').pop();
        const line = `  PK=${u.rec.PK_ID} #${u.rec.Design_Num_SW} "${u.rec.CompanyName.slice(0, 30)}": ${oldShort} → /api/box/thumbnail/${newShort} (file: ${u.file.name})`;
        if (APPLY) {
            try {
                await updateBoxFileMockup(u.rec.PK_ID, u.newUrl);
                applied++;
                console.log(`  ✓ ${line}`);
            } catch (err) {
                failed++;
                console.log(`  ✗ ${line}`);
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
