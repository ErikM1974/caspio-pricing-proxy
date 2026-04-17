// Rosters CRUD Routes - Names_Numbers_Rosters table
// Endpoints for managing team rosters (names, numbers, sizes, back prints)
// Includes Excel parsing + Claude Vision OCR extraction

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const XLSX = require('xlsx');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'Names_Numbers_Rosters';

// Multer config for file uploads (memory storage, 10MB limit)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Lazy-init Anthropic client for OCR
let anthropicClient = null;
function getAnthropicClient() {
    if (!anthropicClient) {
        const Anthropic = require('@anthropic-ai/sdk');
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
        anthropicClient = new Anthropic({ apiKey });
    }
    return anthropicClient;
}

// =====================
// Input Sanitization
// =====================

const VALID_STATUSES = ['Draft', 'Submitted', 'In Production', 'Completed', 'Cancelled'];

const ALLOWED_FIELDS = [
    'RosterName', 'CompanyName', 'ID_Customer', 'OrderNumber',
    'ContactName', 'ContactEmail', 'SalesRep',
    'GroupsJSON', 'RosterJSON', 'TotalPersons',
    'Status', 'Notes', 'UploadedFileURL',
    'CreatedAt', 'CreatedBy', 'ModifiedAt'
];

function sanitizeSearchQuery(str) {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/['"\\\-%_]/g, '').trim().substring(0, 200);
}

function sanitizePositiveInt(val) {
    const num = parseInt(val, 10);
    return (Number.isInteger(num) && num > 0) ? num : null;
}

function sanitizeDateString(str) {
    if (!str || typeof str !== 'string') return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}

function sanitizeStatus(str) {
    return VALID_STATUSES.includes(str) ? str : null;
}

function filterAllowedFields(body) {
    const filtered = {};
    for (const key of ALLOWED_FIELDS) {
        if (body[key] !== undefined) {
            filtered[key] = body[key];
        }
    }
    return filtered;
}

// =====================
// CRUD Endpoints
// =====================

// GET /api/rosters - List all rosters with optional filters
router.get('/rosters', async (req, res) => {
    try {
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {};
        const whereConditions = [];

        if (req.query.companyName) {
            const name = sanitizeSearchQuery(req.query.companyName);
            if (name) whereConditions.push(`CompanyName LIKE '%${name}%'`);
        }
        if (req.query.rosterName) {
            const name = sanitizeSearchQuery(req.query.rosterName);
            if (name) whereConditions.push(`RosterName LIKE '%${name}%'`);
        }
        if (req.query.status) {
            const status = sanitizeStatus(req.query.status);
            if (status) whereConditions.push(`Status='${status}'`);
        }
        if (req.query.salesRep) {
            const rep = sanitizeSearchQuery(req.query.salesRep);
            if (rep) whereConditions.push(`SalesRep LIKE '%${rep}%'`);
        }
        if (req.query.orderNumber) {
            const num = sanitizePositiveInt(req.query.orderNumber);
            if (num) whereConditions.push(`OrderNumber=${num}`);
        }
        if (req.query.dateFrom) {
            const d = sanitizeDateString(req.query.dateFrom);
            if (d) whereConditions.push(`CreatedAt>='${d}'`);
        }
        if (req.query.dateTo) {
            const d = sanitizeDateString(req.query.dateTo);
            if (d) whereConditions.push(`CreatedAt<='${d}'`);
        }

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }
        params['q.orderBy'] = 'ModifiedAt DESC';

        const result = await fetchAllCaspioPages(resource, params);

        res.json({
            success: true,
            count: result.length,
            rosters: result
        });
    } catch (error) {
        console.error('Error fetching rosters:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch rosters' });
    }
});

// GET /api/rosters/:id - Get single roster by ID_Roster
router.get('/rosters/:id', async (req, res) => {
    const id = sanitizePositiveInt(req.params.id);
    if (!id) {
        return res.status(400).json({ success: false, error: 'Invalid roster ID' });
    }

    try {
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `ID_Roster=${id}`,
            'q.limit': 1
        };
        const result = await fetchAllCaspioPages(resource, params);

        if (result.length === 0) {
            return res.status(404).json({ success: false, error: 'Roster not found' });
        }

        res.json({ success: true, roster: result[0] });
    } catch (error) {
        console.error('Error fetching roster:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch roster' });
    }
});

// POST /api/rosters - Create new roster
router.post('/rosters', express.json(), async (req, res) => {
    try {
        const requestData = filterAllowedFields(req.body);

        if (!requestData.RosterName) {
            return res.status(400).json({ success: false, error: 'Missing required field: RosterName' });
        }

        if (!requestData.CreatedAt) {
            requestData.CreatedAt = new Date().toISOString();
        }
        requestData.ModifiedAt = new Date().toISOString();

        if (!requestData.Status) {
            requestData.Status = 'Draft';
        }

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;

        const response = await axios({
            method: 'post',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: requestData,
            timeout: 15000
        });

        // Caspio doesn't reliably return the new ID in the response.
        // Query back to get the ID_Roster of the record we just created.
        let newId = null;
        if (response.headers.location) {
            newId = parseInt(response.headers.location.split('/').pop());
        }

        // Fallback: query by CreatedAt to find the record we just created
        if (!newId || isNaN(newId)) {
            try {
                const lookupParams = {
                    'q.where': `RosterName='${(requestData.RosterName || '').replace(/'/g, "''")}'`,
                    'q.orderBy': 'ID_Roster DESC',
                    'q.limit': 1,
                    'q.select': 'ID_Roster'
                };
                const lookup = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, lookupParams);
                if (lookup.length > 0) {
                    newId = lookup[0].ID_Roster;
                }
            } catch (lookupErr) {
                console.warn('Could not look up new roster ID:', lookupErr.message);
            }
        }

        res.status(201).json({
            success: true,
            action: 'created',
            roster: { ID_Roster: newId, ...requestData }
        });
    } catch (error) {
        console.error('Error creating roster:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create roster' });
    }
});

// PUT /api/rosters/:id - Update roster by ID
router.put('/rosters/:id', express.json(), async (req, res) => {
    const id = sanitizePositiveInt(req.params.id);
    if (!id) {
        return res.status(400).json({ success: false, error: 'Invalid roster ID' });
    }

    try {
        const updateData = filterAllowedFields(req.body);
        updateData.ModifiedAt = new Date().toISOString();

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Roster=${id}`;

        await axios({
            method: 'put',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updateData,
            timeout: 15000
        });

        res.json({ success: true, message: 'Roster updated successfully' });
    } catch (error) {
        console.error('Error updating roster:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update roster' });
    }
});

// DELETE /api/rosters/:id - Delete roster by ID
router.delete('/rosters/:id', async (req, res) => {
    const id = sanitizePositiveInt(req.params.id);
    if (!id) {
        return res.status(400).json({ success: false, error: 'Invalid roster ID' });
    }

    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Roster=${id}`;

        await axios({
            method: 'delete',
            url,
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        res.json({ success: true, message: 'Roster deleted successfully' });
    } catch (error) {
        console.error('Error deleting roster:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete roster' });
    }
});

// =====================
// Excel Parser
// =====================

// POST /api/rosters/parse-excel - Upload .xlsx, return parsed groups + rows
router.post('/rosters/parse-excel', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const groups = [];
        const rows = [];

        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            if (!data || data.length < 2) continue;

            // Find header row (first row with 3+ non-empty cells)
            let headerRowIdx = 0;
            for (let i = 0; i < Math.min(data.length, 5); i++) {
                const nonEmpty = data[i].filter(c => c !== '' && c != null).length;
                if (nonEmpty >= 3) { headerRowIdx = i; break; }
            }

            const headers = data[headerRowIdx].map(h => String(h || '').trim());
            if (headers.filter(h => h).length < 2) continue;

            // Create group from sheet (v2 multi-garment shape)
            const groupId = 'group-' + sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '') + '-' + Math.random().toString(36).substr(2, 4);
            // Per-header classification: { kind, key?, garmentIdx?, field? }
            const headerMap = [];
            // Detected garments per column group. Each has { id, label, hasBackPrint, hasFrontPrint, hasQty }
            const detectedGarments = [];

            // Helper: extract garment label from a header like "T-shirt Size" → "T-shirt"
            const extractGarmentLabel = (headerLower, field) => {
                // Strip the field keyword from the header to get the garment label
                const cleaned = headerLower
                    .replace(/\b(size|sizes|back\s*print|front\s*print|qty|quantity|back\s*line\s*\d*)\b/gi, '')
                    .replace(/[:\-()]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                return cleaned || (field === 'size' ? 'Garment' : '');
            };
            const getOrCreateGarment = (label) => {
                const normalized = (label || 'Garment').trim() || 'Garment';
                let g = detectedGarments.find(dg => dg.label.toLowerCase() === normalized.toLowerCase());
                if (!g) {
                    g = {
                        id: 'g-' + Math.random().toString(36).substr(2, 8),
                        label: normalized,
                        style: '', color: '',
                        hasBackPrint: false, hasFrontPrint: false, hasQty: false, hasBackLines: false
                    };
                    detectedGarments.push(g);
                }
                return g;
            };

            // Classify each header
            for (const header of headers) {
                if (!header) { headerMap.push({ kind: 'skip' }); continue; }
                const lower = header.toLowerCase();

                // Person columns
                if (lower.includes('last name') || lower === 'name') { headerMap.push({ kind: 'person', key: 'name' }); continue; }
                if (lower.includes('first name')) { headerMap.push({ kind: 'person', key: 'firstName' }); continue; }
                if (lower.includes('full name') || lower.includes('handout') || (lower.includes('name') && lower.includes('student'))) { headerMap.push({ kind: 'person', key: 'fullName' }); continue; }
                if (lower.includes('jersey') || lower === 'number' || lower === '#') { headerMap.push({ kind: 'person', key: 'number' }); continue; }
                if (lower.includes('goes by') || lower.includes('nickname')) { headerMap.push({ kind: 'person', key: 'nickname' }); continue; }
                if (lower.includes('note')) { headerMap.push({ kind: 'person', key: 'notes' }); continue; }

                // Meta columns — used to enrich garments, not displayed as rows
                if (lower.includes('style') || lower.includes('item')) { headerMap.push({ kind: 'meta', key: 'style' }); continue; }
                if (lower.includes('color')) { headerMap.push({ kind: 'meta', key: 'color' }); continue; }

                // Garment-specific columns
                if (lower.includes('size')) {
                    const g = getOrCreateGarment(extractGarmentLabel(lower, 'size') || 'Garment');
                    headerMap.push({ kind: 'garment', garmentId: g.id, field: 'size' });
                    continue;
                }
                if (lower.includes('back print') || lower.match(/name on back/)) {
                    const g = getOrCreateGarment(extractGarmentLabel(lower, 'backPrint') || 'Garment');
                    g.hasBackPrint = true;
                    headerMap.push({ kind: 'garment', garmentId: g.id, field: 'backPrint' });
                    continue;
                }
                if (lower.includes('front print') || lower.startsWith('front')) {
                    const g = getOrCreateGarment(extractGarmentLabel(lower, 'frontPrint') || 'Garment');
                    g.hasFrontPrint = true;
                    headerMap.push({ kind: 'garment', garmentId: g.id, field: 'frontPrint' });
                    continue;
                }
                if (lower.includes('qty') || lower === 'quantity') {
                    const g = getOrCreateGarment(extractGarmentLabel(lower, 'qty') || 'Garment');
                    g.hasQty = true;
                    headerMap.push({ kind: 'garment', garmentId: g.id, field: 'qty' });
                    continue;
                }
                const bl = lower.match(/back\s*line\s*(\d)/);
                if (bl) {
                    const g = getOrCreateGarment(extractGarmentLabel(lower, 'backLine') || 'Garment');
                    g.hasBackLines = true;
                    headerMap.push({ kind: 'garment', garmentId: g.id, field: 'backLine' + bl[1] });
                    continue;
                }

                // Unknown header — treat as custom column (with the raw label)
                const ccId = 'cc-' + Math.random().toString(36).substr(2, 8);
                headerMap.push({ kind: 'custom', key: ccId, label: header });
            }

            // If nothing was detected as a garment (no size column), still create a default one
            if (detectedGarments.length === 0) {
                detectedGarments.push({
                    id: 'g-' + Math.random().toString(36).substr(2, 8),
                    label: 'Garment', style: '', color: '',
                    hasBackPrint: false, hasFrontPrint: false, hasQty: false, hasBackLines: false
                });
            }

            // Collect person columns + custom columns in detected order
            const personColumns = [];
            const customColumns = [];
            for (const h of headerMap) {
                if (h.kind === 'person' && !personColumns.includes(h.key)) personColumns.push(h.key);
                if (h.kind === 'custom') customColumns.push({ id: h.key, label: h.label });
            }
            if (personColumns.length === 0) personColumns.push('name');

            // Enrich detected garments with style/color from meta columns (if present)
            const metaStyleIdx = headerMap.findIndex(h => h.kind === 'meta' && h.key === 'style');
            const metaColorIdx = headerMap.findIndex(h => h.kind === 'meta' && h.key === 'color');
            if (metaStyleIdx >= 0 || metaColorIdx >= 0) {
                for (let i = headerRowIdx + 1; i < data.length; i++) {
                    const row = data[i];
                    const style = metaStyleIdx >= 0 ? String(row[metaStyleIdx] || '').trim() : '';
                    const color = metaColorIdx >= 0 ? String(row[metaColorIdx] || '').trim() : '';
                    if (style && !detectedGarments[0].style) detectedGarments[0].style = style;
                    if (color && !detectedGarments[0].color) detectedGarments[0].color = color;
                    if (detectedGarments[0].style && detectedGarments[0].color) break;
                }
            }

            groups.push({
                id: groupId,
                name: sheetName,
                garments: detectedGarments,
                personColumns,
                customColumns,
                defaults: {}
            });

            // Parse data rows into v2-shape entries
            let lineNumber = 1;
            for (let i = headerRowIdx + 1; i < data.length; i++) {
                const row = data[i];
                const nonEmpty = row.filter(c => c !== '' && c != null).length;
                if (nonEmpty < 2) continue;

                const firstCell = String(row[0] || '').toLowerCase();
                if (firstCell.includes('total') || firstCell.includes('update') || firstCell === '') {
                    if (nonEmpty < 3) continue;
                }

                const entry = { groupId, lineNumber, garmentData: {}, custom: {} };
                for (let colIdx = 0; colIdx < headerMap.length; colIdx++) {
                    const h = headerMap[colIdx];
                    if (!h || h.kind === 'skip' || h.kind === 'meta') continue;
                    const val = row[colIdx];
                    if (val == null || val === '') continue;
                    const strVal = String(val).trim();

                    if (h.kind === 'person') {
                        entry[h.key] = strVal;
                    } else if (h.kind === 'garment') {
                        if (!entry.garmentData[h.garmentId]) entry.garmentData[h.garmentId] = {};
                        entry.garmentData[h.garmentId][h.field] = strVal;
                    } else if (h.kind === 'custom') {
                        entry.custom[h.key] = strVal;
                    }
                }

                // Only add if the row has meaningful data
                const hasGarmentData = Object.values(entry.garmentData).some(gd => Object.keys(gd).length > 0);
                if (entry.name || entry.fullName || entry.number || hasGarmentData) {
                    rows.push(entry);
                    lineNumber++;
                }
            }
        }

        res.json({
            success: true,
            fileName: req.file.originalname,
            groups,
            rows,
            totalGroups: groups.length,
            totalRows: rows.length
        });
    } catch (error) {
        console.error('Error parsing Excel:', error.message);
        res.status(500).json({ success: false, error: 'Failed to parse Excel file' });
    }
});

// =====================
// OCR — Claude Vision
// =====================

const OCR_PROMPT = `You are extracting roster/names data from an image for a custom apparel company.
This image may be a handwritten roster, a printed form, a screenshot, a photo, or a structured table.

FIRST — Detect the layout:
- Does the table have ONE size column, or MULTIPLE size columns (e.g. "T-shirt Size" AND "Hoodie Size")?
- If multiple, each represents a different garment the same person is getting.
- Are there garment-specific columns like "Name on Back of Hoodie" (back print only on that garment)?

Extract ALL person entries. For each person, capture whatever fields are visible:
- name (last name — if only full name is given, put last name here and full name in fullName)
- number (jersey number)
- fullName (if a column like "Full Name", "Name of Student", "Handout Name" exists)
- per-garment sizes (one value per garment type)
- per-garment back print text (only for garments that have a back-print column)
- notes (formatting instructions like "Space between DE and J", or anything unusual)

Also identify:
- The team / organization name if visible (put in teamName)
- A reasonable group label (e.g. "Players", "Staff") if the image suggests one (groupName)

Return ONLY valid JSON — no markdown fencing, no explanation.

SHAPE when multiple garments detected:
{
  "teamName": "string or null",
  "groupName": "string or null",
  "garments": [
    { "label": "T-shirt", "hasBackPrint": false },
    { "label": "Hoodie",  "hasBackPrint": true  }
  ],
  "entries": [
    {
      "name": "Sander",
      "fullName": "Addilyn Sander",
      "number": null,
      "sizes": { "T-shirt": "Youth Medium", "Hoodie": "Youth Medium" },
      "backPrints": { "Hoodie": "SANDER" },
      "notes": null
    }
  ],
  "rawText": "full extracted text as-is"
}

SHAPE when only one garment / size column detected (backward-compatible, preferred for simple rosters):
{
  "teamName": "string or null",
  "groupName": "string or null",
  "entries": [
    { "name": "Smith", "number": "6", "size": "L", "backPrint": null, "notes": null }
  ],
  "rawText": "..."
}

IMPORTANT:
- Use the multi-garment shape ONLY if the image clearly shows 2+ size columns or 2+ garment types per person. Otherwise use the simple shape.
- The "label" values in "garments" MUST match the keys used in each entry's "sizes"/"backPrints" map exactly.
- Extract EVERY person you can read, even if partially legible.
- For unclear text, make your best guess and add "(uncertain)" in notes.
- Keep sizes verbatim when they are full words (e.g. "Youth Medium", "Adult Small") — customers often want this preserved. Only abbreviate when the source already uses abbreviations (S, M, L, XL, 2XL).
- Numbers should be digits only.`;

router.post('/rosters/ocr', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
        if (!allowedTypes.includes(req.file.mimetype)) {
            return res.status(400).json({
                success: false,
                error: `Unsupported file type: ${req.file.mimetype}. Use JPEG, PNG, GIF, WebP, or PDF.`
            });
        }

        const client = getAnthropicClient();
        const base64Data = req.file.buffer.toString('base64');
        const isPdf = req.file.mimetype === 'application/pdf';

        // Claude 4.5 accepts native PDFs via document blocks — both the text
        // layer and visual layout come through, no rasterization needed.
        const sourceBlock = isPdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
            : { type: 'image',    source: { type: 'base64', media_type: req.file.mimetype, data: base64Data } };

        const response = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 8192,
            messages: [{
                role: 'user',
                content: [
                    sourceBlock,
                    { type: 'text', text: OCR_PROMPT }
                ]
            }]
        });

        const responseText = response.content[0].text;

        // Parse JSON from response (handle markdown fencing if present)
        let parsed;
        try {
            const jsonStr = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            parsed = JSON.parse(jsonStr);
        } catch (parseErr) {
            return res.json({
                success: true,
                parsed: false,
                rawText: responseText,
                error: 'Could not parse structured data — raw text returned for manual review'
            });
        }

        res.json({
            success: true,
            parsed: true,
            teamName: parsed.teamName || null,
            groupName: parsed.groupName || null,
            garments: Array.isArray(parsed.garments) ? parsed.garments : null,
            entries: parsed.entries || [],
            rawText: parsed.rawText || '',
            totalExtracted: (parsed.entries || []).length
        });
    } catch (error) {
        console.error('OCR error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to process image for OCR' });
    }
});

module.exports = router;
