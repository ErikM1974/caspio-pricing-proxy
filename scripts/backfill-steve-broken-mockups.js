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
 *
 * Related: same recovery algorithm is exposed as an HTTP route at
 *   POST /api/art-requests/:pkId/auto-recover-mockup
 *   POST /api/art-requests/auto-recover-mockups-bulk
 * implemented via `src/utils/recover-broken-mockup.js`. Steve's dashboard
 * "Broken Links" modal calls those routes for on-demand recovery. This
 * script remains for batch validation runs (full sweep + reporting summary).
 * If the algorithm changes here, mirror the change in the util.
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

// ─── Step 1: Pull recent ArtRequests with non-null Box_File_Mockup ───
// Limited to dateCreated since 2026-03-15 (the gallery cutoff). Older
// records aren't visible in Steve's UI; backfilling them isn't useful.
async function fetchRecentRecordsWithMockup() {
    const token = await getCaspioToken();
    const select = 'PK_ID,ID_Design,Design_Num_SW,CompanyName,Status,Box_File_Mockup';
    const where = "Box_File_Mockup IS NOT NULL AND Date_Created >= '2026-03-15'";
    const url = `${CASPIO_API_BASE}/tables/${ART_REQUESTS_TABLE}/records` +
        `?q.where=${encodeURIComponent(where)}` +
        `&q.select=${encodeURIComponent(select)}` +
        `&q.limit=500`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 30000
    });
    return resp.data.Result || [];
}

// Extract Box fileId from a /api/box/thumbnail/{id} URL. Returns null for
// other URL shapes (shared/static, etc.).
function extractFileId(url) {
    if (!url) return null;
    const m = String(url).match(/\/api\/box\/thumbnail\/(\d+)/);
    return m ? m[1] : null;
}

// Verify a Box fileId actually exists. Returns true if Box has a file at
// that ID (active OR in trash), false if 404. Used to decide whether
// the current Box_File_Mockup is recoverable or a phantom URL.
async function fileIdExists(fileId) {
    if (!fileId) return false;
    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/files/${fileId}`, {
            params: { fields: 'id' },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000,
            validateStatus: () => true
        });
        if (resp.status === 200) return true;
        // Try trash
        const trashResp = await axios.get(`${BOX_API_BASE}/files/${fileId}/trash`, {
            params: { fields: 'id' },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000,
            validateStatus: () => true
        });
        return trashResp.status === 200;
    } catch (err) {
        return false;
    }
}

// Broad search Box by company name (recursive within BOX_ART_FOLDER_ID),
// pick best image candidate matching the design#. Used as Pass 2 for
// records whose primary folder turned up no image.
async function broadBoxSearch(companyName, designStr) {
    if (!companyName || !companyName.trim()) return null;
    const token = await getBoxToken();
    try {
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: companyName.trim(),
                type: 'file',
                ancestor_folder_ids: process.env.BOX_ART_FOLDER_ID,
                fields: 'id,name,modified_at,parent',
                limit: 50
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const entries = (resp.data.entries || [])
            .filter(e => e.type === 'file' && IMAGE_EXT_RE.test(e.name || ''));
        if (entries.length === 0) return null;
        // Strict: filename contains the design#
        const designMatched = entries.filter(f => (f.name || '').indexOf(designStr) !== -1);
        if (designMatched.length > 0) {
            designMatched.sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
            return { file: designMatched[0], reason: 'BROAD_SEARCH_DESIGN_MATCH' };
        }
        // Don't auto-pick non-design# matches — too risky to grab an unrelated
        // file just because it shares the company name. Return null + log
        // candidates upstream so staff can review.
        return { file: null, reason: 'BROAD_SEARCH_NO_DESIGN_MATCH', candidates: entries.slice(0, 3).map(f => f.name) };
    } catch (err) {
        return null;
    }
}

// Test a Box_File_Mockup URL. Returns true if the URL is broken
// (404 / 5xx / non-image content type / network error).
//
// Earlier version used axios.head — got false-negatives for proxy 404s
// (Heroku-internal HEAD response was lying). Switched to GET with arraybuffer
// + tiny range, validates BOTH status AND content-type to catch the proxy's
// JSON error responses.
async function isUrlBroken(rawUrl) {
    if (!rawUrl) return false;
    let testUrl = rawUrl;
    // Older shared/static URLs go through the proxy
    if (testUrl.indexOf('/api/box/') === -1 && /box\.com\/shared\/static/i.test(testUrl)) {
        testUrl = `${PROXY_BASE}/api/box/shared-image?url=${encodeURIComponent(rawUrl)}`;
    }
    try {
        const resp = await axios.get(testUrl, {
            timeout: 12000,
            validateStatus: () => true,
            maxRedirects: 3,
            responseType: 'arraybuffer',
            // Range header makes most servers return only first byte —
            // saves bandwidth, still confirms file existence
            headers: { 'Range': 'bytes=0-0' }
        });
        // 4xx/5xx → broken
        if (resp.status >= 400) return true;
        // Proxy error responses come back as application/json
        const ct = String(resp.headers['content-type'] || '').toLowerCase();
        if (ct.indexOf('application/json') !== -1) return true;
        // Empty response body when we expected an image → broken
        if (!resp.data || resp.data.byteLength === 0) return true;
        return false;
    } catch (err) {
        // Timeout / network error / DNS — treat as broken (we'll try to relink)
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

// ─── Step 3: Find the right mockup file for a design # ───────────────
// Confidence tiers:
//   HIGH:    filename contains the design# (e.g., "40282 Sticker.jpg")
//   MEDIUM:  folder name starts with `${designStr} ` (exact prefix +
//            separator) AND has images. Steve sometimes mistypes the design#
//            in filenames but the folder name is canonical. Real cases:
//            folder "40282 Sassy Cat" had file "40802 Sassy Cat..." — typo
//            in the filename, but folder confirms it's the right design.
//   SKIP:    no high or medium confidence match.
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

        // HIGH: design# appears in filename
        const designMatched = allImages.filter(f => (f.name || '').indexOf(designStr) !== -1);
        if (designMatched.length > 0) {
            return { file: designMatched[0], reason: 'DESIGN_NUMBER_MATCH', confidence: 'HIGH' };
        }

        // MEDIUM: folder name canonical leads with `${designStr} ` separator.
        // findArtFolderByDesign required folder.name.startsWith(designStr), but
        // accidental prefix collisions could match (e.g., "40280" vs "40288").
        // This stricter check requires a non-digit char immediately after the
        // design# to confirm exact match.
        const sep = (folderName || '').charAt(designStr.length);
        const folderExactPrefix = (folderName || '').startsWith(designStr) && (sep === '' || /[^\d]/.test(sep));
        if (folderExactPrefix) {
            return { file: allImages[0], reason: 'FOLDER_NAME_TRUST', confidence: 'MEDIUM' };
        }

        return { file: null, reason: 'NO_FILENAME_MATCH', candidates: allImages.slice(0, 3).map(f => f.name) };
    } catch (err) {
        if (VERBOSE) console.log(`  Box folder list failed for ${folderId}: ${err.message}`);
        return { file: null, reason: 'ERROR' };
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

    console.log('\n[1/4] Fetching recent ArtRequests (dateCreated >= 2026-03-15)...');
    const allRecs = await fetchRecentRecordsWithMockup();
    console.log(`  Pulled ${allRecs.length} records with a Box_File_Mockup value`);

    if (allRecs.length === 0) {
        console.log('\nNothing to do. Exiting.');
        return;
    }

    // Filter out cancelled records up front
    const candidates = allRecs.filter(r => {
        const status = normalizeStatus(r.Status).toLowerCase();
        if (status === 'cancelled' || status === 'cancel' || status === 'canceled') return false;
        return true;
    });
    const skippedCancelled = allRecs.length - candidates.length;
    if (skippedCancelled > 0) {
        console.log(`  Skipping ${skippedCancelled} cancelled records.`);
    }

    console.log(`\n[2/4] Searching Box for canonical fileId of each record...`);
    console.log('  Strategy: trust Box. Each record\'s Box_File_Mockup must point at');
    console.log('  the FIRST IMAGE in the design#-named folder. If Caspio\'s stored');
    console.log('  fileId differs from Box\'s actual file, update.\n');
    const updates = [];
    const noFolderMatch = [];
    const noImageInFolder = [];
    const noFilenameMatch = [];
    const noDesignNum = [];
    let alreadyOk = 0;

    for (let i = 0; i < candidates.length; i++) {
        const rec = candidates[i];
        const designStr = String(rec.Design_Num_SW || '').trim();
        const company = rec.CompanyName || '';
        const currentFileId = extractFileId(rec.Box_File_Mockup);
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

        const result = await findMockupFile(folder.id, folder.name, designStr);
        if (result.reason === 'NO_IMAGE') {
            console.log(`NO IMAGE in folder "${folder.name}"`);
            noImageInFolder.push({ rec, folder });
            continue;
        }
        if (result.reason === 'NO_FILENAME_MATCH') {
            console.log(`SKIP — folder "${folder.name}" has images but none contain "${designStr}" (candidates: ${(result.candidates || []).join(', ')})`);
            noFilenameMatch.push({ rec, folder, candidates: result.candidates });
            continue;
        }
        if (!result.file) {
            console.log(`SKIP (folder list error)`);
            continue;
        }

        const file = result.file;
        // Box says this is the file. If Caspio already points at the same
        // fileId, skip.
        if (currentFileId === file.id) {
            alreadyOk++;
            if (VERBOSE) console.log(`OK (already pointing at Box's current file ${file.id})`);
            else process.stdout.write('\r');
            continue;
        }

        const newUrl = `${PROXY_BASE}/api/box/thumbnail/${file.id}`;
        updates.push({ rec, folder, file, newUrl, confidence: result.confidence });
        const confTag = result.confidence === 'HIGH' ? '' : ` [${result.confidence} via ${result.reason}]`;
        console.log(`UPDATE: fileId ${currentFileId || '(non-proxy)'} → ${file.id} (${file.name})${confTag}`);
    }

    console.log(`\n[3/4] Match summary:`);
    console.log(`  ✓ Already matches Box:     ${alreadyOk}`);
    console.log(`  ✓ Will update fileId:      ${updates.length}`);
    console.log(`  · No Box folder found:     ${noFolderMatch.length}`);
    console.log(`  · Folder found, no image:  ${noImageInFolder.length}`);
    console.log(`  · No filename match:       ${noFilenameMatch.length}  (folder has images but none contain design#)`);
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

    console.log(`\n[4/4] ${APPLY ? 'Applying' : 'Would apply'} ${updates.length} updates:`);
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
