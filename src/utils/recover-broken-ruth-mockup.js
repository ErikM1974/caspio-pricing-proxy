/**
 * recover-broken-ruth-mockup.js — shared recovery algorithm for broken
 * Box mockup URLs on Ruth's `Digitizing_Mockups` table.
 *
 * Sister of `recover-broken-mockup.js` (Steve's `ArtRequests` recovery).
 * Same algorithm, but the table has SEVEN slot fields per row instead
 * of one, and the Box parent folder + Caspio key column differ:
 *
 *                          Steve              Ruth
 *   Caspio table           ArtRequests        Digitizing_Mockups
 *   Caspio PK column       PK_ID              ID
 *   Box parent folder env  BOX_ART_FOLDER_ID  BOX_MOCKUP_FOLDER_ID
 *   Mockup slot field(s)   Box_File_Mockup    Box_Mockup_1..6 + Box_Reference_File
 *   Design#  field         Design_Num_SW      Design_Number
 *   Company  field         CompanyName        Company_Name
 *
 * The algorithm:
 *   1. Pass 1: search Box for a folder whose name starts with the design#.
 *   2. Pass 2: same search by company name; accept any folder whose
 *      name case-insensitively contains the company.
 *   3. Inside the matched folder, pick the best image candidate for the
 *      target slot (HIGH = filename contains design#, MEDIUM = canonical
 *      folder name, take first image newest-first).
 *   4. Rewrite the broken slot's URL on the Caspio row with a fresh
 *      `/api/box/thumbnail/{fileId}` proxy URL.
 *
 * **Dependency injection:** caller passes a `getBoxToken` async function.
 * Box auth lives in `src/routes/box-upload.js`; Caspio auth uses the
 * shared `getCaspioAccessToken`.
 */

const axios = require('axios');
const config = require('../../config');
const { getCaspioAccessToken } = require('./caspio');

const BOX_API_BASE = 'https://api.box.com/2.0';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
const MOCKUPS_TABLE = 'Digitizing_Mockups';
const FALLBACK_PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Mockup slot fields, in display order. Mirrors VALID_SLOTS in
// box-upload.js's `/api/mockups/:id/upload-file` endpoint.
const MOCKUP_SLOT_FIELDS = [
    'Box_Mockup_1', 'Box_Mockup_2', 'Box_Mockup_3',
    'Box_Mockup_4', 'Box_Mockup_5', 'Box_Mockup_6',
    'Box_Reference_File'
];

/**
 * Pass 1: search Box for a folder whose name starts with the design#.
 * Pass 2: search by company name; accept any folder whose name
 * case-insensitively contains the company.
 *
 * @returns {Promise<{id, name, type}|null>}
 */
async function findFolder({ designNumber, companyName, boxToken }) {
    const folderRoot = process.env.BOX_MOCKUP_FOLDER_ID;
    if (!folderRoot) throw new Error('BOX_MOCKUP_FOLDER_ID not configured');

    if (designNumber) {
        try {
            const resp = await axios.get(`${BOX_API_BASE}/search`, {
                params: {
                    query: designNumber,
                    type: 'folder',
                    ancestor_folder_ids: folderRoot,
                    fields: 'id,name,type',
                    limit: 10
                },
                headers: { 'Authorization': `Bearer ${boxToken}` },
                timeout: 15000
            });
            const entries = resp.data.entries || [];
            for (const entry of entries) {
                if (entry.type === 'folder' && entry.name.startsWith(designNumber)) {
                    return entry;
                }
            }
        } catch (err) { /* fall through to Pass 2 */ }
    }

    if (companyName && companyName.trim()) {
        try {
            const resp = await axios.get(`${BOX_API_BASE}/search`, {
                params: {
                    query: companyName.trim(),
                    type: 'folder',
                    ancestor_folder_ids: folderRoot,
                    fields: 'id,name,type',
                    limit: 10
                },
                headers: { 'Authorization': `Bearer ${boxToken}` },
                timeout: 15000
            });
            const entries = resp.data.entries || [];
            const lc = companyName.trim().toLowerCase();
            for (const entry of entries) {
                if (entry.type === 'folder' && entry.name.toLowerCase().includes(lc)) {
                    return entry;
                }
            }
        } catch (err) { /* fall through */ }
    }

    return null;
}

/**
 * Inside a folder, pick the best image for the design#.
 *
 * Confidence tiers (same as Steve's util):
 *   HIGH   — filename contains the design# string.
 *   MEDIUM — folder name leads with `${designNumber}` followed by a
 *            non-digit separator. First image newest-first.
 *   SKIP   — neither matches. Returns candidates so callers can surface them.
 *
 * @returns {Promise<{file, reason, confidence?, candidates?}>}
 */
async function pickImage({ folder, designNumber, boxToken }) {
    try {
        const resp = await axios.get(`${BOX_API_BASE}/folders/${folder.id}/items`, {
            params: { fields: 'id,type,name,modified_at', limit: 200 },
            headers: { 'Authorization': `Bearer ${boxToken}` },
            timeout: 30000
        });
        const allImages = (resp.data.entries || [])
            .filter(e => e.type === 'file' && IMAGE_EXT_RE.test(e.name || ''))
            .sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));

        if (allImages.length === 0) return { file: null, reason: 'NO_IMAGE' };

        // HIGH: design# in filename
        const designMatched = allImages.filter(f => (f.name || '').indexOf(designNumber) !== -1);
        if (designMatched.length > 0) {
            return { file: designMatched[0], reason: 'DESIGN_NUMBER_MATCH', confidence: 'high' };
        }

        // MEDIUM: folder name canonical (exact prefix + non-digit separator)
        const sep = (folder.name || '').charAt(designNumber.length);
        const folderExactPrefix = (folder.name || '').startsWith(designNumber)
            && (sep === '' || /[^\d]/.test(sep));
        if (folderExactPrefix) {
            return { file: allImages[0], reason: 'FOLDER_NAME_TRUST', confidence: 'medium' };
        }

        return {
            file: null,
            reason: 'NO_FILENAME_MATCH',
            candidates: allImages.slice(0, 3).map(f => f.name)
        };
    } catch (err) {
        return { file: null, reason: 'ERROR', error: err.message };
    }
}

/**
 * Update Digitizing_Mockups for a given record ID and slot field.
 * Direct PUT — no whitelist enforcement on these slot fields.
 */
async function updateMockupSlot({ id, slotField, newUrl, boxFolderId }) {
    if (!MOCKUP_SLOT_FIELDS.includes(slotField)) {
        throw new Error(`Invalid slot field: ${slotField}`);
    }
    const token = await getCaspioAccessToken();
    const endpoint = `${config.caspio.apiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
    const payload = { [slotField]: newUrl };
    // Stamp Box_Folder_ID on the row if we just discovered it (helps the
    // orphan-detection scan correlate Caspio rows ↔ Box folders).
    if (boxFolderId) payload.Box_Folder_ID = boxFolderId;
    await axios.put(endpoint, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
}

/**
 * Try to recover a single broken mockup slot.
 *
 * @param {object} opts
 * @param {number|string} opts.id — Caspio ID of the Digitizing_Mockups row
 * @param {string} opts.slotField — one of MOCKUP_SLOT_FIELDS
 * @param {string} opts.designNumber — Design_Number value
 * @param {string} [opts.companyName] — Pass-2 folder search fallback
 * @param {Function} opts.getBoxToken — async () => string (caller-supplied)
 * @param {string} [opts.publicUrl] — base for the new proxy URL
 * @param {boolean} [opts.dryRun] — skip the Caspio write
 *
 * @returns {Promise<{
 *   status: 'recovered' | 'no-folder' | 'empty-folder' | 'no-match' | 'error',
 *   slotField: string,
 *   newUrl?: string,
 *   newFileId?: string,
 *   newFileName?: string,
 *   confidence?: 'high' | 'medium',
 *   folder?: { id, name },
 *   candidates?: string[],
 *   error?: string
 * }>}
 */
async function recoverBrokenRuthMockup(opts) {
    const { id, slotField, designNumber, companyName, getBoxToken, publicUrl, dryRun } = opts || {};

    if (!id) return { status: 'error', slotField, error: 'missing id' };
    if (!slotField || !MOCKUP_SLOT_FIELDS.includes(slotField)) {
        return { status: 'error', slotField, error: `invalid slotField (${slotField})` };
    }
    if (!designNumber) return { status: 'error', slotField, error: 'missing designNumber' };
    if (typeof getBoxToken !== 'function') {
        return { status: 'error', slotField, error: 'getBoxToken function required' };
    }

    try {
        const boxToken = await getBoxToken();

        const folder = await findFolder({
            designNumber: String(designNumber).trim(),
            companyName: companyName || '',
            boxToken
        });
        if (!folder) {
            return { status: 'no-folder', slotField };
        }

        const pick = await pickImage({
            folder,
            designNumber: String(designNumber).trim(),
            boxToken
        });

        if (pick.reason === 'NO_IMAGE') {
            return {
                status: 'empty-folder',
                slotField,
                folder: { id: folder.id, name: folder.name }
            };
        }
        if (!pick.file) {
            return {
                status: 'no-match',
                slotField,
                folder: { id: folder.id, name: folder.name },
                candidates: pick.candidates || []
            };
        }

        const base = publicUrl
            || (config.app && config.app.publicUrl)
            || FALLBACK_PROXY_BASE;
        const newUrl = `${base.replace(/\/$/, '')}/api/box/thumbnail/${pick.file.id}`;

        if (!dryRun) {
            await updateMockupSlot({ id, slotField, newUrl, boxFolderId: folder.id });
        }

        return {
            status: 'recovered',
            slotField,
            newUrl,
            newFileId: pick.file.id,
            newFileName: pick.file.name,
            confidence: pick.confidence,
            folder: { id: folder.id, name: folder.name },
            dryRun: !!dryRun
        };
    } catch (err) {
        return { status: 'error', slotField, error: err.message || String(err) };
    }
}

module.exports = {
    recoverBrokenRuthMockup,
    findFolder,
    pickImage,
    updateMockupSlot,
    MOCKUP_SLOT_FIELDS
};
