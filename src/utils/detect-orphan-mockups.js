// detect-orphan-mockups.js
//
// Shared detection logic for Box folders under "Ruth Digitizing Mockups" that
// don't have a matching Digitizing_Mockups row in Caspio. Used by:
//
//   1. scripts/backfill-mockups-from-box.js  — CLI that inserts the orphans
//   2. src/utils/send-orphan-digest.js       — monthly email to Erik if any appear
//
// Pure detection: returns a structured report. No writes, no emails. Callers
// decide what to do with the result.

const axios = require('axios');

const BOX_API_BASE = 'https://api.box.com/2.0';
const PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const MOCKUPS_TABLE = 'Digitizing_Mockups';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
// Real NWCA design numbers are 5 digits (optionally with decimal). 1-4 digits
// or 6+ digits with no decimal are test data.
const TEST_DESIGN_NUMBER_RE = /^(\d{1,4}|\d{6,})$/;

// ─── Box auth (self-contained, caches in closure) ─────────────────────
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
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });
    boxToken = resp.data.access_token;
    boxTokenExpiry = now + resp.data.expires_in;
    return boxToken;
}

async function boxGet(path, params) {
    const token = await getBoxToken();
    const resp = await axios.get(`${BOX_API_BASE}${path}`, {
        params,
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 30000
    });
    return resp.data;
}

// ─── Caspio auth (self-contained, uses same env vars as the app) ──────
let caspioToken = null;
let caspioTokenExpiry = 0;

async function getCaspioToken() {
    const now = Math.floor(Date.now() / 1000);
    if (caspioToken && now < caspioTokenExpiry - 60) return caspioToken;

    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const resp = await axios.post(`https://${domain}/oauth/token`, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.CASPIO_CLIENT_ID,
        client_secret: process.env.CASPIO_CLIENT_SECRET
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });
    caspioToken = resp.data.access_token;
    caspioTokenExpiry = now + resp.data.expires_in;
    return caspioToken;
}

// ─── Box + Caspio data loaders ────────────────────────────────────────
async function listAllMockupFolders() {
    const parentId = process.env.BOX_MOCKUP_FOLDER_ID;
    if (!parentId) throw new Error('BOX_MOCKUP_FOLDER_ID env var missing');

    const folders = [];
    let offset = 0;
    const pageSize = 200;
    while (true) {
        const data = await boxGet(`/folders/${parentId}/items`, {
            fields: 'id,type,name,created_at',
            limit: pageSize,
            offset
        });
        const entries = (data.entries || []).filter(e => e.type === 'folder');
        folders.push(...entries);
        if (entries.length < pageSize) break;
        offset += pageSize;
        if (offset > 5000) break; // safety
    }
    return folders;
}

async function firstImageInFolder(folderId) {
    try {
        const data = await boxGet(`/folders/${folderId}/items`, {
            fields: 'id,type,name',
            limit: 200
        });
        const file = (data.entries || []).find(e => e.type === 'file' && IMAGE_EXT_RE.test(e.name || ''));
        return file ? file.id : null;
    } catch (err) {
        return null;
    }
}

async function fetchAllCaspioMockups() {
    const domain = process.env.CASPIO_ACCOUNT_DOMAIN;
    const token = await getCaspioToken();
    const url = `https://${domain}/integrations/rest/v3/tables/${MOCKUPS_TABLE}/records`;

    let rows = [];
    let page = 1;
    const pageSize = 1000;
    while (true) {
        const resp = await axios.get(url, {
            params: { 'q.pageNumber': page, 'q.pageSize': pageSize },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 30000
        });
        const result = resp.data.Result || [];
        rows.push(...result);
        if (result.length < pageSize) break;
        page++;
        if (page > 20) break; // safety
    }
    return rows;
}

// ─── Parsing ──────────────────────────────────────────────────────────
function parseFolderName(name) {
    const clean = String(name || '').trim();
    const m = clean.match(/^(\d[\d.]*)\s+(.+)$/);
    if (m) return { designNumber: m[1], companyName: m[2].trim() };
    if (/^NEW\s+/i.test(clean)) {
        return { designNumber: '', companyName: clean.replace(/^NEW\s+/i, '').trim() };
    }
    return { designNumber: '', companyName: clean };
}

function dedupKey(designNumber, companyName) {
    return `${(designNumber || '').toLowerCase().trim()}|${(companyName || '').toLowerCase().trim()}`;
}

// ─── Main detection ───────────────────────────────────────────────────
/**
 * Scan Box + Caspio and categorize every Box folder.
 *
 * @param {Object} opts
 * @param {boolean} opts.applyQualityFilters  Drop test-data + empty folders
 *   from the orphans list. Default true.
 * @param {boolean} opts.inspectFolderContents  Call Box to pull first image +
 *   file count for each candidate. Default true. Set false to skip Box file
 *   listing (faster, no mockup1Url populated).
 *
 * @returns {Object} {
 *   boxTotal, caspioTotal, linkedCount, liveCount, softDeletedCount,
 *   dedupSkipped:   [{folder, designNumber, companyName}],
 *   testSkipped:    [{folder, designNumber, companyName}],
 *   emptySkipped:   [{folder, designNumber, companyName}],
 *   orphans:        [{folder, designNumber, companyName, imageFileId, mockup1Url}]
 * }
 */
async function detectOrphans(opts) {
    opts = opts || {};
    const applyQualityFilters = opts.applyQualityFilters !== false;
    const inspectFolderContents = opts.inspectFolderContents !== false;

    const [boxFolders, caspioRows] = await Promise.all([
        listAllMockupFolders(),
        fetchAllCaspioMockups()
    ]);

    const linkedFolderIds = new Set(
        caspioRows.map(r => String(r.Box_Folder_ID || '')).filter(Boolean)
    );
    const liveRows = caspioRows.filter(r => r.Is_Deleted !== true);
    const liveDedupKeys = new Set(
        liveRows.map(r => dedupKey(r.Design_Number, r.Company_Name))
    );

    const dedupSkipped = [];
    const testSkipped  = [];
    const emptySkipped = [];
    const orphans      = [];

    for (const folder of boxFolders) {
        if (linkedFolderIds.has(String(folder.id))) continue;

        const { designNumber, companyName } = parseFolderName(folder.name);

        if (liveDedupKeys.has(dedupKey(designNumber, companyName))) {
            dedupSkipped.push({ folder, designNumber, companyName });
            continue;
        }

        if (applyQualityFilters && designNumber && TEST_DESIGN_NUMBER_RE.test(designNumber)) {
            testSkipped.push({ folder, designNumber, companyName });
            continue;
        }

        let imageFileId = null;
        if (inspectFolderContents) {
            imageFileId = await firstImageInFolder(folder.id);
        }

        if (applyQualityFilters && inspectFolderContents && !imageFileId) {
            emptySkipped.push({ folder, designNumber, companyName });
            continue;
        }

        const mockup1Url = imageFileId ? `${PROXY_BASE}/api/box/thumbnail/${imageFileId}` : '';
        orphans.push({ folder, designNumber, companyName, imageFileId, mockup1Url });
    }

    return {
        boxTotal: boxFolders.length,
        caspioTotal: caspioRows.length,
        linkedCount: linkedFolderIds.size,
        liveCount: liveRows.length,
        softDeletedCount: caspioRows.length - liveRows.length,
        dedupSkipped,
        testSkipped,
        emptySkipped,
        orphans
    };
}

module.exports = { detectOrphans, parseFolderName, dedupKey };
