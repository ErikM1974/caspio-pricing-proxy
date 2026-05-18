// Contract DTG Quote AI — quote drafting + Q&A assistant.
// Streams Claude responses (SSE) for the chat panel on the DTG quote
// builder (/quote-builders/dtg-quote-builder.html).
//
// Mirrors contract-webstore-ai.js / contract-emblem-ai.js / contract-sticker-ai.js
// pattern. Single product mode (DTG retail). 4 tools: lookup_customer,
// quote_dtg_pricing, recommend_top_sellers, web_search. ShopWorks push is
// FRONTEND-driven (button POSTs to /api/submit-order-form directly) — not
// a bot tool. Prompt teaches the bot to collect designNumber.
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {                       // OPTIONAL
//       quoteID: 'DTG-2026-007' | null
//     }
//   }
//
// Response: text/event-stream
//   event: delta        data: { text: "..." }
//   event: tool_result  data: { tool: "...", result: {...} }
//   event: done         data: { stop_reason, usage }
//   event: error        data: { message }

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { CONTRACT_DTG_QUOTE_AI_SYSTEM_PROMPT } = require('../../lib/dtg-quote-ai-prompt');
const { recommendTopSellers, DTG_CURATED_PRODUCTS } = require('../../lib/dtg-curated-products');
const { webSearch } = require('../../lib/web-search');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// DTG pricing math now lives ENTIRELY in lib/dtg-canonical-pricing.js.
// We only keep the location code list here for the tool schema enum.
const STANDARD_LOCATIONS = ['LC', 'FF', 'JF', 'FB', 'JB'];
const COMBO_LOCATIONS = ['LC_FB', 'FF_FB', 'JF_JB', 'LC_JB'];
const ALL_LOCATION_CODES = [...STANDARD_LOCATIONS, ...COMBO_LOCATIONS];

const LOCATION_LABELS = {
    LC: 'Left Chest',
    FF: 'Full Front',
    JF: 'Jumbo Front',
    FB: 'Full Back',
    JB: 'Jumbo Back',
    LC_FB: 'Left Chest + Full Back',
    FF_FB: 'Full Front + Full Back',
    JF_JB: 'Jumbo Front + Jumbo Back',
    LC_JB: 'Left Chest + Jumbo Back',
};

const TOOLS = [
    {
        name: 'lookup_customer',
        description:
            "Search the NWCA customer/contact database for a company or contact. " +
            "Use this whenever the user mentions a customer by company name OR contact name. " +
            "Returns up to 5 matches with company, contact name, email, service rep, " +
            "and last-ordered date. Pass the most distinctive phrase (e.g. 'Acme Fuel' " +
            "or 'Allison Dumas' or an email fragment).",
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search term — company name, contact name, or email fragment. 3+ chars.',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'quote_dtg_pricing',
        description:
            "Price a DTG order. ALL lines in one quote share ONE imprint (locationCode) — the " +
            "tier and LTM are calculated from the COMBINED quantity across every line (every " +
            "style + color + size combo). NEVER split a multi-style order into multiple tool " +
            "calls — that would mis-price by hitting a higher tier on each one. " +
            "Single-style call: provide styleNumber + color + sizes at the top level. " +
            "Multi-style call: provide a `lines` array; each element has its own " +
            "{styleNumber, color, sizes}; the locationCode is shared across all lines. " +
            "Pulls live pricing from /api/dtg/product-bundle for each unique style, applies the " +
            "tier (1-23 LTM / 24-47 / 48-71 / 72+) from the combined qty, distributes LTM under " +
            "24 with Math.floor, and returns per-line + per-size pricing with size upcharges. " +
            "Locations: LC, FF, JF (front singles), FB, JB (back singles), LC_FB, FF_FB, " +
            "JF_JB, LC_JB (front+back combos).",
        input_schema: {
            type: 'object',
            properties: {
                locationCode: {
                    type: 'string',
                    enum: ALL_LOCATION_CODES,
                    description: 'Print location code (shared across ALL lines). Single: LC/FF/JF/FB/JB. Combo: LC_FB/FF_FB/JF_JB/LC_JB.',
                },
                // SINGLE-LINE inputs (preferred for one style)
                styleNumber: { type: 'string', description: 'Single-line: NWCA/SanMar style number (e.g. PC54). Omit if using `lines`.' },
                color: { type: 'string', description: 'Single-line: color name (e.g. "Navy"). Omit if using `lines`.' },
                sizes: {
                    type: 'object',
                    description: 'Single-line: size breakdown, e.g. {"S": 4, "M": 8, "L": 6}. Omit if using `lines`.',
                    additionalProperties: { type: 'integer' },
                },
                // MULTI-LINE input (use for 2+ different styles OR same style in different colors)
                lines: {
                    type: 'array',
                    description: 'Multi-line: array of {styleNumber, color, sizes} per line. All lines share locationCode and aggregate for tier. Use this whenever the rep wants more than one style OR more than one color.',
                    items: {
                        type: 'object',
                        properties: {
                            styleNumber: { type: 'string', description: 'Style number for this line (e.g. PC61).' },
                            color: { type: 'string', description: 'Color for this line (e.g. "Jet Black").' },
                            sizes: {
                                type: 'object',
                                description: 'Size breakdown for this line, e.g. {"M": 2, "L": 5, "2XL": 1}.',
                                additionalProperties: { type: 'integer' },
                            },
                        },
                        required: ['styleNumber', 'color', 'sizes'],
                    },
                },
            },
            required: ['locationCode'],
        },
    },
    {
        name: 'recommend_top_sellers',
        description:
            "Return the top-selling DTG-friendly products from NWCA's curated list (6 t-shirts " +
            "+ 2 sweatshirts, ranked by actual sales). Use when the customer asks 'what do you " +
            "recommend?' or doesn't have a specific style in mind. Returns each product with " +
            "sales rank, recommended colors, warnings (e.g. PC61 avoid Red), and a 'best for' " +
            "use-case note. Also includes the avoid-products list (Gildan, PC78H White, PC61 " +
            "Red) so you can warn proactively.",
        input_schema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    enum: ['tshirts', 't-shirts', 'tee', 'tees', 'sweatshirts', 'hoodies', 'fleece', 'any'],
                    description: 'Product category filter. "any" returns mixed t-shirts + sweatshirts. Default "any".',
                },
                limit: { type: 'integer', description: 'Max products to return (1-10). Default 3.' },
            },
        },
    },
    {
        name: 'lookup_product_details',
        description:
            "Look up the ACTUAL catalog details for a SanMar/NWCA style number — colors, sizes, " +
            "size upcharges, product title/description. Calls /api/dtg/product-bundle and " +
            "returns the live catalog data. " +
            "USE WHENEVER: the customer asks 'what colors does PC54 come in?', 'what sizes?', " +
            "or before quoting a non-standard color (sanity-check the color exists in the catalog). " +
            "NEVER guess catalog colors — always call this tool to ground your answer in real data. " +
            "Returns list of colors (with COLOR_NAME, CATALOG_COLOR, swatch image URL, model " +
            "shot URL), list of sizes (with case price + upcharge from base), and a summary of " +
            "size-upcharge tiers. The frontend renders the color list as clickable swatches " +
            "so the rep can pick visually.",
        input_schema: {
            type: 'object',
            properties: {
                styleNumber: { type: 'string', description: 'SanMar/NWCA style number (e.g. PC54, BC3001, DT6000).' },
            },
            required: ['styleNumber'],
        },
    },
    {
        name: 'web_search',
        description:
            "Search the live internet for information outside your training data. Use for: " +
            "competitor pricing (\"what does CustomInk charge for DTG?\"), recent industry " +
            "changes, specific DTG technical questions outside this prompt, comparison questions " +
            "the prompt doesn't cover. " +
            "DO NOT USE for: pricing questions this prompt answers, basic DTG vs DTF/screen " +
            "questions (those are covered in the prompt), hypotheticals. " +
            "DO NOT USE for catalog questions (\"what colors does X come in?\") — use " +
            "lookup_product_details for that instead.",
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query in natural language.' },
                purpose: { type: 'string', description: '1-sentence why-you-need-this.' },
            },
            required: ['query'],
        },
    },
];

// --- Tool implementations ----------------------------------------------------

async function searchContacts(query) {
    const trimmed = String(query || '').trim();
    if (trimmed.length < 2) return [];
    try {
        const url = `${INTERNAL_API_BASE}/api/company-contacts/search?q=${encodeURIComponent(trimmed)}&limit=5`;
        const r = await fetch(url);
        if (!r.ok) return [];
        const data = await r.json();
        return data.contacts || [];
    } catch {
        return [];
    }
}

async function lookupCustomerSmart(query) {
    const q = String(query || '').trim();
    if (q.length < 2) {
        return { matches: [], error: 'query too short — needs 2+ characters', query_used: q };
    }
    const direct = await searchContacts(q);
    if (direct.length > 0) {
        return { matches: shape(direct), count: direct.length, query_used: q };
    }
    const fragments = q
        .split(/\s+at\s+|\s+from\s+|\s+with\s+|\s+for\s+|[,/—–|]/i)
        .map((s) => s.trim())
        .filter((s) => s.length >= 3);
    const seen = new Set();
    const combined = [];
    const triedFragments = [];
    for (const frag of fragments) {
        if (frag === q) continue;
        triedFragments.push(frag);
        const hits = await searchContacts(frag);
        for (const c of hits) {
            if (seen.has(c.ID_Contact)) continue;
            seen.add(c.ID_Contact);
            combined.push(c);
            if (combined.length >= 5) break;
        }
        if (combined.length >= 5) break;
    }
    return {
        matches: shape(combined),
        count: combined.length,
        query_used: q,
        fragments_tried: triedFragments.length > 0 ? triedFragments : undefined,
    };
}

function shape(contacts) {
    return contacts.map((c) => ({
        company: c.CustomerCompanyName || null,
        customer_number: c.id_Customer != null ? String(c.id_Customer) : null,
        contact_name: c.ct_NameFull || null,
        contact_first: c.NameFirst || null,
        contact_last: c.NameLast || null,
        email: c.ContactNumbersEmail || null,
        company_email: c.Company_Email || null,
        phone: c.Company_Phone || null,
        address: c.Address || null,
        city: c.City || null,
        state: c.State || null,
        zip: c.Zip || null,
        rep: c.CustomerCustomerServiceRep || null,
        account_owner: c.Account_Owner || null,
        email_salesrep: c.Email_Salesrep || null,
        payment_terms: c.Payment_Terms || null,
        last_ordered: c.Customerdate_LastOrdered || null,
    }));
}

/**
 * quote_dtg_pricing implementation.
 *
 * Thin proxy: forwards to POST /api/dtg/quote-pricing which runs the
 * single canonical algorithm in lib/dtg-canonical-pricing.js. This is the
 * SAME algorithm shared_components/js/dtg-pricing-service.js uses (used
 * by /pricing/dtg and /order-form), so chat + form + pricing page all
 * produce identical numbers.
 *
 * Supports BOTH single-line and multi-line input shapes — the endpoint
 * accepts {styleNumber, color, sizes} OR {lines:[...]}.
 */
async function quoteDtgPricing(input) {
    // Forward to the canonical endpoint. Single source of truth.
    try {
        const body = {};
        if (input && input.locationCode) body.locationCode = input.locationCode;
        if (Array.isArray(input?.lines) && input.lines.length > 0) {
            body.lines = input.lines;
        } else if (input?.styleNumber && input?.sizes) {
            body.styleNumber = input.styleNumber;
            body.color = input.color;
            body.sizes = input.sizes;
        }
        const r = await fetch(`${INTERNAL_API_BASE}/api/dtg/quote-pricing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
            return data || { error: 'pricing_fetch_failed', message: `quote-pricing returned ${r.status}` };
        }
        return data;
    } catch (err) {
        return { error: 'network', message: err.message };
    }
}

/**
 * lookup_product_details — return the actual catalog colors + sizes for a style.
 * Calls /api/dtg/product-bundle and reshapes the response so the bot can answer
 * "what colors does PC54 come in?" without inventing values, AND so the frontend
 * can render clickable color swatches inline.
 */
async function lookupProductDetails(input) {
    const styleNumber = String(input?.styleNumber || '').trim().toUpperCase();
    if (!styleNumber) {
        return { error: 'bad_input', message: 'styleNumber is required' };
    }
    try {
        const url = `${INTERNAL_API_BASE}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(styleNumber)}`;
        const r = await fetch(url);
        if (!r.ok) {
            return {
                error: 'lookup_failed',
                message: `DTG product-bundle returned ${r.status} for style "${styleNumber}". The style may not be in our SanMar catalog — ask the rep to verify.`,
            };
        }
        const bundle = await r.json();
        const product = bundle.product;
        if (!product) {
            return {
                error: 'no_product',
                message: `No product found for style "${styleNumber}". Verify the style number.`,
            };
        }

        const colorsRaw = Array.isArray(product.colors) ? product.colors : [];
        const colors = colorsRaw.map((c) => ({
            name: c.COLOR_NAME || '',
            catalogColor: c.CATALOG_COLOR || '',
            swatchImageUrl: c.COLOR_SQUARE_IMAGE || '',
            mainImageUrl: c.MAIN_IMAGE_URL || '',
        })).filter(c => c.name);

        const sizesRaw = Array.isArray(bundle.pricing?.sizes) ? bundle.pricing.sizes : [];
        const upchargeMap = bundle.pricing?.upcharges && typeof bundle.pricing.upcharges === 'object'
            ? bundle.pricing.upcharges
            : {};
        const sizes = sizesRaw.map((s) => {
            const size = String(s.size || '').toUpperCase();
            const upcharge = Number(upchargeMap[size]) || 0;
            return {
                size,
                maxCasePrice: Number(s.maxCasePrice) || 0,
                upcharge,
                hasUpcharge: upcharge > 0,
            };
        });

        const hasUpcharges = sizes.some(s => s.hasUpcharge);
        const upchargeSummary = hasUpcharges
            ? sizes.filter(s => s.hasUpcharge).map(s => `${s.size} +$${s.upcharge.toFixed(2)}`).join(', ')
            : null;

        // DTG-specific avoid warnings the bot should surface
        const avoidWarnings = [];
        if (styleNumber === 'PC61') {
            avoidWarnings.push('⚠ Avoid PC61 Red color — causes fixation stains, needs 24hr+ drying. All other colors are great.');
        }
        if (styleNumber === 'PC78H') {
            avoidWarnings.push('⚠ Avoid PC78H White color — completely unprintable on DTG (washes out). Other PC78H colors are fine.');
        }
        if (styleNumber.startsWith('G') && /^G\d/.test(styleNumber)) {
            // Gildan style numbers typically start with G + digit (G500, G185, G640, etc.)
            avoidWarnings.push('⚠ Gildan products are NOT recommended for DTG — special fabric coating makes prints dull and lifeless. Suggest a Port & Company or BELLA+CANVAS equivalent instead.');
        }

        return {
            styleNumber,
            title: product.title || product.PRODUCT_TITLE || '',
            description: product.description || product.PRODUCT_DESCRIPTION || '',
            colors,
            colorCount: colors.length,
            sizes,
            sizeCount: sizes.length,
            hasUpcharges,
            upchargeSummary,
            avoidWarnings,
            source: 'caspio-sanmar-bulk',
        };
    } catch (err) {
        console.error('[dtg-quote-ai] lookup_product_details error:', err.message);
        return { error: 'network', message: err.message };
    }
}

// Cache the curated-list image lookups module-level so we hit /api/dtg/product-bundle
// at most once per style across the lifetime of the proxy process. The list is
// small (≤8 styles) and stable; if it ever changes mid-process the worst case is
// stale thumbnails until the dyno cycles.
let _curatedImageCache = null;
let _curatedImagePromise = null;
async function hydrateCuratedImages() {
    if (_curatedImageCache) return _curatedImageCache;
    if (_curatedImagePromise) return _curatedImagePromise;

    const allCurated = [
        ...(DTG_CURATED_PRODUCTS.tshirts || []),
        ...(DTG_CURATED_PRODUCTS.sweatshirts || []),
    ];
    const styles = Array.from(new Set(allCurated.map((p) => p.styleNumber)));

    _curatedImagePromise = Promise.all(styles.map(async (style) => {
        try {
            const r = await fetch(`${INTERNAL_API_BASE}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(style)}`);
            if (!r.ok) return [style, null];
            const j = await r.json();
            const colors = (j && j.product && Array.isArray(j.product.colors)) ? j.product.colors : [];
            const first = colors.find((c) => c && c.MAIN_IMAGE_URL);
            return [style, first ? first.MAIN_IMAGE_URL : null];
        } catch {
            return [style, null];
        }
    })).then((entries) => {
        _curatedImageCache = Object.fromEntries(entries);
        return _curatedImageCache;
    });

    return _curatedImagePromise;
}

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[dtg-quote-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    if (name === 'quote_dtg_pricing') {
        try {
            return await quoteDtgPricing(input);
        } catch (err) {
            console.error('[dtg-quote-ai] quote_dtg_pricing error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'recommend_top_sellers') {
        try {
            const result = recommendTopSellers({
                category: input?.category || 'any',
                limit: input?.limit || 3,
            });
            // Decorate each product with mainImageUrl so the frontend can show a
            // thumbnail. The image map is cached after the first hydration; the
            // entire curated list (≤8 styles) is fetched in parallel exactly once.
            try {
                const imageMap = await hydrateCuratedImages();
                if (Array.isArray(result.products)) {
                    for (const p of result.products) {
                        const url = imageMap[p.styleNumber];
                        if (url) p.mainImageUrl = url;
                    }
                }
            } catch (hyErr) {
                console.warn('[dtg-quote-ai] image hydration skipped:', hyErr.message);
            }
            return result;
        } catch (err) {
            console.error('[dtg-quote-ai] recommend_top_sellers error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'lookup_product_details') {
        try {
            return await lookupProductDetails(input);
        } catch (err) {
            console.error('[dtg-quote-ai] lookup_product_details error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'web_search') {
        try {
            return await webSearch({
                query: input?.query,
                purpose: input?.purpose,
                maxResults: 5,
                searchDepth: 'basic',
            });
        } catch (err) {
            console.error('[dtg-quote-ai] web_search error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    return { error: `unknown tool: ${name}` };
}

// --- Anthropic client + context plumbing -------------------------------------

let anthropicClient = null;
function getAnthropicClient() {
    if (!anthropicClient) {
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY env var is not set on caspio-pricing-proxy.');
        }
        anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return anthropicClient;
}

function buildCalcContextBlock(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const safe = {
        quoteID: typeof ctx.quoteID === 'string' && ctx.quoteID ? ctx.quoteID : null,
    };
    return JSON.stringify(safe, null, 2);
}

function withCalcContext(messages, ctx) {
    const calcBlock = buildCalcContextBlock(ctx);
    if (!Array.isArray(messages) || messages.length === 0) return messages || [];
    if (!calcBlock) return messages;
    const idx = messages.length - 1;
    const last = messages[idx];
    if (!last || last.role !== 'user') return messages;
    if (typeof last.content !== 'string') return messages;
    const annotated = {
        role: 'user',
        content: `CALC_CONTEXT:\n${calcBlock}\n\nUSER:\n${last.content}`,
    };
    return [...messages.slice(0, idx), annotated];
}

// --- Route -------------------------------------------------------------------

router.post('/chat', express.json({ limit: '256kb' }), async (req, res) => {
    const { messages, calcContext } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
    }

    let client;
    try {
        client = getAnthropicClient();
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const sendEvent = (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        let workingMessages = withCalcContext(messages, calcContext);
        let totalUsage = {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        };
        const MAX_TOOL_ITERATIONS = 8;
        let finalStopReason = 'end_turn';

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const stream = client.messages.stream({
                model: 'claude-sonnet-4-6',
                max_tokens: 1800,
                tools: TOOLS,
                system: [
                    {
                        type: 'text',
                        text: CONTRACT_DTG_QUOTE_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[dtg-quote-ai] stream error:', err.message);
                sendEvent('error', { message: err.message });
            });

            const finalMessage = await stream.finalMessage();
            const usage = finalMessage.usage || {};
            totalUsage.input_tokens += usage.input_tokens || 0;
            totalUsage.output_tokens += usage.output_tokens || 0;
            totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
            totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;

            finalStopReason = finalMessage.stop_reason;

            if (finalMessage.stop_reason !== 'tool_use') break;

            const toolUseBlocks = (finalMessage.content || []).filter((b) => b.type === 'tool_use');
            if (toolUseBlocks.length === 0) break;

            workingMessages.push({ role: 'assistant', content: finalMessage.content });

            const toolResults = [];
            for (const tu of toolUseBlocks) {
                const result = await executeTool(tu.name, tu.input);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify(result),
                });
                sendEvent('tool_result', { tool: tu.name, result });
                console.log(`[dtg-quote-ai] tool ${tu.name} → ${JSON.stringify(result).slice(0, 120)}`);
            }
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        console.log(`[dtg-quote-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${totalUsage.cache_read_input_tokens} cache_write=${totalUsage.cache_creation_input_tokens}`);
    } catch (e) {
        console.error('[dtg-quote-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
