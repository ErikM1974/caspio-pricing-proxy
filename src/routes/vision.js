// Vision Routes — ShopWorks screenshot extraction via Claude Haiku
// Accepts base64 image, extracts customer/order/design/garment data

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

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

module.exports = router;
