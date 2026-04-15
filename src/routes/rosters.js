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

        let newId = null;
        if (response.headers.location) {
            newId = parseInt(response.headers.location.split('/').pop());
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

            // Create group from sheet
            const groupId = sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
            const columns = [];
            const columnLabels = [];

            // Map common Excel column names to standard field names
            for (const header of headers) {
                if (!header) continue;
                const lower = header.toLowerCase();
                let fieldName = header;

                if (lower.includes('last name') || lower === 'name') fieldName = 'name';
                else if (lower.includes('first name')) fieldName = 'firstName';
                else if (lower.includes('jersey') || lower === 'number' || lower === '#') fieldName = 'number';
                else if (lower.includes('size')) fieldName = 'size';
                else if (lower.includes('style')) fieldName = 'style';
                else if (lower.includes('color')) fieldName = 'color';
                else if (lower.includes('qty') || lower === 'quantity') fieldName = 'qty';
                else if (lower.includes('back line 1') || lower.includes('back print')) fieldName = 'backLine1';
                else if (lower.includes('back line 2')) fieldName = 'backLine2';
                else if (lower.includes('back line 3')) fieldName = 'backLine3';
                else if (lower.includes('back line 4')) fieldName = 'backLine4';
                else if (lower.includes('front')) fieldName = 'frontPrint';
                else if (lower === 'back') fieldName = 'backPrint';
                else if (lower.includes('goes by') || lower.includes('nickname')) fieldName = 'nickname';
                else if (lower.includes('note')) fieldName = 'notes';
                else if (lower.includes('item')) fieldName = 'item';

                columns.push(fieldName);
                columnLabels.push(header);
            }

            // Detect garment style/color from data rows
            let garmentStyle = '';
            let garmentColor = '';
            const styleIdx = columns.indexOf('style');
            const colorIdx = columns.indexOf('color');

            for (let i = headerRowIdx + 1; i < data.length; i++) {
                const row = data[i];
                if (styleIdx >= 0 && row[styleIdx] && !garmentStyle) {
                    garmentStyle = String(row[styleIdx]).trim();
                }
                if (colorIdx >= 0 && row[colorIdx] && !garmentColor) {
                    garmentColor = String(row[colorIdx]).trim();
                }
                if (garmentStyle && garmentColor) break;
            }

            // Detect default values (same value in every data row)
            const defaults = {};
            for (let colIdx = 0; colIdx < columns.length; colIdx++) {
                const col = columns[colIdx];
                if (['style', 'color', 'number'].includes(col)) continue;

                const values = [];
                for (let i = headerRowIdx + 1; i < data.length; i++) {
                    const val = data[i][colIdx];
                    if (val != null && val !== '') values.push(String(val).trim());
                }
                if (values.length >= 2) {
                    const unique = [...new Set(values)];
                    if (unique.length === 1) {
                        defaults[col] = unique[0];
                    }
                }
            }

            // Filter out style/color from display columns if they're uniform
            const displayColumns = columns.filter(c => c !== 'style' && c !== 'color' && c !== 'item');
            const displayLabels = [];
            for (let i = 0; i < columns.length; i++) {
                if (displayColumns.includes(columns[i])) {
                    displayLabels.push(columnLabels[i]);
                }
            }

            groups.push({
                id: groupId,
                name: sheetName,
                garmentStyle,
                garmentColor,
                columns: displayColumns,
                columnLabels: displayLabels,
                defaults
            });

            // Parse data rows
            let lineNumber = 1;
            for (let i = headerRowIdx + 1; i < data.length; i++) {
                const row = data[i];
                // Skip empty rows and summary rows
                const nonEmpty = row.filter(c => c !== '' && c != null).length;
                if (nonEmpty < 2) continue;

                // Skip rows that look like totals/notes
                const firstCell = String(row[0] || '').toLowerCase();
                if (firstCell.includes('total') || firstCell.includes('update') || firstCell === '') {
                    // Check if this is just a row number being empty but has data
                    if (nonEmpty < 3) continue;
                }

                const entry = { groupId, lineNumber };
                for (let colIdx = 0; colIdx < columns.length; colIdx++) {
                    const col = columns[colIdx];
                    if (col === 'style' || col === 'color' || col === 'item') continue;
                    const val = row[colIdx];
                    if (val != null && val !== '') {
                        entry[col] = String(val).trim();
                    }
                }

                // Only add if the row has meaningful data
                if (entry.name || entry.number || entry.size || entry.backLine1 || entry.qty) {
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
This image may be a handwritten roster, a printed form, a screenshot, or a photo of a list.

Extract ALL person entries you can see. For each person, extract whatever fields are visible:
- name (last name or full name)
- number (jersey number, player number)
- size (shirt/garment size like S, M, L, XL, 2XL, etc.)
- Any back print text or custom lines

Also identify:
- What type of group this appears to be (e.g. "Players", "Coaches", "Staff", "Team")
- The team/organization name if visible

Return ONLY valid JSON (no markdown fencing, no explanation):
{
  "teamName": "string or null",
  "groupName": "string or null",
  "entries": [
    {
      "name": "string",
      "number": "string or null",
      "size": "string or null",
      "backPrint": "string or null",
      "notes": "string or null"
    }
  ],
  "rawText": "the full extracted text as-is for reference"
}

IMPORTANT:
- Extract EVERY person/name you can read, even if partially legible
- For unclear text, make your best guess and add "(uncertain)" in notes
- Sizes should be normalized: Small→S, Medium→M, Large→L, X-Large→XL, XX-Large→2XL
- Numbers should be digits only (not spelled out)`;

router.post('/rosters/ocr', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(req.file.mimetype)) {
            return res.status(400).json({
                success: false,
                error: `Unsupported file type: ${req.file.mimetype}. Use JPEG, PNG, GIF, or WebP.`
            });
        }

        const client = getAnthropicClient();
        const base64Image = req.file.buffer.toString('base64');

        const response = await client.messages.create({
            model: 'claude-sonnet-4-5-20241022',
            max_tokens: 4096,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: req.file.mimetype,
                            data: base64Image
                        }
                    },
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
