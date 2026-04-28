// Transfer Orders Routes — CRUD for Transfer_Orders + Transfer_Order_Notes tables
// Tracks heat-transfer orders sent to Supacolor (closes the Steve → Bradley handoff gap)
//
// Mirrors pattern from mockup-routes.js.
// Record identifier is ID_Transfer (unique Text, server-generated as ST-YYMMDD-####).
//
// Endpoints:
//   GET    /api/transfer-orders            — List (with filters + pagination)
//                                          | ?includeLineCount=true → attaches line_count + file_count + mockup_thumbnail_url
//   GET    /api/transfer-orders/stats      — Count per status (for dashboard chips)
//   GET    /api/transfer-orders/:id        — Get one (by ID_Transfer) + child notes + lines + files
//   POST   /api/transfer-orders            — Create (generates ID_Transfer, writes initial note)
//                                          | accepts lines:[] + files:[] arrays at root
//   PUT    /api/transfer-orders/:id        — Update general fields (rejects Status)
//   PUT    /api/transfer-orders/:id/status — Status transition (writes note + stamps)
//   PUT    /api/transfer-orders/:id/rush   — Toggle rush flag (writes note)
//   PUT    /api/transfer-orders/:id/lines  — Replace all child lines (full replace)
//   PUT    /api/transfer-orders/:id/files  — Replace all child files (full replace)
//   DELETE /api/transfer-orders/:id        — Soft delete (sets Status='Cancelled')
//                                            | ?hard=true + Status ∈ (Requested, On_Hold) → physically removes row + cascades notes/lines/files
//   GET    /api/transfer-orders/:id/notes  — Get notes for a transfer
//   POST   /api/transfer-order-notes       — Add a comment/note
//   POST   /api/transfer-orders/analyze-link — Crack a Box URL → filename parse +
//                                              image metadata (used by the paste-
//                                              links v3 modal). Must be declared
//                                              BEFORE /:id routes or Express
//                                              matches "analyze-link" as an ID.

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const {
    boxGetFileInfo,
    boxFetchFileBytes,
    boxResolveSharedLink,
    parseBoxFileUrl
} = require('../utils/box-client');
const { extractImageMetadata } = require('../utils/image-metadata');
const { parseFilename } = require('../utils/filename-parser');
const { resolveSalesRep } = require('../utils/resolve-sales-rep');
// Vision helper is attached to the router export (see bottom of vision.js)
const visionRouter = require('./vision');
const extractMockupInfo = visionRouter.extractMockupInfo;
const mediaTypeFromExtension = visionRouter.mediaTypeFromExtension;
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE = 'Transfer_Orders';
const NOTES_TABLE = 'Transfer_Order_Notes';
const LINES_TABLE = 'Transfer_Order_Lines';
const FILES_TABLE = 'Transfer_Order_Files';

// Fields that are valid on a Transfer_Order_Lines row (strip unknown keys defensively)
const LINE_FIELDS = [
    'Transfer_ID', 'Line_Order', 'Quantity', 'Transfer_Size',
    'Press_Count', 'Transfer_Width_In', 'Transfer_Height_In', 'File_Notes'
];

// Fields that are valid on a Transfer_Order_Files row.
// Multi-file flow (v2026.04.28): Steve sends N working files + 1 mockup as
// child rows instead of the legacy 3 flat columns on Transfer_Orders.
const FILE_FIELDS = [
    'Transfer_ID', 'File_Order', 'File_Type', 'File_URL', 'File_Name',
    'File_MIME', 'Box_File_ID', 'Thumbnail_URL',
    'Width_Px', 'Height_Px', 'Width_In', 'Height_In', 'File_Notes'
];
const VALID_FILE_TYPES = ['working', 'mockup', 'reference'];

// Valid Status values (state machine)
// Happy path: Requested → Ordered → PO_Created → Shipped → Received
// Side paths: any non-terminal → Cancelled (terminal) or On_Hold (returns to prior state)
const VALID_STATUSES = ['Requested', 'Ordered', 'PO_Created', 'Shipped', 'Received', 'Cancelled', 'On_Hold'];
const TERMINAL_STATUSES = ['Received', 'Cancelled'];

// Fields that must NEVER be written via REST:
//  - PK_ID: Caspio internal (not exposed in this table but strip defensively)
//  - ID_Transfer: server-generated on create, immutable thereafter
//  - Requested_At: Caspio Timestamp type — auto-populates on insert, rejects writes
const READ_ONLY_FIELDS = ['PK_ID', 'ID_Transfer', 'Requested_At'];

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Generate a new ID_Transfer in format ST-YYMMDD-####.
 * Queries existing IDs for today and increments the sequence.
 */
async function generateTransferId(token) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const prefix = `ST-${yy}${mm}${dd}-`;

    // Build URL manually — axios's params: auto-encoding mangles the % in LIKE patterns
    // Use q.limit=1 (not q.pageSize) — Caspio v3 rejects q.pageSize < 5
    const whereClause = `ID_Transfer LIKE '${prefix}%'`;
    const url = `${caspioApiBaseUrl}/tables/${TABLE}/records` +
        `?q.where=${encodeURIComponent(whereClause)}` +
        `&q.orderBy=${encodeURIComponent('ID_Transfer DESC')}` +
        `&q.limit=1`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });

    const records = resp.data.Result || [];
    let nextSeq = 1;
    if (records.length > 0) {
        const lastId = records[0].ID_Transfer || '';
        const match = lastId.match(/-(\d{4})$/);
        if (match) nextSeq = parseInt(match[1], 10) + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

/**
 * Escape single quotes for Caspio q.where clauses.
 */
function escapeSQL(val) {
    return String(val).replace(/'/g, "''");
}

/**
 * Write a note to Transfer_Order_Notes.
 */
async function writeNote(token, { Transfer_ID, Note_Type, Note_Text, Author_Email, Author_Name }) {
    const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`;
    const data = {
        Transfer_ID,
        Note_Type: Note_Type || 'comment',
        Note_Text: Note_Text || '',
        Author_Email: Author_Email || 'system',
        Author_Name: Author_Name || 'System'
        // Created_At is a Caspio Timestamp — auto-populates on insert
    };
    await axios.post(url, data, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });
}

/**
 * Fetch a single Transfer_Orders record by ID_Transfer.
 */
async function fetchTransfer(token, idTransfer) {
    const safeId = escapeSQL(idTransfer);
    const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    const records = resp.data.Result || [];
    return records[0] || null;
}

/**
 * Normalize and insert one or more Transfer_Order_Lines rows for a parent.
 * Returns the count of rows successfully inserted. Throws on the first failure
 * so callers can trigger compensating cleanup (Caspio has no transactions).
 */
async function insertLines(token, idTransfer, lines) {
    if (!Array.isArray(lines) || lines.length === 0) return 0;
    const url = `${caspioApiBaseUrl}/tables/${LINES_TABLE}/records`;
    let inserted = 0;
    for (let i = 0; i < lines.length; i++) {
        const src = lines[i] || {};
        const row = { Transfer_ID: idTransfer, Line_Order: i + 1 };
        LINE_FIELDS.forEach(f => {
            if (f === 'Transfer_ID' || f === 'Line_Order') return;
            if (src[f] === undefined || src[f] === null || src[f] === '') return;
            if (f === 'Quantity' || f === 'Press_Count') {
                const n = parseInt(src[f], 10);
                if (!Number.isNaN(n)) row[f] = n;
            } else if (f === 'Transfer_Width_In' || f === 'Transfer_Height_In') {
                const n = parseFloat(src[f]);
                if (!Number.isNaN(n)) row[f] = n;
            } else {
                row[f] = src[f];
            }
        });
        await axios.post(url, row, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        inserted++;
    }
    return inserted;
}

/**
 * Fetch all child lines for a transfer, ordered by Line_Order ASC.
 */
async function fetchLines(token, idTransfer) {
    const safeId = escapeSQL(idTransfer);
    const url = `${caspioApiBaseUrl}/tables/${LINES_TABLE}/records?q.where=Transfer_ID='${safeId}'&q.orderBy=Line_Order ASC`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    return resp.data.Result || [];
}

/**
 * Delete all child lines for a transfer. Used by replace-lines PUT and hard-delete cascade.
 */
async function deleteLines(token, idTransfer) {
    const safeId = escapeSQL(idTransfer);
    const url = `${caspioApiBaseUrl}/tables/${LINES_TABLE}/records?q.where=Transfer_ID='${safeId}'`;
    await axios.delete(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
}

/**
 * Normalize and insert one or more Transfer_Order_Files rows for a parent.
 * Returns the count of rows successfully inserted. Throws on first failure.
 *
 * Multi-file flow: Steve sends N working files + 1 mockup as separate rows.
 * Single-mockup constraint is enforced at the route level (see POST handler).
 */
async function insertFiles(token, idTransfer, files) {
    if (!Array.isArray(files) || files.length === 0) return 0;
    const url = `${caspioApiBaseUrl}/tables/${FILES_TABLE}/records`;
    let inserted = 0;
    for (let i = 0; i < files.length; i++) {
        const src = files[i] || {};
        const row = { Transfer_ID: idTransfer, File_Order: i + 1 };
        FILE_FIELDS.forEach(f => {
            if (f === 'Transfer_ID' || f === 'File_Order') return;
            if (src[f] === undefined || src[f] === null || src[f] === '') return;
            if (f === 'Width_Px' || f === 'Height_Px') {
                const n = parseInt(src[f], 10);
                if (!Number.isNaN(n)) row[f] = n;
            } else if (f === 'Width_In' || f === 'Height_In') {
                const n = parseFloat(src[f]);
                if (!Number.isNaN(n)) row[f] = n;
            } else {
                row[f] = src[f];
            }
        });
        // Default File_Type if missing — most rows are working files.
        if (!row.File_Type) row.File_Type = 'working';
        if (!VALID_FILE_TYPES.includes(row.File_Type)) {
            throw new Error(`Invalid File_Type '${row.File_Type}' on file ${i + 1}. Must be one of: ${VALID_FILE_TYPES.join(', ')}`);
        }
        await axios.post(url, row, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        inserted++;
    }
    return inserted;
}

/**
 * Fetch all child files for a transfer, ordered by File_Order ASC.
 * Tolerates the FILES_TABLE not existing yet (returns []) so the route
 * still works during the rollout window before Erik creates the table.
 */
async function fetchFiles(token, idTransfer) {
    const safeId = escapeSQL(idTransfer);
    const url = `${caspioApiBaseUrl}/tables/${FILES_TABLE}/records?q.where=Transfer_ID='${safeId}'&q.orderBy=File_Order ASC`;
    try {
        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        return resp.data.Result || [];
    } catch (err) {
        // 404 or 400 → table likely doesn't exist yet. Log once, return empty
        // so the synthesis fallback can take over from legacy flat columns.
        const status = err.response && err.response.status;
        if (status === 404 || status === 400) {
            console.warn(`[transfer-files] ${FILES_TABLE} unavailable (HTTP ${status}) — falling back to legacy columns`);
            return [];
        }
        throw err;
    }
}

/**
 * Delete all child files for a transfer. Used by replace PUT and hard-delete cascade.
 */
async function deleteFiles(token, idTransfer) {
    const safeId = escapeSQL(idTransfer);
    const url = `${caspioApiBaseUrl}/tables/${FILES_TABLE}/records?q.where=Transfer_ID='${safeId}'`;
    try {
        await axios.delete(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
    } catch (err) {
        const status = err.response && err.response.status;
        if (status === 404 || status === 400) {
            // Table doesn't exist or no rows — both fine for delete.
            return;
        }
        throw err;
    }
}

/**
 * Synthesize a files[] array from the legacy flat columns on a Transfer_Orders
 * record. Used when the row was created before Transfer_Order_Files existed
 * (no child rows). Mirrors the auto-line-wrap fallback for legacy single-line transfers.
 */
function synthesizeFilesFromLegacy(record) {
    if (!record) return [];
    const synthesized = [];
    let order = 1;
    if (record.Working_File_URL) {
        synthesized.push({
            File_Order: order++,
            File_Type: 'working',
            File_URL: record.Working_File_URL,
            File_Name: record.Working_File_Name || null,
            File_MIME: record.Working_File_Type || null,
            Box_File_ID: record.Box_File_ID || null,
            Thumbnail_URL: null,
            _synthesized: true
        });
    }
    if (record.Additional_File_1_URL) {
        synthesized.push({
            File_Order: order++,
            // Legacy slot 1 was reserved for the mockup per the original v3 design.
            File_Type: 'mockup',
            File_URL: record.Additional_File_1_URL,
            File_Name: record.Additional_File_1_Name || null,
            File_MIME: null,
            Box_File_ID: null,
            Thumbnail_URL: null,
            _synthesized: true
        });
    }
    if (record.Additional_File_2_URL) {
        synthesized.push({
            File_Order: order++,
            File_Type: 'reference',
            File_URL: record.Additional_File_2_URL,
            File_Name: record.Additional_File_2_Name || null,
            File_MIME: null,
            Box_File_ID: null,
            Thumbnail_URL: null,
            _synthesized: true
        });
    }
    return synthesized;
}

// ── Analyze Link (paste-links v3 modal) ───────────────────────────────

// Small LRU-style cache keyed on Box fileId → last analysis. 1-hour TTL.
// Prevents duplicate Box fetches + image parsing when Steve re-pastes or
// re-opens a modal. Entries expire on access when past TTL.
const ANALYZE_CACHE = new Map();
const ANALYZE_CACHE_TTL_MS = 60 * 60 * 1000;
const ANALYZE_CACHE_MAX = 200;

function analyzeCacheGet(fileId) {
    const entry = ANALYZE_CACHE.get(fileId);
    if (!entry) return null;
    if (Date.now() - entry.t > ANALYZE_CACHE_TTL_MS) {
        ANALYZE_CACHE.delete(fileId);
        return null;
    }
    return entry.v;
}

function analyzeCacheSet(fileId, value) {
    if (ANALYZE_CACHE.size >= ANALYZE_CACHE_MAX) {
        // Drop the oldest entry (first insertion order)
        const firstKey = ANALYZE_CACHE.keys().next().value;
        if (firstKey) ANALYZE_CACHE.delete(firstKey);
    }
    ANALYZE_CACHE.set(fileId, { v: value, t: Date.now() });
}

/**
 * POST /api/transfer-orders/analyze-link
 *
 * Takes a pasted Box URL and returns everything we can extract automatically:
 *   - Box metadata (name, size, MIME)
 *   - Image metadata (pixel W/H, DPI, physical inches)
 *   - Filename parse (design#, customer, placement, filename-claimed dims, type)
 *
 * Vision extraction on mockups is a separate endpoint (Phase 2) — the frontend
 * will call /api/vision/extract-mockup-info after this route returns when
 * `filenameParsed.type === 'mockup'`.
 *
 * Body: { url: "https://...box.com/file/12345" | "https://...box.com/s/abc" }
 *
 * Response shape (on success):
 *   {
 *     success: true,
 *     fileId, fileName, sizeBytes, mimeType,
 *     pixelWidth, pixelHeight, dpiX, dpiY, physicalWidthIn, physicalHeightIn,
 *     filenameParsed: {...} | null,
 *     dimensionMismatch: { claimed: "13.5x4.1", actual: "13.5x4.09" } | null
 *   }
 *
 * Error responses preserve HTTP semantics (400 invalid URL, 403 not a Box URL,
 * 404 file not accessible, 502 Box upstream failure, 500 internal).
 */
router.post('/transfer-orders/analyze-link', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'Missing url in body' });
    }

    const parsed = parseBoxFileUrl(url);
    if (!parsed) {
        return res.status(400).json({
            success: false,
            error: 'Not a recognized Box URL. Paste a /file/<id> or /s/<token> link.'
        });
    }
    if (parsed.kind === 'folder') {
        return res.status(400).json({
            success: false,
            error: 'Folder URLs are not supported — paste individual file links.'
        });
    }

    try {
        // Resolve to fileId + sharedLink (if the latter is needed for access)
        let fileId = parsed.fileId;
        let sharedLink = null;

        if (parsed.kind === 'shared' || parsed.kind === 'static') {
            sharedLink = parsed.sharedUrl || url;
            if (!fileId) {
                const resolved = await boxResolveSharedLink(sharedLink);
                if (!resolved || resolved.type !== 'file') {
                    return res.status(400).json({
                        success: false,
                        error: 'Shared link does not resolve to a file.'
                    });
                }
                fileId = String(resolved.id);
            }
        }

        if (!fileId) {
            return res.status(400).json({ success: false, error: 'Could not resolve fileId' });
        }

        // Cache check
        const cached = analyzeCacheGet(fileId);
        if (cached) {
            return res.json({ ...cached, cached: true });
        }

        // Metadata + bytes in parallel (both cheap on Box).
        // 128KB Range covers PNG/JPEG/PDF metadata reliably. PNG pHYs + IHDR
        // live in first few KB, but JPEG SOF markers can sit past EXIF/APP
        // blobs (~30-60KB in practice); 16KB was too small for mockup JPGs.
        const [info, bytes] = await Promise.all([
            boxGetFileInfo(fileId, ['name', 'size', 'extension', 'type'], sharedLink),
            boxFetchFileBytes(fileId, { rangeBytes: 131072, sharedLink })
        ]);

        const fileName = info.name || '';
        const sizeBytes = info.size || null;

        const imageMeta = extractImageMetadata(bytes);
        const filenameParsed = parseFilename(fileName);

        // Cross-check filename-claimed dims vs actual image dims (if both present)
        let dimensionMismatch = null;
        if (filenameParsed && filenameParsed.ok && filenameParsed.type === 'transfer'
            && imageMeta.physicalWidthIn && imageMeta.physicalHeightIn) {
            const claimedW = filenameParsed.filenameWidth;
            const claimedH = filenameParsed.filenameHeight;
            const actualW = imageMeta.physicalWidthIn;
            const actualH = imageMeta.physicalHeightIn;
            const diffW = Math.abs(claimedW - actualW);
            const diffH = Math.abs(claimedH - actualH);
            // Mismatch if >0.25" in either direction (absorbs 300-dpi rounding)
            if (diffW > 0.25 || diffH > 0.25) {
                dimensionMismatch = {
                    claimed: `${claimedW}x${claimedH}`,
                    actual: `${actualW}x${actualH}`,
                    diffW, diffH
                };
            }
        }

        const result = {
            success: true,
            fileId,
            fileName,
            sharedLink: sharedLink || null,
            sizeBytes,
            mimeType: imageMeta.fileType || (info.extension || '').toUpperCase() || null,
            pixelWidth: imageMeta.pixelWidth || null,
            pixelHeight: imageMeta.pixelHeight || null,
            dpiX: imageMeta.dpiX || null,
            dpiY: imageMeta.dpiY || null,
            physicalWidthIn: imageMeta.physicalWidthIn || null,
            physicalHeightIn: imageMeta.physicalHeightIn || null,
            metadataConfidence: imageMeta.confidence,
            metadataError: imageMeta.error || null,
            filenameParsed: filenameParsed.ok ? filenameParsed : null,
            filenameError: filenameParsed.ok ? null : filenameParsed.reason,
            dimensionMismatch,
            mockupVision: null,
            mockupVisionError: null,
            salesRepMatch: null,
            cached: false
        };

        // Mockup files: run vision extraction in the same response so the
        // frontend only makes ONE /analyze-link call per file. If vision fails,
        // we still return the filename+metadata result with mockupVisionError set
        // (per the "allow Send with warning" decision).
        if (filenameParsed.ok && filenameParsed.type === 'mockup' && extractMockupInfo) {
            try {
                // Need the FULL file for vision, not just 16KB. Fetch again.
                const fullBytes = await boxFetchFileBytes(fileId, { sharedLink });
                const mediaType = mediaTypeFromExtension(info.extension);
                const vision = await extractMockupInfo(fullBytes, mediaType, `file:${fileId}`);
                result.mockupVision = {
                    designNumber: vision.design_number,
                    orderNumber: vision.order_number,
                    salesRep: vision.sales_rep,
                    customerName: vision.customer_name,
                    garmentColorStyle: vision.garment_color_style,
                    sizePlacement: vision.size_placement,
                    transferType: vision.transfer_type,
                    date: vision.date,
                    time: vision.time,
                    customerApproved: vision.customer_approved,
                    filesPrepaired: vision.files_prepaired
                };
                // Resolve sales rep to CRM email (if we recognize the first name)
                if (vision.sales_rep) {
                    result.salesRepMatch = resolveSalesRep(vision.sales_rep);
                }
            } catch (vErr) {
                console.warn('[analyze-link] mockup vision failed (non-fatal):', vErr.message);
                result.mockupVisionError = vErr.message || 'vision failed';
            }
        }

        analyzeCacheSet(fileId, result);
        res.json(result);

    } catch (err) {
        console.error('[analyze-link] error:', err.response ? JSON.stringify(err.response.data) : err.message);
        const status = (err.response && err.response.status) || 500;
        // Normalize common Box errors
        if (status === 404) {
            return res.status(404).json({
                success: false,
                error: 'File not accessible from this Box account (may be in a folder the service user can\'t read).'
            });
        }
        return res.status(status >= 400 && status < 600 ? 502 : 500).json({
            success: false,
            error: 'analyze-link failed: ' + (err.message || 'unknown error')
        });
    }
});

// ── CRUD Endpoints ────────────────────────────────────────────────────

/**
 * GET /api/transfer-orders
 *
 * List transfers with optional filters.
 * Query params: status (CSV), companyName, designNumber, salesRep, isRush,
 *               dateFrom, dateTo, pageNumber, pageSize, orderBy
 */
router.get('/transfer-orders', async (req, res) => {
    try {
        const resource = `/tables/${TABLE}/records`;
        const params = {};
        const whereConditions = [];

        // Filter by status (CSV for multiple: "Requested,Ordered")
        if (req.query.status) {
            const statuses = req.query.status.split(',').map(s => `Status='${escapeSQL(s.trim())}'`);
            whereConditions.push(statuses.length === 1 ? statuses[0] : `(${statuses.join(' OR ')})`);
        }

        if (req.query.companyName) {
            whereConditions.push(`Company_Name LIKE '%${escapeSQL(req.query.companyName)}%'`);
        }

        if (req.query.designNumber) {
            whereConditions.push(`Design_Number='${escapeSQL(req.query.designNumber)}'`);
        }

        if (req.query.salesRep) {
            whereConditions.push(`Sales_Rep_Email='${escapeSQL(req.query.salesRep)}'`);
        }

        if (req.query.isRush === 'true' || req.query.isRush === 'Yes') {
            whereConditions.push(`Is_Rush=true`);
        } else if (req.query.isRush === 'false' || req.query.isRush === 'No') {
            whereConditions.push(`Is_Rush=false`);
        }

        // Filter by mockup (for the sales-rep visibility badge on mockup-detail)
        if (req.query.mockupId) {
            whereConditions.push(`Mockup_ID=${parseInt(req.query.mockupId, 10)}`);
        }

        if (req.query.designId) {
            whereConditions.push(`Design_ID=${parseInt(req.query.designId, 10)}`);
        }

        if (req.query.dateFrom) {
            whereConditions.push(`Requested_At>='${escapeSQL(req.query.dateFrom)}'`);
        }
        if (req.query.dateTo) {
            whereConditions.push(`Requested_At<='${escapeSQL(req.query.dateTo)}'`);
        }

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }

        params['q.orderBy'] = req.query.orderBy || 'Requested_At DESC';

        if (req.query.pageNumber) params['q.pageNumber'] = parseInt(req.query.pageNumber, 10);
        params['q.pageSize'] = parseInt(req.query.pageSize, 10) || parseInt(req.query.limit, 10) || 100;

        const records = await fetchAllCaspioPages(resource, params);

        // Optionally attach line_count + file_count + mockup_thumbnail_url per row
        // (Bradley's queue wants "3 transfers"/"5 files" pills + a mockup hero).
        // One batched fetch each against Transfer_Order_Lines and Transfer_Order_Files,
        // aggregate in memory.
        if ((req.query.includeLineCount === 'true' || req.query.includeLineCount === '1') && records.length > 0) {
            const ids = records.map(r => r.ID_Transfer).filter(Boolean);
            const inClause = ids.map(i => `'${escapeSQL(i)}'`).join(',');

            // Lines
            try {
                const linesRes = `/tables/${LINES_TABLE}/records`;
                const linesParams = {
                    'q.select': 'Transfer_ID',
                    'q.where': `Transfer_ID IN (${inClause})`,
                    'q.pageSize': 1000
                };
                const lineRows = await fetchAllCaspioPages(linesRes, linesParams);
                const counts = {};
                lineRows.forEach(l => {
                    counts[l.Transfer_ID] = (counts[l.Transfer_ID] || 0) + 1;
                });
                records.forEach(r => { r.line_count = counts[r.ID_Transfer] || 0; });
            } catch (err) {
                console.warn('Line count attach failed (records returned without counts):', err.message);
            }

            // Files: count + first mockup's Thumbnail_URL
            try {
                const filesRes = `/tables/${FILES_TABLE}/records`;
                const filesParams = {
                    'q.select': 'Transfer_ID,File_Type,File_Order,Thumbnail_URL,File_URL',
                    'q.where': `Transfer_ID IN (${inClause})`,
                    'q.orderBy': 'File_Order ASC',
                    'q.pageSize': 1000
                };
                const fileRows = await fetchAllCaspioPages(filesRes, filesParams);
                const fileCounts = {};
                const mockupThumbs = {};
                fileRows.forEach(f => {
                    fileCounts[f.Transfer_ID] = (fileCounts[f.Transfer_ID] || 0) + 1;
                    if (f.File_Type === 'mockup' && !mockupThumbs[f.Transfer_ID]) {
                        mockupThumbs[f.Transfer_ID] = f.Thumbnail_URL || f.File_URL || null;
                    }
                });
                records.forEach(r => {
                    // Synthesis fallback: if no child rows exist, derive from legacy flat columns.
                    if ((fileCounts[r.ID_Transfer] || 0) === 0) {
                        const synth = synthesizeFilesFromLegacy(r);
                        r.file_count = synth.length;
                        const m = synth.find(s => s.File_Type === 'mockup');
                        r.mockup_thumbnail_url = m ? (m.Thumbnail_URL || m.File_URL) : null;
                    } else {
                        r.file_count = fileCounts[r.ID_Transfer];
                        r.mockup_thumbnail_url = mockupThumbs[r.ID_Transfer] || null;
                    }
                });
            } catch (err) {
                console.warn('File count attach failed (records returned without file metadata):', err.message);
                // Synthesis fallback if the FILES_TABLE call failed entirely.
                records.forEach(r => {
                    const synth = synthesizeFilesFromLegacy(r);
                    r.file_count = synth.length;
                    const m = synth.find(s => s.File_Type === 'mockup');
                    r.mockup_thumbnail_url = m ? (m.Thumbnail_URL || m.File_URL) : null;
                });
            }
        }

        res.json({ success: true, count: records.length, records });

    } catch (error) {
        console.error('Error fetching transfer orders:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch transfer orders: ' + error.message });
    }
});

/**
 * GET /api/transfer-orders/stats
 *
 * Count per status for the Bradley dashboard header chips.
 * Fetches all non-terminal records and counts in memory (fast + simple).
 */
router.get('/transfer-orders/stats', async (req, res) => {
    try {
        const resource = `/tables/${TABLE}/records`;
        const params = {
            'q.select': 'Status',
            'q.pageSize': 1000
        };
        // Optional: exclude terminal statuses to keep the result set small
        if (req.query.activeOnly === 'true') {
            params['q.where'] = `Status NOT IN ('${TERMINAL_STATUSES.join("','")}')`;
        }

        const records = await fetchAllCaspioPages(resource, params);
        const stats = {};
        VALID_STATUSES.forEach(s => { stats[s] = 0; });
        records.forEach(r => {
            if (stats[r.Status] !== undefined) stats[r.Status]++;
        });

        res.json({ success: true, stats, total: records.length });

    } catch (error) {
        console.error('Error fetching transfer stats:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch stats: ' + error.message });
    }
});

/**
 * GET /api/transfer-orders/:id
 *
 * Get a single transfer by ID_Transfer. Includes child notes.
 */
router.get('/transfer-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();

        const record = await fetchTransfer(token, id);
        if (!record) {
            return res.status(404).json({ success: false, error: 'Transfer order not found' });
        }

        const safeId = escapeSQL(id);

        // Fetch child notes + lines + files in parallel
        const notesUrl = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records?q.where=Transfer_ID='${safeId}'&q.orderBy=Created_At ASC`;
        const [notesResp, lines, filesFromTable] = await Promise.all([
            axios.get(notesUrl, {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            }),
            fetchLines(token, id),
            fetchFiles(token, id)
        ]);

        // If no child file rows exist, synthesize from legacy flat columns so
        // the detail page renders uniformly across pre/post-migration records.
        const files = filesFromTable.length > 0
            ? filesFromTable
            : synthesizeFilesFromLegacy(record);

        res.json({
            success: true,
            record,
            notes: notesResp.data.Result || [],
            lines,
            files
        });

    } catch (error) {
        console.error('Error fetching transfer order:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch transfer: ' + error.message });
    }
});

/**
 * POST /api/transfer-orders
 *
 * Create a new transfer order.
 * Server generates ID_Transfer and writes an initial status_change note.
 *
 * Body: all writable Transfer_Orders fields.
 * Required: Requested_By (who clicked the button). Design_ID or Design_Number
 *   is strongly recommended for traceability but not enforced — Bradley can
 *   create transfers for art that bypassed the Art Hub.
 */
router.post('/transfer-orders', async (req, res) => {
    try {
        const token = await getCaspioAccessToken();

        // Strip read-only fields (PK_ID, ID_Transfer, Requested_At)
        const data = { ...req.body };
        READ_ONLY_FIELDS.forEach(f => delete data[f]);

        // Requested_By_Name is a helper for the initial note — not a column.
        // Pull it out before the Caspio insert (ColumnNotFound otherwise).
        const requestedByName = data.Requested_By_Name;
        delete data.Requested_By_Name;

        // Extract child lines (not a column on Transfer_Orders)
        let lines = Array.isArray(data.lines) ? data.lines : [];
        delete data.lines;

        // Backward compat: if caller didn't send lines[] but DID send single-row spec fields
        // at the top level (legacy mockup-detail / art-request-detail flow), auto-wrap into
        // a single synthetic line so the child table gets populated.
        if (lines.length === 0 && (data.Quantity || data.Transfer_Size)) {
            lines = [{
                Quantity: data.Quantity,
                Transfer_Size: data.Transfer_Size,
                Press_Count: data.Press_Count,
                Transfer_Width_In: data.Transfer_Width_In,
                Transfer_Height_In: data.Transfer_Height_In,
                File_Notes: data.File_Notes
            }];
        }

        // Extract child files (multi-file flow). Not a column on Transfer_Orders.
        let files = Array.isArray(data.files) ? data.files : [];
        delete data.files;

        // Single-mockup guard: at most one row may be File_Type='mockup'.
        const mockupCount = files.filter(f => f && f.File_Type === 'mockup').length;
        if (mockupCount > 1) {
            return res.status(400).json({
                success: false,
                error: `Only one mockup file is allowed per transfer (got ${mockupCount}). Mark the others as 'working' or 'reference'.`
            });
        }

        // Validate minimally
        if (!data.Requested_By) {
            return res.status(400).json({ success: false, error: 'Missing Requested_By' });
        }

        // Normalize Is_Rush to boolean (frontend might send "true"/"Yes"/1)
        if (data.Is_Rush !== undefined) {
            data.Is_Rush = (data.Is_Rush === true || data.Is_Rush === 'true' || data.Is_Rush === 'Yes' || data.Is_Rush === 1);
        } else {
            data.Is_Rush = false;
        }

        // Normalize Is_Reorder to boolean
        if (data.Is_Reorder !== undefined) {
            data.Is_Reorder = (data.Is_Reorder === true || data.Is_Reorder === 'true' || data.Is_Reorder === 'Yes' || data.Is_Reorder === 1);
        } else {
            data.Is_Reorder = false;
        }

        // Reorder mode requires a Supacolor_Order_Number (artwork is already on file at Supacolor,
        // so Bradley needs the reference number to find it).
        if (data.Is_Reorder && !data.Supacolor_Order_Number) {
            return res.status(400).json({ success: false, error: 'Reorder requires Supacolor_Order_Number' });
        }

        // Default status
        data.Status = data.Status || 'Requested';
        if (!VALID_STATUSES.includes(data.Status)) {
            return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
        }

        // Generate unique business ID
        const idTransfer = await generateTransferId(token);
        data.ID_Transfer = idTransfer;

        // Insert parent
        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records`;
        await axios.post(url, data, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        // Insert child lines. If any line insert fails, compensate by deleting the
        // parent (Caspio REST has no transactions — this is best-effort cleanup).
        let linesInserted = 0;
        try {
            linesInserted = await insertLines(token, idTransfer, lines);
        } catch (lineErr) {
            console.error(`Line insert failed for ${idTransfer} after ${linesInserted}/${lines.length} rows:`, lineErr.message);
            try {
                // Delete any lines that did get created, then the parent.
                await deleteLines(token, idTransfer);
                const safeId = escapeSQL(idTransfer);
                await axios.delete(`${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
            } catch (rollbackErr) {
                console.error(`Rollback failed for ${idTransfer} — orphan record may remain:`, rollbackErr.message);
            }
            return res.status(500).json({
                success: false,
                error: 'Failed to insert transfer lines: ' + lineErr.message,
                lines_inserted: linesInserted,
                lines_attempted: lines.length
            });
        }

        // Insert child files (multi-file flow). Same compensating-delete pattern as lines.
        let filesInserted = 0;
        try {
            filesInserted = await insertFiles(token, idTransfer, files);
        } catch (fileErr) {
            console.error(`File insert failed for ${idTransfer} after ${filesInserted}/${files.length} rows:`, fileErr.message);
            try {
                await deleteFiles(token, idTransfer);
                await deleteLines(token, idTransfer);
                const safeId = escapeSQL(idTransfer);
                await axios.delete(`${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
            } catch (rollbackErr) {
                console.error(`Rollback failed for ${idTransfer} — orphan record may remain:`, rollbackErr.message);
            }
            return res.status(500).json({
                success: false,
                error: 'Failed to insert transfer files: ' + fileErr.message,
                files_inserted: filesInserted,
                files_attempted: files.length
            });
        }

        // Fetch the created record back (so we have Requested_At populated) + child rows
        const created = await fetchTransfer(token, idTransfer);
        const createdLines = await fetchLines(token, idTransfer);
        const createdFiles = await fetchFiles(token, idTransfer);

        // Write initial status_change note
        const noteLineSummary = lines.length > 1 ? ` (${lines.length} transfer lines)` : '';
        const noteFileSummary = files.length > 0 ? ` [${files.length} file${files.length === 1 ? '' : 's'} attached]` : '';
        const noteReorderTag = data.Is_Reorder ? ` [REORDER #${data.Supacolor_Order_Number}]` : '';
        await writeNote(token, {
            Transfer_ID: idTransfer,
            Note_Type: 'status_change',
            Note_Text: `Transfer request created${noteReorderTag}${noteLineSummary}${noteFileSummary}. Status: ${data.Status}.${data.File_Notes ? ' Notes: ' + data.File_Notes : ''}`,
            Author_Email: data.Requested_By,
            Author_Name: requestedByName || data.Requested_By
        });

        console.log(`Transfer created: ${idTransfer} (${data.Company_Name || 'n/a'}, design ${data.Design_Number || 'n/a'}, ${lines.length} lines, ${files.length} files, by ${data.Requested_By})${data.Is_Reorder ? ' [REORDER]' : ''}`);

        res.status(201).json({
            success: true,
            record: created || { ID_Transfer: idTransfer, ...data },
            lines: createdLines,
            files: createdFiles
        });

    } catch (error) {
        console.error('Error creating transfer order:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create transfer: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id
 *
 * General update. Rejects Status (must use /status endpoint).
 * Body: partial Transfer_Orders fields.
 */
router.put('/transfer-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();

        // Strip read-only + status (status must go through /status endpoint for state machine + stamps + note)
        const data = { ...req.body };
        READ_ONLY_FIELDS.forEach(f => delete data[f]);
        if (data.Status !== undefined) {
            return res.status(400).json({
                success: false,
                error: 'Use PUT /api/transfer-orders/:id/status to change status (handles stamps and auto-notes).'
            });
        }

        // Normalize Is_Rush if present
        if (data.Is_Rush !== undefined) {
            data.Is_Rush = (data.Is_Rush === true || data.Is_Rush === 'true' || data.Is_Rush === 'Yes' || data.Is_Rush === 1);
        }

        if (Object.keys(data).length === 0) {
            return res.status(400).json({ success: false, error: 'No updatable fields provided' });
        }

        const safeId = escapeSQL(id);
        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
        await axios.put(url, data, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        console.log(`Transfer ${id} updated: ${Object.keys(data).join(', ')}`);
        res.json({ success: true, message: 'Transfer updated' });

    } catch (error) {
        console.error('Error updating transfer:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update transfer: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id/status
 *
 * Status transition. Validates the target status, sets the matching "_By"/"_At"
 * stamps, writes a status_change note to Transfer_Order_Notes.
 *
 * Body: {
 *   status,                // required; must be in VALID_STATUSES
 *   author,                // required; email of person making the change
 *   authorName?,           // display name for the note
 *   notes?,                // free-text appended to the auto-note
 *   supacolorOrderNumber?, // only honored when status='Ordered'
 *   supacolorOrderUrl?,    // only honored when status='Ordered'
 *   estimatedShipDate?,    // only honored when status='Ordered' or 'Shipped'
 *   shopworksPO?,          // only honored when status='PO_Created'
 *   trackingNumber?,       // only honored when status='Shipped'
 *   cancelReason?          // only honored when status='Cancelled'
 * }
 */
router.put('/transfer-orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, author, authorName, notes,
                supacolorOrderNumber, supacolorOrderUrl, estimatedShipDate,
                shopworksPO, trackingNumber, cancelReason } = req.body;

        if (!status) return res.status(400).json({ success: false, error: 'Missing status' });
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
        }
        if (!author) return res.status(400).json({ success: false, error: 'Missing author (email)' });

        const token = await getCaspioAccessToken();

        // Fetch current record
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        // Build update payload: status + matching stamps + any extra fields for this transition
        const now = new Date().toISOString();
        const update = { Status: status };

        if (status === 'Ordered') {
            update.Sent_To_Supacolor_By = author;
            update.Sent_To_Supacolor_At = now;
            if (supacolorOrderNumber) update.Supacolor_Order_Number = supacolorOrderNumber;
            if (supacolorOrderUrl) update.Supacolor_Order_URL = supacolorOrderUrl;
            if (estimatedShipDate) update.Estimated_Ship_Date = estimatedShipDate;
        } else if (status === 'PO_Created') {
            update.PO_Created_By = author;
            update.PO_Created_At = now;
            if (shopworksPO) update.ShopWorks_PO_Number = shopworksPO;
        } else if (status === 'Shipped') {
            if (trackingNumber) update.Tracking_Number = trackingNumber;
            if (estimatedShipDate) update.Estimated_Ship_Date = estimatedShipDate;
        } else if (status === 'Received') {
            update.Received_By = author;
            update.Received_At = now;
        } else if (status === 'Cancelled') {
            update.Cancelled_By = author;
            update.Cancelled_At = now;
            if (cancelReason) update.Cancel_Reason = cancelReason;
        }

        const safeId = escapeSQL(id);
        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
        await axios.put(url, update, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        // Write auto-note
        const noteParts = [`Status changed: ${current.Status} → ${status}`];
        if (supacolorOrderNumber) noteParts.push(`Supacolor #${supacolorOrderNumber}`);
        if (shopworksPO) noteParts.push(`ShopWorks PO #${shopworksPO}`);
        if (trackingNumber) noteParts.push(`Tracking: ${trackingNumber}`);
        if (cancelReason) noteParts.push(`Reason: ${cancelReason}`);
        if (notes) noteParts.push(notes);

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: status === 'Cancelled' ? 'cancellation' : 'status_change',
            Note_Text: noteParts.join(' | '),
            Author_Email: author,
            Author_Name: authorName || author
        });

        console.log(`Transfer ${id} status: ${current.Status} → ${status} (by ${author})`);

        res.json({
            success: true,
            previousStatus: current.Status,
            newStatus: status,
            updatedFields: Object.keys(update)
        });

    } catch (error) {
        console.error('Error updating transfer status:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update status: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id/rush
 *
 * Toggle the Is_Rush flag. Writes a rush_flag note.
 * Body: { isRush (boolean), reason?, author, authorName? }
 */
router.put('/transfer-orders/:id/rush', async (req, res) => {
    try {
        const { id } = req.params;
        const { isRush, reason, author, authorName } = req.body;

        if (typeof isRush === 'undefined') {
            return res.status(400).json({ success: false, error: 'Missing isRush (boolean)' });
        }
        if (!author) return res.status(400).json({ success: false, error: 'Missing author' });

        const rushBool = (isRush === true || isRush === 'true' || isRush === 'Yes' || isRush === 1);
        const token = await getCaspioAccessToken();

        // Verify the record exists first (so we 404 cleanly instead of silent no-op PUT)
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        const safeId = escapeSQL(id);
        const update = { Is_Rush: rushBool };
        if (rushBool && reason) update.Rush_Reason = reason;

        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
        await axios.put(url, update, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: 'rush_flag',
            Note_Text: rushBool
                ? `Marked as RUSH${reason ? '. Reason: ' + reason : ''}`
                : 'Rush flag cleared',
            Author_Email: author,
            Author_Name: authorName || author
        });

        console.log(`Transfer ${id} rush: ${rushBool} (by ${author})`);
        res.json({ success: true, isRush: rushBool });

    } catch (error) {
        console.error('Error updating rush flag:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update rush flag: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id/lines
 *
 * Replace all child Transfer_Order_Lines for this transfer. Full replace
 * (delete all, insert new) rather than per-line PATCH — edits are rare and
 * the simpler semantics avoid ID reconciliation.
 *
 * Body: { lines: [{Quantity, Transfer_Size, Press_Count, Transfer_Width_In,
 *                  Transfer_Height_In, File_Notes}], author, authorName? }
 */
router.put('/transfer-orders/:id/lines', async (req, res) => {
    try {
        const { id } = req.params;
        const { lines, author, authorName } = req.body;

        if (!Array.isArray(lines)) {
            return res.status(400).json({ success: false, error: 'Missing lines array' });
        }
        if (!author) {
            return res.status(400).json({ success: false, error: 'Missing author' });
        }

        const token = await getCaspioAccessToken();
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        // Full replace: delete all existing lines, then insert the new set.
        await deleteLines(token, id);
        let inserted = 0;
        try {
            inserted = await insertLines(token, id, lines);
        } catch (lineErr) {
            console.error(`Line replace failed for ${id} after ${inserted}/${lines.length}:`, lineErr.message);
            return res.status(500).json({
                success: false,
                error: 'Line replace failed mid-insert: ' + lineErr.message,
                lines_inserted: inserted,
                lines_attempted: lines.length
            });
        }

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: 'comment',
            Note_Text: `Transfer lines updated (${lines.length} line${lines.length === 1 ? '' : 's'})`,
            Author_Email: author,
            Author_Name: authorName || author
        });

        const fresh = await fetchLines(token, id);
        console.log(`Transfer ${id} lines replaced: ${inserted} line(s) (by ${author})`);
        res.json({ success: true, lines: fresh, lines_inserted: inserted });

    } catch (error) {
        console.error('Error replacing transfer lines:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to replace lines: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id/files
 *
 * Replace all child Transfer_Order_Files for this transfer. Full replace
 * (delete all, insert new). Mirrors the /lines endpoint.
 *
 * Body: { files: [{File_Type, File_URL, File_Name, ...}], author, authorName? }
 */
router.put('/transfer-orders/:id/files', async (req, res) => {
    try {
        const { id } = req.params;
        const { files, author, authorName } = req.body;

        if (!Array.isArray(files)) {
            return res.status(400).json({ success: false, error: 'Missing files array' });
        }
        if (!author) {
            return res.status(400).json({ success: false, error: 'Missing author' });
        }

        // Single-mockup guard
        const mockupCount = files.filter(f => f && f.File_Type === 'mockup').length;
        if (mockupCount > 1) {
            return res.status(400).json({
                success: false,
                error: `Only one mockup file is allowed per transfer (got ${mockupCount}).`
            });
        }

        const token = await getCaspioAccessToken();
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        await deleteFiles(token, id);
        let inserted = 0;
        try {
            inserted = await insertFiles(token, id, files);
        } catch (fileErr) {
            console.error(`File replace failed for ${id} after ${inserted}/${files.length}:`, fileErr.message);
            return res.status(500).json({
                success: false,
                error: 'File replace failed mid-insert: ' + fileErr.message,
                files_inserted: inserted,
                files_attempted: files.length
            });
        }

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: 'comment',
            Note_Text: `Transfer files updated (${files.length} file${files.length === 1 ? '' : 's'})`,
            Author_Email: author,
            Author_Name: authorName || author
        });

        const fresh = await fetchFiles(token, id);
        console.log(`Transfer ${id} files replaced: ${inserted} file(s) (by ${author})`);
        res.json({ success: true, files: fresh, files_inserted: inserted });

    } catch (error) {
        console.error('Error replacing transfer files:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to replace files: ' + error.message });
    }
});

/**
 * DELETE /api/transfer-orders/:id
 *
 * Soft delete: sets Status='Cancelled' and stamps Cancelled_By/_At/Cancel_Reason.
 * Hard delete via ?hard=true — only allowed when Status IN ('Requested', 'On_Hold'),
 * i.e., before Bradley has placed the Supacolor order. For true cancellations once
 * ordering has started, use soft delete to preserve the audit trail.
 *
 * Body: { author, authorName?, reason? }
 */
router.delete('/transfer-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const hard = req.query.hard === 'true';
        const { author, authorName, reason } = req.body || {};

        if (!author) return res.status(400).json({ success: false, error: 'Missing author' });

        const token = await getCaspioAccessToken();
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        const safeId = escapeSQL(id);

        if (hard) {
            // Hard delete only allowed before Bradley has placed the Supacolor order.
            // After Ordered/PO_Created/Shipped/Received, Cancel (soft delete) is the correct action
            // to preserve the audit trail of what was ordered from Supacolor.
            const HARD_DELETE_ALLOWED_STATUSES = ['Requested', 'On_Hold'];
            if (!HARD_DELETE_ALLOWED_STATUSES.includes(current.Status)) {
                return res.status(400).json({
                    success: false,
                    error: `Hard delete only allowed for 'Requested' or 'On_Hold' status. Current: '${current.Status}'. Use soft delete (omit ?hard=true) to cancel.`
                });
            }
            // Delete child notes + lines first (cascade)
            try {
                const notesUrl = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records?q.where=Transfer_ID='${safeId}'`;
                await axios.delete(notesUrl, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
            } catch (err) {
                console.warn(`Warning: failed to delete notes for transfer ${id}:`, err.message);
            }
            try {
                await deleteLines(token, id);
            } catch (err) {
                console.warn(`Warning: failed to delete lines for transfer ${id}:`, err.message);
            }
            try {
                await deleteFiles(token, id);
            } catch (err) {
                console.warn(`Warning: failed to delete files for transfer ${id}:`, err.message);
            }
            // Delete the transfer itself
            await axios.delete(`${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`, {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            });
            console.log(`Transfer ${id} HARD deleted by ${author}`);
            return res.json({ success: true, message: 'Transfer hard-deleted', mode: 'hard' });
        }

        // Soft delete: transition to Cancelled (reuses the same stamps + note logic)
        if (current.Status === 'Cancelled') {
            return res.status(400).json({ success: false, error: 'Transfer already cancelled' });
        }

        const now = new Date().toISOString();
        const update = {
            Status: 'Cancelled',
            Cancelled_By: author,
            Cancelled_At: now
        };
        if (reason) update.Cancel_Reason = reason;

        await axios.put(`${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`, update, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: 'cancellation',
            Note_Text: `Cancelled (was ${current.Status})${reason ? '. Reason: ' + reason : ''}`,
            Author_Email: author,
            Author_Name: authorName || author
        });

        console.log(`Transfer ${id} SOFT deleted (cancelled) by ${author}`);
        res.json({ success: true, message: 'Transfer cancelled', mode: 'soft', previousStatus: current.Status });

    } catch (error) {
        console.error('Error deleting transfer:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete transfer: ' + error.message });
    }
});

// ── Notes Endpoints ───────────────────────────────────────────────────

/**
 * GET /api/transfer-orders/:id/notes
 *
 * Get all notes for a transfer, ordered by creation date.
 */
router.get('/transfer-orders/:id/notes', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();
        const safeId = escapeSQL(id);
        const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records?q.where=Transfer_ID='${safeId}'&q.orderBy=Created_At ASC`;

        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        res.json({ success: true, count: (resp.data.Result || []).length, notes: resp.data.Result || [] });

    } catch (error) {
        console.error('Error fetching transfer notes:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch notes: ' + error.message });
    }
});

/**
 * POST /api/transfer-order-notes
 *
 * Add a free-text comment to a transfer.
 * Body: { Transfer_ID, Note_Text, Author_Email, Author_Name?, Note_Type? }
 */
router.post('/transfer-order-notes', async (req, res) => {
    try {
        const { Transfer_ID, Note_Text, Author_Email, Author_Name, Note_Type } = req.body;

        if (!Transfer_ID || !Note_Text || !Author_Email) {
            return res.status(400).json({ success: false, error: 'Missing Transfer_ID, Note_Text, or Author_Email' });
        }

        const token = await getCaspioAccessToken();
        await writeNote(token, {
            Transfer_ID,
            Note_Type: Note_Type || 'comment',
            Note_Text,
            Author_Email,
            Author_Name: Author_Name || Author_Email
        });

        console.log(`Transfer note added: ${Transfer_ID} by ${Author_Email} (${Note_Type || 'comment'})`);
        res.status(201).json({ success: true });

    } catch (error) {
        console.error('Error adding transfer note:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to add note: ' + error.message });
    }
});

module.exports = router;
