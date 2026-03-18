// Mockup Vision Analysis — Claude Haiku 4.5 image extraction
// Reads Steve's mockup images and extracts production metadata + design descriptions
// Fire-and-forget: failures are logged but never block the upload flow

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const config = require('../config');

const ANALYSIS_TABLE = 'Mockup_AI_Analysis';
const MODEL_ID = 'claude-haiku-4-5-20251001';

// Lazy-init Anthropic client (only when first needed)
let anthropicClient = null;
function getClient() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
        anthropicClient = new Anthropic({ apiKey });
    }
    return anthropicClient;
}

// Caspio token helper (reuse from caspio.js)
const { getCaspioAccessToken, makeCaspioRequest } = require('./caspio');

const VISION_PROMPT = `Analyze this apparel mockup image. This is a production mockup created by a custom apparel company.

TASK 1 — Extract the TEXT TEMPLATE at the bottom of the image (if present). Look for a structured info block with fields like:
- Design # (number)
- Order # (number, may be blank)
- Sales Rep name
- Customer Name
- Garment Color & Style (e.g., "29ls Black", "PC54 Red")
- Size & Placement (e.g., "LC" for left chest, "FB" for full back, "5 inch left chest")
- Method label (DTF, DTG, Embroidery, Screen Print)
- Date and Time
- Customer Approved (checkbox — checked or unchecked)
- Files Prepared for DTG & Digital Transfer (checkbox — checked or unchecked)

If there is no text template at the bottom, set all template fields to null.

TASK 2 — Analyze the DESIGN ARTWORK on the garment:
- Describe the design (what it depicts, style, layout)
- List all readable text ON the design itself (logo text, slogans, etc.)
- List the colors used in the design artwork

Return ONLY valid JSON (no markdown, no backticks):
{
  "design_number": "string or null",
  "order_number": "string or null",
  "sales_rep": "string or null",
  "customer_name": "string or null",
  "garment_info": "string or null",
  "method": "string or null",
  "placement": "string or null",
  "size": "string or null",
  "date": "string or null",
  "time": "string or null",
  "customer_approved": "Yes/No/null",
  "files_prepared": "Yes/No/null",
  "design_description": "string",
  "design_text": "string — all text visible on the design, comma-separated",
  "design_colors": "string — colors in the artwork, comma-separated"
}`;

/**
 * Analyze a mockup image using Claude Haiku vision
 * @param {Buffer} imageBuffer - Raw image file buffer from multer
 * @param {string} mimeType - Image MIME type (image/jpeg, image/png, etc.)
 * @param {Object} metadata - { designId, slotField, imageUrl }
 * @returns {Object|null} Analysis result or null on failure
 */
async function analyzeMockupImage(imageBuffer, mimeType, metadata) {
    const startTime = Date.now();
    const { designId, slotField, imageUrl } = metadata;

    console.log(`[Vision] Starting analysis for Design #${designId}, slot: ${slotField}`);

    try {
        // Convert buffer to base64
        const base64Image = imageBuffer.toString('base64');
        const mediaType = mimeType || 'image/jpeg';

        // Only analyze image types (skip PDFs, etc.)
        if (!mediaType.startsWith('image/')) {
            console.log(`[Vision] Skipping non-image file: ${mediaType}`);
            return null;
        }

        const client = getClient();

        // Call Claude Haiku with the image
        const response = await client.messages.create({
            model: MODEL_ID,
            max_tokens: 1500,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: base64Image
                        }
                    },
                    {
                        type: 'text',
                        text: VISION_PROMPT
                    }
                ]
            }]
        });

        // Parse the response
        const responseText = response.content[0].text;
        let extracted;
        try {
            // Try to parse as JSON directly
            extracted = JSON.parse(responseText);
        } catch (parseErr) {
            // Try to extract JSON from markdown code block
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                extracted = JSON.parse(jsonMatch[0]);
            } else {
                console.error('[Vision] Failed to parse response:', responseText.substring(0, 200));
                return null;
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`[Vision] Extraction complete in ${elapsed}ms for Design #${designId}`);
        console.log(`[Vision] Extracted: Design#=${extracted.design_number}, Method=${extracted.method}, Customer=${extracted.customer_name}`);

        // Validate Design # against the art request
        let validationStatus = 'Pass';
        let validationNotes = '';

        if (extracted.design_number && String(extracted.design_number) !== String(designId)) {
            validationStatus = 'Warning';
            validationNotes = `Design # mismatch: mockup says "${extracted.design_number}" but art request is "${designId}"`;
            console.warn(`[Vision] ${validationNotes}`);
        }

        // Save to Caspio
        const analysisRecord = {
            Design_ID: String(designId),
            Mockup_Slot: slotField || '',
            Image_URL: imageUrl || '',
            Extracted_Design_Number: extracted.design_number || '',
            Extracted_Order_Number: extracted.order_number || '',
            Extracted_Sales_Rep: extracted.sales_rep || '',
            Extracted_Customer_Name: extracted.customer_name || '',
            Extracted_Garment_Info: extracted.garment_info || '',
            Extracted_Method: extracted.method || '',
            Extracted_Placement: extracted.placement || '',
            Extracted_Size: extracted.size || '',
            Extracted_Date: extracted.date || '',
            Extracted_Time: extracted.time || '',
            Customer_Approved: extracted.customer_approved || '',
            Files_Prepared: extracted.files_prepared || '',
            Design_Description: (extracted.design_description || '').substring(0, 64000),
            Design_Colors: (extracted.design_colors || '').substring(0, 500),
            Design_Text: (extracted.design_text || '').substring(0, 500),
            Validation_Status: validationStatus,
            Validation_Notes: validationNotes,
            Analysis_Date: new Date().toISOString(),
            Model_Used: MODEL_ID
        };

        await makeCaspioRequest('post', `/tables/${ANALYSIS_TABLE}/records`, {}, analysisRecord);
        console.log(`[Vision] Saved analysis to Caspio for Design #${designId} (${elapsed}ms)`);

        return analysisRecord;

    } catch (err) {
        const elapsed = Date.now() - startTime;
        console.error(`[Vision] Analysis failed for Design #${designId} after ${elapsed}ms:`, err.message);
        return null;
    }
}

module.exports = { analyzeMockupImage };
