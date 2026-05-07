// Vision Routes — ShopWorks screenshot extraction via Claude Haiku
// Accepts base64 image, extracts customer/order/design/garment data

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { boxFetchFileBytes, boxGetFileInfo } = require('../utils/box-client');

// Lazy-init Anthropic client (same pattern as mockup-vision.js)
let anthropicClient = null;
function getClient() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
        anthropicClient = new Anthropic({ apiKey });
    }
    return anthropicClient;
}

const MODEL_ID = 'claude-haiku-4-5-20251001';

const EXTRACTION_PROMPT = `You are extracting data from a ShopWorks OnSite screenshot. This is an order management system for a custom apparel company.

Look at the screenshot and extract ALL visible fields. The screenshot may show any of these tabs:

**Customer tab** — look for:
- Customer number (4-5 digit number near company name, often in a "View" row)
- Company name (the CUSTOMER company, not "Northwest Custom Apparel")
- Order number (large number, top-right area labeled "Order Number:")
- Contact first name and last name (in the "Order Contact" section)
- Phone number and email address
- Salesperson name (in "Order Information" section)
- Date Order Placed, Req. Ship Date (right side, date format M/D/YY)
- Order type: shown in the colored header bar as text (e.g. "Transfers", "HOT-TICKET (WOW)", "Custom Screen Print", "Custom Embroidery", "Digital Printing", "Laser/Ad Specialties"). Extract the FULL text, not just abbreviations.

**Design tab** — look for:
- Design number (in "Currently Viewing" section, the number before the dash)
- Design name (text after the design number)
- Order type (shown as badge in top-right, e.g. "EMB", "DTG", "SP")
- Number of locations
- Location code (2-3 letter code like "LC", "FB", "FF", "CB", "CFC", "CLP", "CRS" — shown in the Location dropdown or field)

**Line Items tab** — look for garment/product rows:
- Part number (e.g. PC54, PC850H, PC600LS, C110)
- Color name
- Description
- Also look for art charge line items with part numbers starting with "GRT-" (e.g. GRT-50, GRT-75, GRT-100). Return the first GRT part number found as artCharge.

Return a JSON object with ONLY the fields you can see. Use null for fields not visible in this screenshot.

IMPORTANT:
- Return ONLY valid JSON, no markdown fencing, no explanation
- For garments array, only include actual apparel products (skip stickers, tumblers, promotional items, and GRT-* art charges)
- Part numbers are typically 2-8 characters like PC54, PC850H, DT6000, ST350LS, C110
- Customer numbers are typically 4-5 digit numbers
- Order numbers are typically 5-6 digit numbers
- For orderType, return the FULL ShopWorks name (e.g. "Custom Screen Print", "Digital Printing", "Transfers", "Custom Embroidery", "Laser/Ad Specialties")

JSON schema:
{
  "tab": "customer|design|lineitems|unknown",
  "companyName": "string|null",
  "customerNumber": "string|null",
  "orderNumber": "string|null",
  "contactFirstName": "string|null",
  "contactLastName": "string|null",
  "contactEmail": "string|null",
  "contactPhone": "string|null",
  "salesPerson": "string|null",
  "dateOrderPlaced": "string|null",
  "reqShipDate": "string|null",
  "designNumber": "string|null",
  "designName": "string|null",
  "orderType": "string|null",
  "locations": "number|null",
  "locationCode": "string|null",
  "artCharge": "string|null",
  "garments": [
    {
      "partNumber": "string",
      "color": "string",
      "description": "string"
    }
  ]
}`;

// POST /api/vision/extract-shopworks
router.post('/extract-shopworks', async (req, res) => {
    const startTime = Date.now();

    try {
        const { image } = req.body;

        if (!image) {
            return res.status(400).json({ error: 'Missing image field. Send base64 data URI.' });
        }

        // Parse data URI: "data:image/png;base64,iVBOR..."
        let mediaType = 'image/png';
        let base64Data = image;

        if (image.startsWith('data:')) {
            const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
            if (!match) {
                return res.status(400).json({ error: 'Invalid data URI format. Expected data:image/*;base64,...' });
            }
            mediaType = match[1];
            base64Data = match[2];
        }

        // Call Claude Haiku with vision
        const client = getClient();
        const response = await client.messages.create({
            model: MODEL_ID,
            max_tokens: 1024,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: base64Data
                        }
                    },
                    {
                        type: 'text',
                        text: EXTRACTION_PROMPT
                    }
                ]
            }]
        });

        // Parse the JSON response
        const responseText = response.content[0].text.trim();
        let extracted;

        try {
            // Handle potential markdown fencing
            const jsonStr = responseText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
            extracted = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error('[Vision] Failed to parse Claude response:', responseText.substring(0, 200));
            return res.status(500).json({
                error: 'Failed to parse extraction results',
                raw: responseText.substring(0, 500)
            });
        }

        const duration = Date.now() - startTime;
        console.log(`[Vision] ShopWorks extraction complete in ${duration}ms — tab: ${extracted.tab}, fields: ${Object.keys(extracted).filter(k => extracted[k] != null && k !== 'tab' && k !== 'garments').length}`);

        res.json({
            success: true,
            data: extracted,
            duration
        });

    } catch (error) {
        console.error('[Vision] Extraction error:', error.message);
        res.status(500).json({
            error: 'Vision extraction failed',
            details: error.message
        });
    }
});

// ── Supacolor Screenshot Extraction ─────────────────────────────────
// Bradley pastes a screenshot of a Supacolor order page (integrate.supacolor.com/dashboard/jobs/<id>)
// We extract the job #, requested ship date, tracking # (when present) so he doesn't retype.

const SUPACOLOR_EXTRACTION_PROMPT = `You are extracting data from a Supacolor integrate dashboard screenshot. Supacolor is a heat-transfer printing subcontractor. The screenshot shows an order details page with sections like: a big "#" job number at the top, Job Details (with PO), Timeline (with Entered / Requested Ship / Shipped dates), Joblines (printed transfer line items), Shipping (address + carrier + method), and History.

Extract ONLY the fields below. Return null for anything not visible.

Fields to find:

- **supacolorJobNumber**: The big 6-digit number at the top of the page, usually shown as "#637713" or similar. Return just the digits (e.g. "637713"), no "#".
- **shopworksPO**: Under "Job Details", a label like "PO: 112659 BW". Return the full PO value including any suffix (e.g. "112659 BW").
- **customerName**: The line under PO in Job Details (e.g. "Smith Brothers", "Holy Family School", "NW Utility", "Selden's").
- **estimatedShipDate**: Under "Timeline", the date labeled "Requested Ship" (e.g. "Apr 20, 2026"). Normalize to ISO format YYYY-MM-DD (e.g. "2026-04-20").
- **actualShipDate**: Under "Timeline", the date labeled "Shipped" IF it shows a real date (not "Pending"). Normalize to YYYY-MM-DD. Return null if Shipped = Pending.
- **trackingNumber**: Usually shown on the dashboard home page as a shipment entry with carrier + tracking. If the screenshot shows a FedEx/UPS/USPS tracking number in a "Track" link or similar, return it. Otherwise null.
- **carrier**: "FedEx", "UPS", "USPS", etc. — only if visible. Otherwise null.
- **shippingMethod**: e.g. "2 Day Air", "Ground", "Overnight" — shown in the "Shipping" header.
- **totalAmount**: The order total (e.g. $130.80 → 130.80) as a number, not a string. Look for a "Total" row.

IMPORTANT:
- Return ONLY valid JSON, no markdown fencing, no explanation.
- For dates, ALWAYS output ISO format YYYY-MM-DD. If you see "Apr 20, 2026", return "2026-04-20".
- For supacolorJobNumber, strip the "#" prefix.
- If the screenshot is not a Supacolor page or no fields are recognizable, return {"error": "not_a_supacolor_page"}.

JSON schema:
{
  "supacolorJobNumber": "string|null",
  "shopworksPO": "string|null",
  "customerName": "string|null",
  "estimatedShipDate": "string|null",
  "actualShipDate": "string|null",
  "trackingNumber": "string|null",
  "carrier": "string|null",
  "shippingMethod": "string|null",
  "totalAmount": "number|null"
}`;

// POST /api/vision/extract-supacolor
router.post('/extract-supacolor', async (req, res) => {
    const startTime = Date.now();

    try {
        const { image } = req.body;

        if (!image) {
            return res.status(400).json({ error: 'Missing image field. Send base64 data URI.' });
        }

        // Parse data URI (same pattern as extract-shopworks)
        let mediaType = 'image/png';
        let base64Data = image;

        if (image.startsWith('data:')) {
            const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
            if (!match) {
                return res.status(400).json({ error: 'Invalid data URI format. Expected data:image/*;base64,...' });
            }
            mediaType = match[1];
            base64Data = match[2];
        }

        const client = getClient();
        const response = await client.messages.create({
            model: MODEL_ID,
            max_tokens: 1024,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: base64Data
                        }
                    },
                    {
                        type: 'text',
                        text: SUPACOLOR_EXTRACTION_PROMPT
                    }
                ]
            }]
        });

        const responseText = response.content[0].text.trim();
        let extracted;

        try {
            const jsonStr = responseText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
            extracted = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error('[Vision] Failed to parse Supacolor response:', responseText.substring(0, 200));
            return res.status(500).json({
                error: 'Failed to parse extraction results',
                raw: responseText.substring(0, 500)
            });
        }

        if (extracted.error === 'not_a_supacolor_page') {
            return res.status(400).json({
                success: false,
                error: 'This doesn\'t look like a Supacolor order page. Paste a screenshot from integrate.supacolor.com.'
            });
        }

        const duration = Date.now() - startTime;
        const filledFields = Object.keys(extracted).filter(k => extracted[k] != null).length;
        console.log(`[Vision] Supacolor extraction complete in ${duration}ms — job: ${extracted.supacolorJobNumber || 'n/a'}, ${filledFields} fields filled`);

        res.json({
            success: true,
            data: extracted,
            duration
        });

    } catch (error) {
        console.error('[Vision] Supacolor extraction error:', error.message);
        res.status(500).json({
            error: 'Vision extraction failed',
            details: error.message
        });
    }
});

// ── Supacolor JOBS LIST (bulk backfill) ─────────────────────────────────

const SUPACOLOR_JOBS_LIST_PROMPT = `You are extracting data from a screenshot of the Supacolor "Jobs" list page (integrate.supacolor.com/dashboard/jobs).

The screenshot shows a table of jobs. Each row contains:
- Job # (e.g. "#637351") — strip the leading "#"
- PO (e.g. "112641 BW")
- Description (e.g. "WCTTR", "Takehara", "Downtown Tacoma Cleaners")
- Status — the exact text of the status badge (e.g. "Open", "Closed", "Cancelled", "Ganged", "In Production"). Copy it VERBATIM. Do NOT map unfamiliar statuses to a smaller set — if the badge says "Ganged", output "Ganged".
- Shipped date (e.g. "Apr 17, 2026")

Extract EVERY visible row in the table. Convert dates to ISO format YYYY-MM-DD (e.g. "Apr 17, 2026" → "2026-04-17"). Use null for any missing field.

Return ONLY valid JSON, no markdown fencing, no explanation.

If this isn't a Supacolor jobs list screenshot, return: { "error": "not_a_supacolor_jobs_list" }

JSON schema:
{
  "jobs": [
    {
      "supacolorJobNumber": "string",
      "poNumber": "string|null",
      "description": "string|null",
      "status": "string|null (the exact badge text — do NOT remap)",
      "dateShipped": "YYYY-MM-DD|null"
    }
  ]
}`;

// POST /api/vision/extract-supacolor-jobs-list
router.post('/extract-supacolor-jobs-list', async (req, res) => {
    const startTime = Date.now();
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ error: 'Missing image field. Send base64 data URI.' });

        let mediaType = 'image/png';
        let base64Data = image;
        if (image.startsWith('data:')) {
            const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
            if (!match) return res.status(400).json({ error: 'Invalid data URI format.' });
            mediaType = match[1];
            base64Data = match[2];
        }

        const client = getClient();
        const response = await client.messages.create({
            model: MODEL_ID,
            max_tokens: 4096,
            temperature: 0,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                    { type: 'text', text: SUPACOLOR_JOBS_LIST_PROMPT }
                ]
            }]
        });

        const responseText = response.content[0].text.trim();
        let extracted;
        try {
            const jsonStr = responseText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
            extracted = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error('[Vision] Failed to parse Supacolor jobs-list response:', responseText.substring(0, 200));
            return res.status(500).json({ error: 'Failed to parse extraction results', raw: responseText.substring(0, 500) });
        }

        if (extracted.error === 'not_a_supacolor_jobs_list') {
            return res.status(400).json({ success: false, error: 'This doesn\'t look like a Supacolor jobs list. Paste a screenshot from integrate.supacolor.com/dashboard/jobs.' });
        }

        const duration = Date.now() - startTime;
        const jobCount = (extracted.jobs || []).length;
        console.log(`[Vision] Supacolor jobs-list extraction: ${jobCount} jobs in ${duration}ms`);

        res.json({ success: true, data: extracted, duration });
    } catch (error) {
        console.error('[Vision] Supacolor jobs-list error:', error.message);
        res.status(500).json({ error: 'Vision extraction failed', details: error.message });
    }
});

// ── Supacolor JOB DETAIL (single job, full data) ────────────────────────

const SUPACOLOR_JOB_DETAIL_PROMPT = `You are extracting data from a screenshot of a single Supacolor JOB DETAIL page (integrate.supacolor.com/dashboard/jobs/{number}).

The screenshot has these sections:

1. **Header**: Job number (e.g. "#637351"), Status badge — the exact text shown (e.g. "Open", "Closed", "Cancelled", "Ganged", "In Production"). Copy it VERBATIM. Do NOT map unfamiliar statuses to a smaller set — if the badge says "Ganged", output "Ganged".

2. **Job Details card**: PO (e.g. "112641 BW"), Description (e.g. "WCTTR"), Location (e.g. "Los Angeles"), Created by (e.g. "Bradley Wright")

3. **Timeline**: Three dates — Entered, Requested Ship, Shipped (each in "MMM DD, YYYY" format)

4. **Joblines (N)**: A list of line items. Each row has:
   - Item code (e.g. "WE341568" for transfers, "SHIPPING" for shipping)
   - Description (e.g. "WCTTR - 11.7\\" FB Retro" or "Shipment 1 fedex")
   - Detail line below it (e.g. "Dark color fabric  11.7\\" wide x 5.85\\" high | WE_A4")
   - Color line (sometimes present, e.g. "Safety Yellow")
   - Right side: Line total (e.g. "$264.00") and "Qty × Unit" (e.g. "80 × $3.30")
   - For shipping rows, the detail line is the tracking number (e.g. "380598212133")

5. **Subtotal / Total** (currency at the bottom)

6. **Shipping panel**: Method (e.g. "2 Day Air"), Address block (multi-line), Contact name, Phone, Email, Tracking number

7. **History (N)**: A list of events. Each event has:
   - Event type (e.g. "Created", "Job Payment Success", "Job Dispatched")
   - Detail string (e.g. "Amount $531.20 paid with card Visa (xxxx-xxxx-xxxx-2562)")
   - Timestamp (e.g. "Apr 17, 2026  12:13 PM")

**CRITICAL EXTRACTION RULES:**

1. **Joblines: extract EVERY ROW visible in the Joblines section.** Even if the line has minimal data, include it. The header reads "Joblines (N)" — your output array MUST have exactly N items. If you see "Joblines (4)", return 4 joblines. If you see "Joblines (2)", return 2. Do NOT return an empty array unless the section is genuinely empty.

2. **History: extract EVERY ROW visible in the History section.** Same rule — header "History (N)" means N events. Common event types: "Created", "Job Payment Success", "Job Dispatched". Include even short events like "Created — Creator set via api".

3. **Job Details fields are at the top of the page.** "PO: 112641 BW", "Description: WCTTR" (large text), "Location: Los Angeles", "Created by Bradley Wright". Extract all four — they are short labels with values right next to them.

4. **Timeline dates** are three columns: Entered / Requested Ship / Shipped, each with a date below. If a step has no date filled, use null. The Shipped date is critical.

5. **Shipping panel** has Method (small text after "Shipping" header, e.g. "2 Day Air"), Address (multi-line block), Contact name/phone/email, and Tracking number (often a clickable blue link).

6. Convert dates to ISO format YYYY-MM-DD HH:MM:SS (24-hour). For dates without time, use 00:00:00. Apr 17, 2026 → 2026-04-17 00:00:00. "Apr 17, 2026  12:13 PM" → 2026-04-17 12:13:00.

7. For payment: extract from the History "Job Payment Success" event:
   - paymentStatus = "Paid" if Job Payment Success exists, else "Unpaid"
   - paymentMethod = the card description (e.g. "Visa xxxx-xxxx-xxxx-2562")

8. **Be aggressive about extraction. If you can READ a value on the page, EXTRACT it.** Returning null is only correct when the field is genuinely absent or illegible.

Return ONLY valid JSON, no markdown fencing.

If this isn't a Supacolor job detail page, return: { "error": "not_a_supacolor_job_detail" }

JSON schema:
{
  "supacolorJobNumber": "string",
  "poNumber": "string|null",
  "description": "string|null",
  "status": "Open|Closed|Cancelled|null",
  "location": "string|null",
  "createdByName": "string|null",
  "dateEntered": "YYYY-MM-DD HH:MM:SS|null",
  "requestedShipDate": "YYYY-MM-DD HH:MM:SS|null",
  "dateShipped": "YYYY-MM-DD HH:MM:SS|null",
  "subtotal": "number|null",
  "total": "number|null",
  "paymentStatus": "Paid|Unpaid|null",
  "paymentMethod": "string|null",
  "carrier": "string|null",
  "shippingMethod": "string|null",
  "trackingNumber": "string|null",
  "shipToName": "string|null",
  "shipToAddress": "string|null",
  "shipToContact": "string|null",
  "shipToPhone": "string|null",
  "shipToEmail": "string|null",
  "joblines": [
    {
      "lineOrder": "number",
      "lineType": "TRANSFER|SHIPPING|FEE",
      "itemCode": "string",
      "description": "string|null",
      "detailLine": "string|null",
      "color": "string|null",
      "quantity": "number|null",
      "unitPrice": "number|null",
      "lineTotal": "number|null"
    }
  ],
  "history": [
    {
      "eventType": "string",
      "eventDetail": "string|null",
      "eventAt": "YYYY-MM-DD HH:MM:SS|null"
    }
  ]
}`;

// POST /api/vision/extract-supacolor-job-detail
router.post('/extract-supacolor-job-detail', async (req, res) => {
    const startTime = Date.now();
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ error: 'Missing image field. Send base64 data URI.' });

        let mediaType = 'image/png';
        let base64Data = image;
        if (image.startsWith('data:')) {
            const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
            if (!match) return res.status(400).json({ error: 'Invalid data URI format.' });
            mediaType = match[1];
            base64Data = match[2];
        }

        const client = getClient();

        async function callVision(temperature) {
            const response = await client.messages.create({
                model: MODEL_ID,
                max_tokens: 4096,
                temperature,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                        { type: 'text', text: SUPACOLOR_JOB_DETAIL_PROMPT }
                    ]
                }]
            });
            return response.content[0].text.trim();
        }

        function parseJson(responseText) {
            const jsonStr = responseText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
            return JSON.parse(jsonStr);
        }

        function isThin(ext) {
            if (!ext || ext.error) return false;
            const noLines = !ext.joblines || ext.joblines.length === 0;
            const noHistory = !ext.history || ext.history.length === 0;
            // On a real Supacolor job detail page both joblines and history
            // are always present. If both are empty, Vision gave a lazy pass.
            return noLines && noHistory;
        }

        // Attempt ladder: temp=0 (fast, deterministic) then temp=0.8 twice
        // (fresh variance on thin retries — temp=0 retries are useless since
        // same input + same temperature = same output).
        const attempts = [
            { label: 'primary', temperature: 0 },
            { label: 'retry-1', temperature: 0.8 },
            { label: 'retry-2', temperature: 0.8 }
        ];

        let extracted = null;
        let lastParseError = null;
        let lastRawResponse = null;

        for (const attempt of attempts) {
            let responseText;
            try {
                responseText = await callVision(attempt.temperature);
                lastRawResponse = responseText;
            } catch (e) {
                console.error(`[Vision] ${attempt.label} call failed:`, e.message);
                continue;
            }
            let parsed;
            try {
                parsed = parseJson(responseText);
            } catch (parseError) {
                lastParseError = parseError;
                console.error(`[Vision] ${attempt.label} parse failed:`, responseText.substring(0, 200));
                continue;
            }
            if (!isThin(parsed)) {
                if (attempt.label !== 'primary') {
                    console.warn(`[Vision] Supacolor job-detail: ${attempt.label} recovered (thin primary)`);
                }
                extracted = parsed;
                break;
            }
            // thin — keep it as a fallback but keep trying
            extracted = parsed;
            console.warn(`[Vision] Supacolor job-detail: ${attempt.label} returned thin, continuing`);
        }

        if (!extracted) {
            console.error('[Vision] All Supacolor job-detail attempts failed');
            return res.status(500).json({ error: 'Failed to parse extraction results', raw: (lastRawResponse || '').substring(0, 500) });
        }

        if (extracted.error === 'not_a_supacolor_job_detail') {
            return res.status(400).json({ success: false, error: 'This doesn\'t look like a Supacolor job detail page. Paste a screenshot from integrate.supacolor.com/dashboard/jobs/{number}.' });
        }

        const duration = Date.now() - startTime;
        const lineCount = (extracted.joblines || []).length;
        const histCount = (extracted.history || []).length;
        console.log(`[Vision] Supacolor job-detail extraction in ${duration}ms — job: ${extracted.supacolorJobNumber || 'n/a'}, ${lineCount} lines, ${histCount} history events`);

        res.json({ success: true, data: extracted, duration });
    } catch (error) {
        console.error('[Vision] Supacolor job-detail error:', error.message);
        res.status(500).json({ error: 'Vision extraction failed', details: error.message });
    }
});

// ── Mockup info extraction (paste-links v3 modal) ─────────────────────
// Reads the structured info block at the bottom of Steve's mockup template.
// Fields: (Design#:) 39721  (Order#:)  (Sales Rep.) Nika
//         Customer Name: Asphalt Patch Systems
//         Garment Color & Style: DM130 Heathered Gray
//         Size & Placement: FF
//         Date: 4.21.26       Time: 3:41am
// Plus the transfer-type banner (DTF / DTG / EMB / SCP) above the block.

const MOCKUP_EXTRACTION_PROMPT = `You are extracting job info from a Northwest Custom Apparel mockup template.

The image shows a t-shirt (or similar garment) with artwork on it, and at the BOTTOM of the image there is a structured info block with labeled fields in this layout:

- Banner: a colored bar near the bottom containing JUST the transfer type in large white text (DTF, DTG, EMB, SCP, SS, or similar)
- "Customer Approved" checkbox
- "Files Prepaired for DTG & Digital Transfer" checkbox
- "(Design#:)" followed by a number like 39721
- "(Order#:)" followed by a number (may be empty)
- "(Sales Rep.)" followed by a first name (e.g. "Nika", "Ruth", "Taneisha")
- "Customer Name:" followed by the customer company
- "Garment Color & Style:" followed by a SanMar-style style+color (e.g. "DM130 Heathered Gray")
- "Size & Placement:" followed by a code like "FF" (Full Front), "FB" (Full Back), "LC" (Left Chest)
- "Date:" M.D.YY format and "Time:" H:MMam/pm

Extract each field exactly as it appears. Return ONLY valid JSON — no markdown fencing, no explanation.

Rules:
- If a field is empty or unreadable, return empty string (not null, not "N/A")
- For transfer_type, return just the code (e.g. "DTF", "DTG"), not the full name
- customer_approved / files_prepaired are booleans — true only if the checkbox is clearly checked
- Don't invent values; prefer empty string over guessing

JSON schema:
{
  "design_number": "",
  "order_number": "",
  "sales_rep": "",
  "customer_name": "",
  "garment_color_style": "",
  "size_placement": "",
  "transfer_type": "",
  "date": "",
  "time": "",
  "customer_approved": false,
  "files_prepaired": false
}`;

// Screen-print mockup prompt. Different from the Supacolor mockup template:
// no transfer-type banner; instead a "SCREEN PRINTING" / "SCREENPRINT" colored
// band followed by per-location ink charts with FLASH icons + screen/print
// totals. Bottom info bar layout matches Supacolor.
//
// Verified against two real samples (40091 Braun NW, 34278 Father Nature).
const MOCKUP_EXTRACTION_PROMPT_SCREENPRINT = `You are extracting job info from a Northwest Custom Apparel SCREEN PRINT mockup template.

The image shows garments (t-shirts, hoodies, long sleeves) with artwork on them. At the BOTTOM there is a structured info block with TWO sections:

SECTION 1 — A "SCREEN PRINTING" or "SCREENPRINT" colored band header. Below it: one or more rows. Each row is one print location with its ink chart. Row format:

  <LOCATION_CODE> <optional qualifier text> | INK COLOR (1.) <name> | [FLASH icon] | INK COLOR (2.) <name> | [FLASH icon] | INK COLOR (3.) <name> | ... | <N> Screens <N> Prints

Where:
- LOCATION_CODE is NWCA shorthand: LC=Left Chest, RC=Right Chest, FF=Full Front, FB=Full Back, LS=Left Sleeve, RS=Right Sleeve, BN=Back Neck, JN=Jumbo Neck.
- Optional qualifier is freeform text after the location code (e.g. "1 Color Hoodie") — preserve verbatim in the qualifier field.
- Each "INK COLOR (N.) <name>" pill shows one color in print order. Capture the color name VERBATIM ("White", "PMS 383", "Safety Yellow"). NEVER guess PMS codes from visual color.
- A "FLASH" lightning-bolt icon between two ink pills means a flash-dry step before the next color prints. Count total flashes per row.
- "<N> Screens" / "<N> Prints" on the right edge of a row are PER-ROW totals when present.
- The artist sometimes mis-numbers ink columns (e.g. two columns both labeled "(3.)"). Count pills by VISUAL POSITION, not by the printed number.

Below the location rows, sometimes there is a single GLOBAL totals line like:
  "(N) Screens  (N) Prints  (N) Flashes"
Capture this if present; otherwise leave global totals as null.

SECTION 2 — Bottom info bar (always present, most reliable):
- "Design #:" or "(Design#:)" → numeric ID
- "Order #:" or "(Order#:)" → freeform text (may be number, "Mock1", or empty)
- "Sales Rep:" or "(Sales Rep.)" → first name
- "Customer Name:" → company
- "Garment Color & Style:" → e.g. "PC450 Team Navy", "Chocolate Brown Tees & Hoodies"
- "Size & Placement:" → location codes (e.g. "LC, FB" or "FF, FB  LC")
- "Date:" M.D.YY format and "Time:" H:MMam/pm

Trust the bottom info bar over inferring from visual mockup illustrations.

Return ONLY valid JSON — no markdown fencing, no explanation.

Rules:
- Empty/unreadable scalar fields → empty string (not null, not "N/A")
- Empty locations → empty array
- Capture ink color labels EXACTLY as written (preserve "PMS" prefix, casing)
- flashes per row = count of FLASH icons in that row's ink chart
- screens/prints per row → integer when shown, null when absent
- Global totals only set when a "(N) Screens (N) Prints (N) Flashes" line is visible below all rows

JSON schema:
{
  "design_number": "",
  "order_number": "",
  "sales_rep": "",
  "customer_name": "",
  "garment_color_style": "",
  "size_placement": "",
  "date": "",
  "time": "",
  "screen_print": {
    "locations": [
      {
        "code": "FF",
        "label": "Full Front",
        "qualifier": "",
        "colors": ["White", "White", "PMS 383", "PMS 434"],
        "flashes": 3,
        "screens": 3,
        "prints": 4
      }
    ],
    "screens": null,
    "prints": null,
    "flashes": null
  }
}`;

// In-memory cache: fileId → extraction result. 1hr TTL.
const MOCKUP_VISION_CACHE = new Map();
const MOCKUP_VISION_TTL_MS = 60 * 60 * 1000;
const MOCKUP_VISION_MAX = 100;
function mockupCacheGet(k) {
    const e = MOCKUP_VISION_CACHE.get(k);
    if (!e) return null;
    if (Date.now() - e.t > MOCKUP_VISION_TTL_MS) { MOCKUP_VISION_CACHE.delete(k); return null; }
    return e.v;
}
function mockupCacheSet(k, v) {
    if (MOCKUP_VISION_CACHE.size >= MOCKUP_VISION_MAX) {
        const firstKey = MOCKUP_VISION_CACHE.keys().next().value;
        if (firstKey) MOCKUP_VISION_CACHE.delete(firstKey);
    }
    MOCKUP_VISION_CACHE.set(k, { v, t: Date.now() });
}

/**
 * Normalize the raw screen_print extraction into our canonical shape.
 * Defensive: drops malformed locations, coerces ints/strings safely.
 */
function normalizeScreenPrint(sp) {
    if (!sp || typeof sp !== 'object') return null;
    const locsRaw = Array.isArray(sp.locations) ? sp.locations : [];
    const locations = locsRaw.map(function (loc) {
        if (!loc || typeof loc !== 'object') return null;
        const colors = Array.isArray(loc.colors)
            ? loc.colors.map(function (c) { return String(c || '').trim(); }).filter(Boolean)
            : [];
        const intOrNull = function (v) {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : null;
        };
        return {
            code: String(loc.code || '').trim(),
            label: String(loc.label || '').trim(),
            qualifier: String(loc.qualifier || '').trim(),
            colors: colors,
            flashes: intOrNull(loc.flashes),
            screens: intOrNull(loc.screens),
            prints: intOrNull(loc.prints)
        };
    }).filter(function (l) { return l && l.code; });

    const intOrNull = function (v) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : null;
    };
    return {
        locations: locations,
        screens: intOrNull(sp.screens),
        prints: intOrNull(sp.prints),
        flashes: intOrNull(sp.flashes)
    };
}

/**
 * Core mockup-info extraction — reusable from both the /extract-mockup-info
 * HTTP route AND from other routes (e.g. /analyze-link) that want mockup data
 * without an extra network hop.
 *
 * @param {Buffer} bytes - full image bytes
 * @param {string} mediaType - e.g. "image/jpeg", "image/png"
 * @param {string} [cacheKey] - if provided, caches result under this key.
 *                             NOTE: caller should append method to cacheKey when
 *                             method is non-default, otherwise SP and Supacolor
 *                             results will collide for the same fileId.
 * @param {string} [method='Supacolor'] - 'Supacolor' (default) or 'Screen Print'.
 *                             Drives prompt selection + output schema.
 * @returns {Promise<object>} normalized result. Supacolor returns 11-field shape;
 *                            Screen Print returns the 8 base fields + screen_print block.
 */
async function extractMockupInfo(bytes, mediaType, cacheKey, method) {
    method = method === 'Screen Print' ? 'Screen Print' : 'Supacolor';

    // Cache namespacing — same fileId can yield different extractions per method.
    const fullCacheKey = cacheKey ? `${method}|${cacheKey}` : null;
    if (fullCacheKey) {
        const cached = mockupCacheGet(fullCacheKey);
        if (cached) return { ...cached, _cached: true };
    }

    const prompt = method === 'Screen Print' ? MOCKUP_EXTRACTION_PROMPT_SCREENPRINT : MOCKUP_EXTRACTION_PROMPT;
    // SP prompt returns more structured data — bump max tokens to fit a 5-location ink chart.
    const maxTokens = method === 'Screen Print' ? 1024 : 512;

    const base64Data = bytes.toString('base64');
    const client = getClient();
    const response = await client.messages.create({
        model: MODEL_ID,
        max_tokens: maxTokens,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                { type: 'text', text: prompt }
            ]
        }]
    });

    const responseText = (response.content[0] && response.content[0].text || '').trim();
    const jsonStr = responseText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const extracted = JSON.parse(jsonStr); // throws on bad JSON; caller handles

    let data;
    if (method === 'Screen Print') {
        data = {
            design_number: String(extracted.design_number || ''),
            order_number: String(extracted.order_number || ''),
            sales_rep: String(extracted.sales_rep || ''),
            customer_name: String(extracted.customer_name || ''),
            garment_color_style: String(extracted.garment_color_style || ''),
            size_placement: String(extracted.size_placement || ''),
            date: String(extracted.date || ''),
            time: String(extracted.time || ''),
            // SP-specific: ink chart per location + optional global totals.
            screen_print: normalizeScreenPrint(extracted.screen_print),
            // Legacy fields kept null so callers reading both shapes don't crash.
            transfer_type: '',
            customer_approved: false,
            files_prepaired: false
        };
    } else {
        data = {
            design_number: String(extracted.design_number || ''),
            order_number: String(extracted.order_number || ''),
            sales_rep: String(extracted.sales_rep || ''),
            customer_name: String(extracted.customer_name || ''),
            garment_color_style: String(extracted.garment_color_style || ''),
            size_placement: String(extracted.size_placement || ''),
            transfer_type: String(extracted.transfer_type || '').toUpperCase(),
            date: String(extracted.date || ''),
            time: String(extracted.time || ''),
            customer_approved: !!extracted.customer_approved,
            files_prepaired: !!extracted.files_prepaired,
            screen_print: null
        };
    }

    if (fullCacheKey) mockupCacheSet(fullCacheKey, data);
    return data;
}

function mediaTypeFromExtension(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === 'png') return 'image/png';
    if (e === 'webp') return 'image/webp';
    if (e === 'gif') return 'image/gif';
    return 'image/jpeg'; // jpg/jpeg + unknown fallback
}

/**
 * POST /api/vision/extract-mockup-info
 *
 * Input (one of):
 *   { fileId: "1815321", sharedLink?: "https://...box.com/s/abc" }   — preferred
 *   { imageBase64: "data:image/jpeg;base64,..." }                     — fallback
 *
 * Returns:
 *   { success: true, data: {11 structured fields}, durationMs, cached, fileId? }
 */
router.post('/extract-mockup-info', async (req, res) => {
    const startTime = Date.now();
    const { fileId, sharedLink, imageBase64 } = req.body || {};

    if (!fileId && !imageBase64) {
        return res.status(400).json({
            success: false,
            error: 'Missing fileId or imageBase64'
        });
    }

    try {
        let bytes;
        let mediaType;
        let cacheKey = null;

        if (fileId) {
            cacheKey = `file:${fileId}`;
            const [info, fetched] = await Promise.all([
                boxGetFileInfo(fileId, ['name', 'extension'], sharedLink),
                boxFetchFileBytes(fileId, { sharedLink })
            ]);
            bytes = fetched;
            mediaType = mediaTypeFromExtension(info.extension);
        } else {
            if (imageBase64.startsWith('data:')) {
                const m = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
                if (!m) return res.status(400).json({ success: false, error: 'Invalid data URI' });
                mediaType = m[1];
                bytes = Buffer.from(m[2], 'base64');
            } else {
                mediaType = 'image/jpeg';
                bytes = Buffer.from(imageBase64, 'base64');
            }
        }

        const data = await extractMockupInfo(bytes, mediaType, cacheKey);
        const duration = Date.now() - startTime;
        console.log(`[Vision mockup] ${fileId || 'base64'} → rep=${data.sales_rep}, type=${data.transfer_type}, ${duration}ms${data._cached ? ' (cached)' : ''}`);

        res.json({
            success: true,
            data,
            durationMs: duration,
            cached: !!data._cached,
            fileId: fileId || null
        });

    } catch (error) {
        console.error('[Vision mockup] error:', error.response ? JSON.stringify(error.response.data) : error.message);
        const status = error instanceof SyntaxError ? 502 : 500;
        res.status(status).json({
            success: false,
            error: 'Mockup vision extraction failed: ' + (error.message || 'unknown')
        });
    }
});

module.exports = router;
// Exported helper for in-process reuse from analyze-link (avoids loopback HTTP)
module.exports.extractMockupInfo = extractMockupInfo;
module.exports.mediaTypeFromExtension = mediaTypeFromExtension;
