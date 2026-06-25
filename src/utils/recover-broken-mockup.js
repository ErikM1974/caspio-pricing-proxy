/**
 * recover-broken-mockup.js — shared recovery algorithm for broken Box_File_Mockup URLs.
 *
 * When a stored Box_File_Mockup URL on an ArtRequests record stops resolving
 * (Box file deleted out-of-band, shared-link token expired, etc.), this util:
 *   1. Searches Steve's Box folder for the design's sub-folder (Pass 1: by
 *      design#, Pass 2: by company name).
 *   2. Picks the best image candidate inside that folder (HIGH confidence
 *      = filename contains design#; MEDIUM = folder name canonical, take
 *      first image newest-first).
 *   3. Rewrites Caspio.ArtRequests.Box_File_Mockup with a fresh
 *      `/api/box/thumbnail/{fileId}` proxy URL.
 *
 * This is the same algorithm `scripts/backfill-steve-broken-mockups.js`
 * has used since 2026-04-26 — extracted here so the new
 * POST /api/art-requests/:pkId/auto-recover-mockup route can reuse it.
 *
 * **Dependency injection note:** the caller passes a `getBoxToken` async
 * function. Box auth lives in `src/routes/box-upload.js` and the backfill
 * script keeps its own; rather than hoist Box auth into a shared util (a
 * bigger refactor), we let callers wire their own. Caspio auth is shared
 * (`./caspio.getCaspioAccessToken`) and used directly.
 */

const axios = require('axios');
const config = require('../../config');
const { getCaspioAccessToken } = require('./caspio');

const BOX_API_BASE = 'https://api.box.com/2.0';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
const ART_REQUESTS_TABLE = 'ArtRequests';
const FALLBACK_PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

/**
 * Pass 1: search Box for a folder whose name starts with the design#.
 * Pass 2: search by company name; accept any folder whose name
 * case-insensitively contains the company.
 *
 * @returns {Promise<{id, name, type}|null>}
 */
async function findFolder({ designNumber, companyName, boxToken }) {
    const folderRoot = process.env.BOX_ART_FOLDER_ID;
    if (!folderRoot) throw new Error('BOX_ART_FOLDER_ID not configured');

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
 * Confidence tiers:
 *   HIGH   — filename contains the design# string. Steve's standard naming
 *            puts the design# at the start; this is the strongest signal.
 *   MEDIUM — folder name leads with `${designNumber}` followed by a non-digit
 *            separator (or end of string). Used when the folder is canonical
 *            but the filename was mistyped (real case 2026-04-26: folder
 *            "40282 Sassy Cat" had a file "40802 Sassy Cat..." — the folder
 *            name confirms the design despite the typo). First image newest-first.
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

// Slot fields the recovery util is allowed to write to. Keep this list aligned
// with `fields` in the broken-mockups handler (box-upload.js:1245). Anything
// outside this whitelist is rejected to prevent arbitrary field writes via
// a misconfigured slotField param.
const VALID_SLOT_FIELDS = ['Box_File_Mockup', 'BoxFileLink', 'Company_Mockup', 'Mockup_4', 'Mockup_5', 'Mockup_6', 'Additional_Art_1', 'Additional_Art_2'];

/**
 * Update a specific ArtRequests slot field for a given PK_ID. Generalized
 * from the original Box_File_Mockup-only writer so the recovery util can
 * heal any of the 5 mockup slots (the secondary slots — BoxFileLink,
 * Company_Mockup, Additional_Art_* — used to be invisible to recovery and
 * had to be re-uploaded by hand).
 *
 * @param {object} opts
 * @param {number|string} opts.pkId
 * @param {string} opts.slotField — must be in VALID_SLOT_FIELDS
 * @param {string} opts.newUrl
 */
async function updateMockupSlot({ pkId, slotField, newUrl }) {
    if (!VALID_SLOT_FIELDS.includes(slotField)) {
        throw new Error(`updateMockupSlot: invalid slotField "${slotField}". Must be one of: ${VALID_SLOT_FIELDS.join(', ')}`);
    }
    const token = await getCaspioAccessToken();
    const endpoint = `${config.caspio.apiBaseUrl}/tables/${ART_REQUESTS_TABLE}/records?q.where=PK_ID=${pkId}`;
    await axios.put(endpoint, { [slotField]: newUrl }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
}

/**
 * Back-compat wrapper for the old name. New callers should use updateMockupSlot.
 * @deprecated since 2026-05-06 — pass slotField explicitly to recoverBrokenMockup
 *             and call updateMockupSlot directly. Kept so existing imports don't break.
 */
async function updateBoxFileMockup({ pkId, newUrl }) {
    return updateMockupSlot({ pkId, slotField: 'Box_File_Mockup', newUrl });
}

/**
 * Try to recover a single broken Box_File_Mockup.
 *
 * @param {object} opts
 * @param {number|string} opts.pkId — Caspio PK_ID of the ArtRequest
 * @param {string} opts.designNumber — Design_Num_SW value
 * @param {string} [opts.companyName] — used as Pass-2 folder search fallback
 * @param {Function} opts.getBoxToken — async () => string (caller-supplied)
 * @param {string} [opts.publicUrl] — base for the new proxy URL
 *   (defaults to config.app.publicUrl, then the prod heroku URL)
 * @param {boolean} [opts.dryRun] — skip the Caspio write (still computes newUrl)
 *
 * @returns {Promise<{
 *   status: 'recovered' | 'no-folder' | 'empty-folder' | 'no-match' | 'error',
 *   newUrl?: string,
 *   newFileId?: string,
 *   newFileName?: string,
 *   confidence?: 'high' | 'medium',
 *   folder?: { id, name },
 *   candidates?: string[],
 *   error?: string
 * }>}
 */
async function recoverBrokenMockup(opts) {
    const { pkId, designNumber, companyName, getBoxToken, publicUrl, dryRun } = opts || {};
    // slotField is optional for back-compat — defaults to Box_File_Mockup so
    // older callers that don't know about secondary slots still work.
    const slotField = (opts && opts.slotField) || 'Box_File_Mockup';

    if (!pkId) return { status: 'error', error: 'missing pkId' };
    if (!designNumber) return { status: 'error', error: 'missing designNumber' };
    if (typeof getBoxToken !== 'function') {
        return { status: 'error', error: 'getBoxToken function required' };
    }
    if (!VALID_SLOT_FIELDS.includes(slotField)) {
        return {
            status: 'error',
            error: `invalid slotField "${slotField}". Must be one of: ${VALID_SLOT_FIELDS.join(', ')}`
        };
    }

    let result;
    try {
        const boxToken = await getBoxToken();

        const folder = await findFolder({
            designNumber: String(designNumber).trim(),
            companyName: companyName || '',
            boxToken
        });
        if (!folder) {
            result = { status: 'no-folder', slotField };
        } else {
            const pick = await pickImage({
                folder,
                designNumber: String(designNumber).trim(),
                boxToken
            });

            if (pick.reason === 'NO_IMAGE') {
                result = {
                    status: 'empty-folder',
                    slotField,
                    folder: { id: folder.id, name: folder.name }
                };
            } else if (!pick.file) {
                result = {
                    status: 'no-match',
                    slotField,
                    folder: { id: folder.id, name: folder.name },
                    candidates: pick.candidates || []
                };
            } else {
                const base = publicUrl
                    || (config.app && config.app.publicUrl)
                    || FALLBACK_PROXY_BASE;
                const newUrl = `${base.replace(/\/$/, '')}/api/box/thumbnail/${pick.file.id}`;

                if (!dryRun) {
                    await updateMockupSlot({ pkId, slotField, newUrl });
                }

                result = {
                    status: 'recovered',
                    slotField,
                    newUrl,
                    newFileId: pick.file.id,
                    newFileName: pick.file.name,
                    confidence: pick.confidence,
                    folder: { id: folder.id, name: folder.name },
                    dryRun: !!dryRun
                };
            }
        }
    } catch (err) {
        result = { status: 'error', slotField, error: err.message || String(err) };
    }

    // Fire-and-forget direct Slack ping when recovery failed. Skipped when
    // dryRun (we don't want backfill scripts to spam Steve), when the env
    // var is unset, or when the dedup window is still hot. See
    // src/utils/slack-broken-mockup-notify.js. Never throws.
    if (!dryRun && result && result.status !== 'recovered') {
        try {
            const { notifyBrokenMockup } = require('./slack-broken-mockup-notify');
            const base = publicUrl
                || (config.app && config.app.publicUrl)
                || FALLBACK_PROXY_BASE;
            const detailUrl = `${base.replace(/\/$/, '')}/art-request/${pkId}`;
            // Don't await — caller doesn't need to block on Zapier latency.
            notifyBrokenMockup({
                designNumber: String(designNumber),
                companyName: companyName || '',
                pkId,
                table: 'ArtRequests',
                slotField,
                detailUrl,
                reason: result.status,
                error: result.error || null
            }).catch(() => { /* notify already swallows errors, this is belt+suspenders */ });
        } catch (notifyLoadErr) {
            // If the notify module fails to load, don't break recovery.
            console.warn('[recover-broken-mockup] notify module load failed:', notifyLoadErr.message);
        }
    }

    return result;
}

module.exports = {
    recoverBrokenMockup,
    findFolder,
    pickImage,
    updateMockupSlot,
    updateBoxFileMockup,    // deprecated alias — kept for back-compat
    VALID_SLOT_FIELDS
};
