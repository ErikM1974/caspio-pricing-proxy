// Read a 253gear mockup: what the artwork says, what it depicts, and draft SEO.
//
// WHY NOT REUSE src/utils/mockup-vision.js. That module does extract exactly the
// fields wanted here — `design_text` ("all text visible on the design"),
// `design_description`, `design_colors` — but it UNCONDITIONALLY persists an analysis
// row to Mockup_AI_Analysis keyed on an art-request Design_ID, plus child rows in
// Mockup_Print_Locations. A 253gear design has no art request, so those writes would
// be orphan rows against a foreign key that means nothing, and they would spend Caspio
// quota on every classification. Same prompt shape, no persistence, narrower ask.
//
// Buffer in, JSON out. The caller fetches the bytes and decides what to do with the
// answer; nothing here writes anything or reaches a storefront.

'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');

const MODEL_ID = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;

let client = null;
function getClient() {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
        client = new Anthropic({ apiKey });
    }
    return client;
}

/**
 * The prompt is deliberately narrow.
 *
 * `design_text` is the load-bearing field: most 253gear designs print the place name,
 * and a string match on it settles the collection deterministically with a reason a
 * person can check. Everything else is a suggestion.
 *
 * The city guess is constrained to the live collection vocabulary and REQUIRED to
 * carry a reason. An unconstrained guess produces plausible names like "Lakewood"
 * that no collection files on, which looks like success and files nothing.
 */
function buildPrompt(vocabulary, designName) {
    const list = (vocabulary || []).join(', ') || '(none configured)';
    return `You are reading a product mockup photo for 253gear.com — a store selling
South Sound (Washington) city and landmark apparel.

Extract what you can SEE. Do not infer local history, and do not invent facts.

Return ONLY valid JSON, no markdown fencing:

{
  "design_text": "every word visible in the ARTWORK, comma-separated. '' if none.",
  "design_description": "one or two sentences describing the artwork itself — subject, style, era feel. Not the garment.",
  "design_colors": "colors used in the artwork, comma-separated",
  "city": "one of: ${list} — or null if you cannot tell",
  "city_confidence": "high | medium | low",
  "city_reason": "why that city. Cite what you SAW. Required whenever city is not null.",
  "seo_title": "<=60 chars, descriptive, no clickbait",
  "seo_description": "<=155 chars, plain description of the design and that it is printed to order in Milton, WA",
  "alt_text": "one sentence describing the DESIGN, not the garment"
}

RULES:
- "city" MUST be one of the listed values verbatim, or null. Never invent a place name.
- If the artwork does not clearly indicate a place, set city to null. A null is a
  correct answer; a plausible guess is not.
- Never state that a business is closed, historic, or gone. You cannot see that.
- Never describe fabric, weight or garment construction.
${designName ? `\nThe designer named this design: "${designName}". Treat that as a hint, not a fact.` : ''}`;
}

function parseJsonish(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Last resort: the first balanced-looking object in the reply.
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
        }
        const err = new Error('Vision model did not return usable JSON');
        err.code = 'VISION_BAD_JSON';
        err.raw = cleaned.slice(0, 400);
        throw err;
    }
}

/**
 * @param imageBuffer Buffer of the hero mockup
 * @param mimeType    e.g. 'image/jpeg'
 * @param opts        { vocabulary: string[], designName?: string }
 * @returns { design_text, design_description, design_colors, city, city_confidence,
 *            city_reason, seo_title, seo_description, alt_text }
 */
async function analyzeDesign(imageBuffer, mimeType, opts = {}) {
    const mediaType = mimeType || 'image/jpeg';
    if (!String(mediaType).startsWith('image/')) {
        const err = new Error(`Not an image: ${mediaType}`);
        err.code = 'NOT_AN_IMAGE';
        throw err;
    }

    const response = await getClient().messages.create({
        model: MODEL_ID,
        max_tokens: MAX_TOKENS,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') } },
                { type: 'text', text: buildPrompt(opts.vocabulary, opts.designName) }
            ]
        }]
    });

    const block = (response.content || []).find((c) => c.type === 'text');
    const extracted = parseJsonish(block && block.text);

    // Normalise so downstream code never has to defend against a missing key.
    return {
        design_text: String(extracted.design_text || ''),
        design_description: String(extracted.design_description || ''),
        design_colors: String(extracted.design_colors || ''),
        city: extracted.city === null || extracted.city === undefined ? null : String(extracted.city).trim(),
        city_confidence: String(extracted.city_confidence || 'low'),
        city_reason: String(extracted.city_reason || ''),
        seo_title: String(extracted.seo_title || ''),
        seo_description: String(extracted.seo_description || ''),
        alt_text: String(extracted.alt_text || ''),
        model: MODEL_ID
    };
}

module.exports = { analyzeDesign, buildPrompt, parseJsonish, MODEL_ID };
