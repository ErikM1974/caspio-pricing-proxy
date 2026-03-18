// Mockup Vision Analysis — Claude Haiku 4.5 image extraction
// Reads Steve's mockup images and extracts production metadata + design descriptions
// Supports DTG, DTF, Embroidery AND Screen Print mockups (ink colors, print order, screens)
// Fire-and-forget: failures are logged but never block the upload flow

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const ANALYSIS_TABLE = 'Mockup_AI_Analysis';
const PRINT_LOCATIONS_TABLE = 'Mockup_Print_Locations';
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

// Caspio helper (reuse from caspio.js)
const { makeCaspioRequest } = require('./caspio');

const VISION_PROMPT = `Analyze this apparel mockup image. This is a production mockup created by a custom apparel company.

TASK 1 — Extract the TEXT TEMPLATE at the bottom of the image (if present). Look for a structured info block with fields like:
- Design # (number)
- Order # (number, may be blank)
- Sales Rep name
- Customer Name
- Garment Color & Style (e.g., "29ls Black", "PC54 Red")
- Size & Placement (e.g., "LC" for left chest, "FB" for full back, "5 inch left chest")
- Method label (DTF, DTG, Embroidery, Screen Print, Screenprint)
- Date and Time
- Customer Approved (checkbox — checked or unchecked)
- Files Prepared for DTG & Digital Transfer (checkbox — checked or unchecked)

If there is no text template at the bottom, set all template fields to null.

TASK 2 — Analyze the DESIGN ARTWORK on the garment:
- Describe the design (what it depicts, style, layout)
- List all readable text ON the design itself (logo text, slogans, etc.)
- List the colors used IN THE DESIGN ARTWORK ONLY (NOT the garment/shirt color, NOT the ink color names from the print order section — only the visible colors you see in the actual logo/graphic design itself)

TASK 3 — SCREEN PRINT INK DATA (critical — look carefully):
If the method is Screen Print / Screenprint, look for ink color information. This may appear in different layouts:

FORMAT A (newer): Rows organized by placement (FF, FB, LC, etc.) with numbered ink colors:
  FF: INK COLOR (1) White, INK COLOR (2) White, INK COLOR (3) Reflective
  FB: INK COLOR (1) White, INK COLOR (2) White, INK COLOR (3) Reflective
  Summary: (4) Screens (6) Prints (4) Flashes

FORMAT B (older): Print order grid on the right side with numbered thread/ink colors and FLASH markers:
  THREAD COLOR (1.) White, FLASH, (2.) White, (3.) Metallic Silver, FLASH, (4.) Red, (5.) Yellow
  Total # of Screens: 5
  Placement counts listed separately

FORMAT C: Per-placement rows with ink colors, screens count, and prints count:
  FF: INK COLOR (1.) White, (2.) White, FLASH, (3.) PMS 383, INK COLOR (3.) PMS 434 — 3 Screens, 4 Prints
  FB: INK COLOR (1.) White, (2.) White, FLASH, (3.) PMS 383, INK COLOR (3.) PMS 434 — 3 Screens, 4 Prints
  LC: INK COLOR (1.) White, (2.) White, (3.) PMS 383

For EACH print location found, extract:
- placement: the location code (FF, FB, LC, RC, LS, RS, etc.)
- ink_colors: ordered list of ink color names for that location
- num_colors: count of unique ink colors
- screens: number of screens for that location (if shown)
- prints: number of prints for that location (if shown)
- flashes: number of flashes for that location (if shown)
- pms_colors: any PMS color codes (e.g., "PMS 383", "PMS 434")
- has_flash: whether flashes are used between colors
- print_order: the full print order text as shown (e.g., "(1) White, (2) White, FLASH, (3) Reflective")

Also extract totals:
- total_screens, total_prints, total_flashes (from summary line if present)
- has_reflective: Yes/No (any reflective ink used)
- has_metallic: Yes/No (any metallic ink used)
- pms_colors_all: all PMS codes found across all locations

If the method is NOT Screen Print, set all screen print fields to null.

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
  "design_colors": "string — colors in the artwork, comma-separated",
  "print_locations": [
    {
      "placement": "FF",
      "ink_colors": "White, White, Reflective",
      "num_colors": 3,
      "screens": "3",
      "prints": "4",
      "flashes": "2",
      "pms_colors": "",
      "has_flash": "Yes",
      "print_order": "(1) White, (2) White, FLASH, (3) Reflective"
    }
  ],
  "total_screens": "string or null",
  "total_prints": "string or null",
  "total_flashes": "string or null",
  "has_reflective": "Yes/No/null",
  "has_metallic": "Yes/No/null",
  "pms_colors_all": "string or null"
}

If there are no print locations (non-screen-print method), set print_locations to an empty array [].`;

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
            max_tokens: 2500,
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
            extracted = JSON.parse(responseText);
        } catch (parseErr) {
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

        // Clean up old analysis + print locations for this Design_ID + slot before inserting new
        try {
            const oldRecords = await makeCaspioRequest('get', `/tables/${ANALYSIS_TABLE}/records`, {
                'q.where': `Design_ID='${designId}' AND Mockup_Slot='${slotField}'`,
                'q.select': 'PK_ID'
            });
            const oldAnalyses = (oldRecords && oldRecords.Result) || [];
            for (const old of oldAnalyses) {
                // Delete child print locations first
                try {
                    const oldLocs = await makeCaspioRequest('get', `/tables/${PRINT_LOCATIONS_TABLE}/records`, {
                        'q.where': `Analysis_ID='${old.PK_ID}'`,
                        'q.select': 'PK_ID'
                    });
                    const locRecords = (oldLocs && oldLocs.Result) || [];
                    for (const loc of locRecords) {
                        await makeCaspioRequest('delete', `/tables/${PRINT_LOCATIONS_TABLE}/records`, { 'q.where': `PK_ID=${loc.PK_ID}` });
                    }
                } catch (e) { /* ignore */ }
                // Also clean up fallback-format Analysis_IDs in print locations
                try {
                    const fallbackLocs = await makeCaspioRequest('get', `/tables/${PRINT_LOCATIONS_TABLE}/records`, {
                        'q.where': `Design_ID='${designId}' AND Mockup_Slot='${slotField}'`,
                        'q.select': 'PK_ID'
                    });
                    const fbRecords = (fallbackLocs && fallbackLocs.Result) || [];
                    for (const loc of fbRecords) {
                        await makeCaspioRequest('delete', `/tables/${PRINT_LOCATIONS_TABLE}/records`, { 'q.where': `PK_ID=${loc.PK_ID}` });
                    }
                } catch (e) { /* ignore */ }
                // Delete old parent
                await makeCaspioRequest('delete', `/tables/${ANALYSIS_TABLE}/records`, { 'q.where': `PK_ID=${old.PK_ID}` });
            }
            if (oldAnalyses.length > 0) {
                console.log(`[Vision] Cleaned up ${oldAnalyses.length} old analysis record(s) for Design #${designId} slot ${slotField}`);
            }
        } catch (cleanupErr) {
            console.warn('[Vision] Cleanup of old records failed (non-blocking):', cleanupErr.message);
        }

        // Save parent record to Mockup_AI_Analysis
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
            Model_Used: MODEL_ID,
            // Screen print summary fields
            Total_Screens: extracted.total_screens || '',
            Total_Prints: extracted.total_prints || '',
            Total_Flashes: extracted.total_flashes || '',
            Has_Reflective: extracted.has_reflective || '',
            Has_Metallic: extracted.has_metallic || '',
            PMS_Colors: extracted.pms_colors_all || ''
        };

        const parentResult = await makeCaspioRequest('post', `/tables/${ANALYSIS_TABLE}/records`, {}, analysisRecord);
        console.log(`[Vision] Saved parent analysis to Caspio for Design #${designId} (${elapsed}ms)`);

        // Get the parent PK_ID for linking child records
        var parentId = '';
        if (parentResult && parentResult.Result && parentResult.Result.PK_ID) {
            parentId = String(parentResult.Result.PK_ID);
        } else {
            // Fallback: use designId + timestamp as a unique key
            parentId = designId + '_' + Date.now();
        }

        // Save child records to Mockup_Print_Locations (if screen print)
        const locations = extracted.print_locations || [];
        if (locations.length > 0) {
            console.log(`[Vision] Saving ${locations.length} print location(s) for Design #${designId}`);
            for (const loc of locations) {
                try {
                    const locationRecord = {
                        Analysis_ID: parentId,
                        Design_ID: String(designId),
                        Mockup_Slot: slotField || '',
                        Placement: (loc.placement || '').substring(0, 255),
                        Ink_Colors: (loc.ink_colors || '').substring(0, 255),
                        Num_Colors: String(loc.num_colors || ''),
                        Screens: (loc.screens || '').toString(),
                        Prints: (loc.prints || '').toString(),
                        Flashes: (loc.flashes || '').toString(),
                        PMS_Colors: (loc.pms_colors || '').substring(0, 255),
                        Has_Flash: loc.has_flash || '',
                        Print_Order: (loc.print_order || '').substring(0, 255)
                    };
                    await makeCaspioRequest('post', `/tables/${PRINT_LOCATIONS_TABLE}/records`, {}, locationRecord);
                    console.log(`[Vision]   → Saved location: ${loc.placement} (${loc.ink_colors})`);
                } catch (locErr) {
                    console.warn(`[Vision]   → Failed to save location ${loc.placement}:`, locErr.message);
                }
            }
        }

        return analysisRecord;

    } catch (err) {
        const elapsed = Date.now() - startTime;
        console.error(`[Vision] Analysis failed for Design #${designId} after ${elapsed}ms:`, err.message);
        return null;
    }
}

/**
 * Analyze a mockup from a URL (for Box picker uploads where we don't have the buffer)
 * Downloads the image first, then runs vision analysis
 * @param {string} imageUrl - Box shared link or download URL
 * @param {Object} metadata - { designId, slotField }
 */
async function analyzeMockupFromUrl(imageUrl, metadata) {
    const { designId, slotField } = metadata;
    console.log(`[Vision] Downloading image for Design #${designId} from URL...`);

    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': 'NWCA-Art-System/1.0' }
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || 'image/jpeg';

        if (!contentType.startsWith('image/')) {
            console.log(`[Vision] Skipping non-image URL: ${contentType}`);
            return null;
        }

        console.log(`[Vision] Downloaded ${(buffer.length / 1024).toFixed(1)} KB, type: ${contentType}`);

        return await analyzeMockupImage(buffer, contentType, {
            designId,
            slotField,
            imageUrl
        });

    } catch (err) {
        console.error(`[Vision] URL download failed for Design #${designId}:`, err.message);
        return null;
    }
}

module.exports = { analyzeMockupImage, analyzeMockupFromUrl };
