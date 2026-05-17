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

// DTG pricing constants — keep in sync with shared_components/js/dtg-quote-pricing.js
const LTM_FEE = 50.00;
const LTM_THRESHOLD = 24; // qty < 24 → LTM applies (uses 24-47 tier base price)

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
            "Price a DTG order. Inputs: style number, color, print location code, total qty, " +
            "and size breakdown. Pulls live pricing from /api/dtg/product-bundle, applies the " +
            "tier (1-23 LTM / 24-47 / 48-71 / 72+), distributes LTM under 24 with Math.floor, " +
            "and returns per-size pricing with size upcharges baked in. " +
            "Locations: LC, FF, JF (front singles), FB, JB (back singles), LC_FB, FF_FB, " +
            "JF_JB, LC_JB (front+back combos).",
        input_schema: {
            type: 'object',
            properties: {
                styleNumber: { type: 'string', description: 'NWCA/SanMar style number (e.g. PC54, BC3001, DT6000).' },
                color: { type: 'string', description: 'Color name (e.g. "Navy", "Jet Black", "Athletic Heather"). Free-form.' },
                locationCode: {
                    type: 'string',
                    enum: ALL_LOCATION_CODES,
                    description: 'Print location code. Single: LC/FF/JF/FB/JB. Combo: LC_FB/FF_FB/JF_JB/LC_JB.',
                },
                qty: { type: 'integer', description: 'Total aggregate quantity across all sizes (1-9999). 1-23 hits LTM tier.' },
                sizes: {
                    type: 'object',
                    description: 'Size breakdown object, e.g. {"S": 4, "M": 8, "L": 6, "XL": 2, "2XL": 1}. Total must equal qty.',
                    additionalProperties: { type: 'integer' },
                },
            },
            required: ['styleNumber', 'color', 'locationCode', 'qty', 'sizes'],
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
 * Fetches /api/dtg/product-bundle for live pricing data, then applies:
 *   - Tier lookup (1-23 LTM, 24-47, 48-71, 72+)
 *   - LTM distribution at qty < 24 via Math.floor((50/qty) * 100) / 100
 *   - Combo location pricing (LC_FB etc.) by summing DTG_Costs print costs
 *   - Per-size upcharges from Standard_Size_Upcharges table
 */
async function quoteDtgPricing(input) {
    const styleNumber = String(input?.styleNumber || '').trim().toUpperCase();
    const color = String(input?.color || '').trim();
    const locationCode = String(input?.locationCode || '').trim().toUpperCase();
    const qty = Math.trunc(Number(input?.qty) || 0);
    const sizes = input?.sizes && typeof input.sizes === 'object' ? input.sizes : {};

    // Validation
    if (!styleNumber) return { error: 'bad_input', message: 'styleNumber is required' };
    if (!color) return { error: 'bad_input', message: 'color is required' };
    if (!ALL_LOCATION_CODES.includes(locationCode)) {
        return {
            error: 'bad_input',
            message: `locationCode must be one of: ${ALL_LOCATION_CODES.join(', ')}. Got "${locationCode}".`,
        };
    }
    if (!Number.isFinite(qty) || qty < 1) {
        return { error: 'bad_input', message: 'qty must be a positive integer' };
    }
    const sizeKeys = Object.keys(sizes);
    if (sizeKeys.length === 0) {
        return { error: 'bad_input', message: 'sizes object is required with at least one size' };
    }
    const sizeQtySum = sizeKeys.reduce((s, k) => s + (Number(sizes[k]) || 0), 0);
    if (sizeQtySum !== qty) {
        return {
            error: 'bad_input',
            message: `Size breakdown sums to ${sizeQtySum} but qty is ${qty}. They must match.`,
        };
    }

    // Fetch pricing data
    let bundle;
    try {
        const url = `${INTERNAL_API_BASE}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(styleNumber)}&color=${encodeURIComponent(color)}`;
        const r = await fetch(url);
        if (!r.ok) {
            return {
                error: 'pricing_fetch_failed',
                message: `DTG pricing API returned ${r.status}. Style "${styleNumber}" may not be in the catalog.`,
            };
        }
        bundle = await r.json();
    } catch (err) {
        return { error: 'network', message: err.message };
    }

    // Determine tier
    let tierLabel;
    let isLtmTier = false;
    if (qty < LTM_THRESHOLD) {
        tierLabel = '24-47';
        isLtmTier = true;
    } else if (qty <= 47) {
        tierLabel = '24-47';
    } else if (qty <= 71) {
        tierLabel = '48-71';
    } else {
        tierLabel = '72+';
    }

    // The /api/dtg/product-bundle response shape (per dtg.js:188-200):
    //   { product: { styleNumber, title, description, colors:[...] },
    //     pricing: { tiers:[...], costs:[...], sizes:[...], upcharges:{...}, locations:[...] },
    //     metadata: {...} }
    // Pull print costs for the resolved tier across the location code(s).
    const dtgCosts = Array.isArray(bundle.pricing?.costs) ? bundle.pricing.costs : [];
    let totalPrintCost = 0;
    const locationParts = locationCode.split('_'); // ['LC'] or ['LC', 'FB']
    for (const part of locationParts) {
        const row = dtgCosts.find(
            (r) => r.PrintLocationCode === part && r.TierLabel === tierLabel,
        );
        if (row) totalPrintCost += Number(row.PrintCost) || 0;
    }

    // Pricing-tier MarginDenominator (Caspio's pricing formula).
    const tiers = Array.isArray(bundle.pricing?.tiers) ? bundle.pricing.tiers : [];
    let marginDenominator = 0.55;
    const tierRow = tiers.find((t) => t.TierLabel === tierLabel);
    if (tierRow && Number(tierRow.MarginDenominator)) {
        marginDenominator = Number(tierRow.MarginDenominator);
    }

    // Size pricing (array of {size, maxCasePrice}) and upcharges (object {2XL: 2, 3XL: 4, ...})
    const sizePricing = Array.isArray(bundle.pricing?.sizes) ? bundle.pricing.sizes : [];
    const upchargeBySize = bundle.pricing?.upcharges && typeof bundle.pricing.upcharges === 'object'
        ? Object.fromEntries(Object.entries(bundle.pricing.upcharges).map(([k, v]) => [String(k).toUpperCase(), Number(v) || 0]))
        : {};

    // LTM per piece
    const ltmPerUnit = isLtmTier
        ? Math.floor((LTM_FEE / qty) * 100) / 100
        : 0;

    // Compute per-size unit price + line totals.
    // Formula (mirrors dtg-quote-pricing.js): garmentCost / marginDenominator
    //   + totalPrintCost + sizeUpcharge + ltmPerUnit.
    const lineSizes = [];
    let lineTotal = 0;
    let baseUnitPriceAggregate = 0;
    let aggregateQtyForAvg = 0;

    for (const [size, sizeQty] of Object.entries(sizes)) {
        const q = Number(sizeQty) || 0;
        if (q <= 0) continue;
        const sizeUp = sizeUpchargeFor(size, upchargeBySize);
        const garmentCost = lookupGarmentCost(size, sizePricing);
        const baseUnit = (garmentCost / marginDenominator) + totalPrintCost + sizeUp;
        const finalUnit = Math.round((baseUnit + ltmPerUnit) * 100) / 100;
        const lineTotalForSize = Math.round(finalUnit * q * 100) / 100;
        lineSizes.push({
            size,
            quantity: q,
            garmentCost: Math.round(garmentCost * 100) / 100,
            printCost: Math.round(totalPrintCost * 100) / 100,
            sizeUpcharge: Math.round(sizeUp * 100) / 100,
            baseUnit: Math.round(baseUnit * 100) / 100,
            ltmPerUnit,
            finalUnit,
            lineTotal: lineTotalForSize,
        });
        lineTotal += lineTotalForSize;
        baseUnitPriceAggregate += baseUnit * q;
        aggregateQtyForAvg += q;
    }

    const avgBaseUnit = aggregateQtyForAvg > 0
        ? Math.round((baseUnitPriceAggregate / aggregateQtyForAvg) * 100) / 100
        : 0;
    const avgFinalUnit = Math.round((avgBaseUnit + ltmPerUnit) * 100) / 100;

    // PartNumber for ShopWorks / quote line ref
    const partNumber = `${styleNumber}-${color.replace(/\s+/g, '').toUpperCase()}-${locationCode}`;

    return {
        productType: 'dtg',
        partNumber,
        styleNumber,
        color,
        locationCode,
        locationLabel: LOCATION_LABELS[locationCode] || locationCode,
        tier: isLtmTier ? `${tierLabel} (LTM)` : tierLabel,
        baseTier: tierLabel,
        isLtmTier,
        marginDenominator,
        totalPrintCost: Math.round(totalPrintCost * 100) / 100,
        totalQuantity: qty,
        sizes,
        lineSizes,
        baseUnitPrice: avgBaseUnit,
        ltmPerUnit,
        finalUnitPrice: avgFinalUnit,
        lineTotal: Math.round(lineTotal * 100) / 100,
        appliedRules: {
            tier: isLtmTier
                ? `${qty} pieces → ${tierLabel} tier with LTM (under ${LTM_THRESHOLD}-piece minimum)`
                : `${qty} pieces → ${tierLabel} tier (standard)`,
            ltm: isLtmTier
                ? `$${LTM_FEE} distributed: +$${ltmPerUnit.toFixed(2)}/piece (${LTM_FEE}/${qty} floored)`
                : null,
            sizeUpcharge: Object.entries(upchargeBySize)
                .filter(([k, v]) => v > 0 && (sizes[k] || sizes[k.toUpperCase()]))
                .map(([k, v]) => `${k} +$${v.toFixed(2)}/piece`)
                .join(', ') || null,
        },
        product: {
            title: bundle.product?.title || null,
            description: bundle.product?.description || null,
        },
    };
}

function sizeUpchargeFor(size, upchargeBySize) {
    if (!size) return 0;
    return Number(upchargeBySize[String(size).toUpperCase()] || 0);
}

function lookupGarmentCost(size, sizePricing) {
    if (!Array.isArray(sizePricing) || sizePricing.length === 0) return 5.00;
    const sizeUpper = String(size).toUpperCase();
    // product-bundle returns {size, maxCasePrice}
    for (const row of sizePricing) {
        const k = String(row.size || row.SIZE || '').toUpperCase();
        if (k === sizeUpper) {
            return Number(row.maxCasePrice || row.CASE_PRICE || row.price) || 5.00;
        }
    }
    // Fall back to the highest case price (conservative — over-quote rather than under-quote)
    const max = sizePricing.reduce(
        (m, r) => Math.max(m, Number(r.maxCasePrice || r.CASE_PRICE || r.price) || 0),
        0,
    );
    return max || 5.00;
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
            return recommendTopSellers({
                category: input?.category || 'any',
                limit: input?.limit || 3,
            });
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
