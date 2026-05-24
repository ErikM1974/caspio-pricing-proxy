// EMB Quote AI — research assistant for the Embroidery Quote Builder.
//
// Streams Claude responses (SSE) for the chat panel on
// /quote-builders/embroidery-quote-builder.html.
//
// Tools (3): lookup_customer, recommend_top_sellers_emb, lookup_product_details.
// NO pricing tool — rep computes pricing in the form. NO web_search — defer.
//
// Mirrors src/routes/dtg-quote-ai.js. Tool implementations for lookup_customer
// + lookup_product_details are cloned from the DTG route (they hit shared
// proxy infrastructure — /api/company-contacts/search + /api/dtg/product-bundle —
// so the implementations are method-agnostic). Future cleanup: extract to a
// shared lib/quote-ai-shared-tools.js module.
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {                  // OPTIONAL
//       quoteID: 'EMB-2026-088' | null
//     }
//   }
//
// Response: text/event-stream
//   event: delta        data: { text: "..." }
//   event: tool_result  data: { tool: "...", result: {...} }
//   event: done         data: { stop_reason, usage }
//   event: error        data: { message }
//
// Created 2026-05-24 — EMB Chat B (Phase 11 unified UX rollout).

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { CONTRACT_EMB_QUOTE_AI_SYSTEM_PROMPT } = require('../../lib/emb-quote-ai-prompt');
const { fetchAllCaspioPages } = require('../utils/caspio');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// EMB top-sellers table name. Erik creates + populates from 10yr sales data.
const EMB_TOP_SELLERS_TABLE = 'EMB_Top_Sellers_2026';

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
        name: 'recommend_top_sellers_emb',
        description:
            "Return NWCA's actual top-selling EMBROIDERY products from the Caspio " +
            "EMB_Top_Sellers_2026 table (sourced from 10 years of embroidery sales). " +
            "Use when the rep asks 'what's our best polo for embroidery?' / 'top sellers' " +
            "/ 'what do you recommend for a hoodie?'. Filter by category to narrow. " +
            "Each product returned includes real sales numbers, top 4 colors with units, " +
            "and the swatch image URL.",
        input_schema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description:
                        'Category filter. Common values: "T-Shirt", "Polo", "Sweatshirt", ' +
                        '"Hoodie", "Jacket", "Cap", "Beanie", "Bag", or "any" for mixed across ' +
                        'all categories. Pass the exact category label as stored in the Caspio table.',
                },
                limit: { type: 'integer', description: 'Max products to return (1-10). Default 3.' },
            },
        },
    },
    {
        name: 'lookup_product_details',
        description:
            "Look up the ACTUAL catalog details for a SanMar/NWCA style number — colors, sizes, " +
            "size upcharges, product title/description. Calls /api/dtg/product-bundle (returns " +
            "generic SanMar data — works for EMB too). " +
            "USE WHENEVER: the rep asks 'what colors does PC54 come in?', 'what sizes?', " +
            "or before quoting a non-standard color (sanity-check the color exists in the catalog). " +
            "NEVER guess catalog colors — always call this tool to ground your answer in real data.",
        input_schema: {
            type: 'object',
            properties: {
                styleNumber: { type: 'string', description: 'SanMar/NWCA style number (e.g. PC54, K500, PC78H).' },
            },
            required: ['styleNumber'],
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
        return { matches: shapeContacts(direct), count: direct.length, query_used: q };
    }
    // Fallback: split on common conjunctions ("Allison at Acme") and search each fragment.
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
        matches: shapeContacts(combined),
        count: combined.length,
        query_used: q,
        fragments_tried: triedFragments.length > 0 ? triedFragments : undefined,
    };
}

function shapeContacts(contacts) {
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
 * recommend_top_sellers_emb — pull from Caspio EMB_Top_Sellers_2026.
 * Aggregates per-style, returns top N styles with their top 4 colors.
 */
async function recommendTopSellersEmb(input) {
    try {
        const category = String(input?.category || 'any');
        const limit = Math.max(1, Math.min(10, Number(input?.limit) || 3));

        const params = { 'q.orderBy': 'style_rank ASC, color_rank ASC' };
        if (category && category !== 'any') {
            params['q.where'] = `category='${category.replace(/'/g, '')}'`;
        }
        const rows = await fetchAllCaspioPages(`/tables/${EMB_TOP_SELLERS_TABLE}/records`, params);

        // Aggregate per-style (one row per style+color in the table)
        const byStyle = new Map();
        for (const r of rows) {
            if (!byStyle.has(r.style)) {
                byStyle.set(r.style, {
                    styleNumber: r.style,
                    name: stripStyleSuffix(r.product_title || ''),
                    brand: extractBrand(r.product_title || ''),
                    salesData: `${Number(r.total_units_sold || 0).toLocaleString()} units lifetime`,
                    salesRank: Number(r.style_rank) || 99,
                    category: r.category || '',
                    quality: 'excellent',
                    bestColors: [],
                });
            }
            const p = byStyle.get(r.style);
            p.bestColors.push({
                name: r.color_name || '',
                catalogColor: r.catalog_color || '',
                units: String(Number(r.color_units_sold || 0)),
                swatchUrl: r.swatch_image_url || '',
            });
        }
        // Keep only top 4 colors per product for chat-card brevity
        for (const p of byStyle.values()) {
            p.bestColors = p.bestColors.slice(0, 4);
        }
        const products = [...byStyle.values()]
            .sort((a, b) => a.salesRank - b.salesRank)
            .slice(0, limit);

        // Hydrate main_image_url per style from SanMar bundle endpoint.
        try {
            const imageMap = await hydrateEmbImages(products.map((p) => p.styleNumber));
            for (const p of products) {
                const url = imageMap[p.styleNumber];
                if (url) p.mainImageUrl = url;
            }
        } catch (hyErr) {
            console.warn('[emb-quote-ai] image hydration skipped:', hyErr.message);
        }

        return {
            category,
            count: products.length,
            products,
        };
    } catch (err) {
        console.error('[emb-quote-ai] recommend_top_sellers_emb error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

// Strip the trailing ". STYLENUMBER" SanMar appends to product titles.
function stripStyleSuffix(title) {
    return String(title || '').replace(/\.?\s*[A-Z0-9]+\s*$/, '').trim();
}

// Guess brand from the start of a SanMar product title.
function extractBrand(title) {
    const t = String(title || '').trim();
    if (/^Port\s*&\s*Co/i.test(t)) return 'Port & Company';
    if (/^BELLA\+CANVAS/i.test(t)) return 'BELLA+CANVAS';
    if (/^District/i.test(t)) return 'District';
    if (/^Sport-Tek/i.test(t)) return 'Sport-Tek';
    if (/^Next Level/i.test(t)) return 'Next Level Apparel';
    if (/^Carhartt/i.test(t)) return 'Carhartt';
    if (/^OGIO/i.test(t)) return 'OGIO';
    if (/^Eddie Bauer/i.test(t)) return 'Eddie Bauer';
    if (/^Nike/i.test(t)) return 'Nike';
    if (/^New Era/i.test(t)) return 'New Era';
    if (/^Richardson/i.test(t)) return 'Richardson';
    if (/^Gildan/i.test(t)) return 'Gildan';
    return t.split(/\s+/)[0] || '';
}

// Per-dyno image cache. Top-up rather than full-refetch.
let _embImageCache = null;
let _embImagePromise = null;
async function hydrateEmbImages(styles) {
    if (_embImageCache) {
        const missing = styles.filter((s) => !(s in _embImageCache));
        if (!missing.length) return _embImageCache;
    }
    if (_embImagePromise) return _embImagePromise;
    const toFetch = Array.from(new Set(styles));
    _embImagePromise = Promise.all(toFetch.map(async (style) => {
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
        _embImageCache = Object.assign({}, _embImageCache || {}, Object.fromEntries(entries));
        _embImagePromise = null;
        return _embImageCache;
    });
    return _embImagePromise;
}

/**
 * lookup_product_details — live SanMar query via /api/dtg/product-bundle.
 * The endpoint returns generic SanMar data (not DTG-specific), so it's
 * safe to reuse here for EMB.
 */
async function lookupProductDetails(input) {
    const styleNumber = String(input?.styleNumber || '').trim().toUpperCase();
    if (!styleNumber) return { error: 'missing_style', message: 'styleNumber is required' };

    try {
        const r = await fetch(`${INTERNAL_API_BASE}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(styleNumber)}`);
        if (!r.ok) {
            return { error: 'not_found', message: `Style ${styleNumber} not in SanMar catalog`, styleNumber };
        }
        const data = await r.json();
        const product = data.product || {};
        const colorsRaw = Array.isArray(product.colors) ? product.colors : [];
        const sizesRaw = Array.isArray(product.sizes) ? product.sizes : [];

        const colors = colorsRaw.map((c) => ({
            name: c.COLOR_NAME || '',
            catalog: c.CATALOG_COLOR || '',
            swatchUrl: c.COLOR_SWATCH_IMAGE_URL || c.SWATCH_IMAGE_URL || '',
            modelUrl: c.MAIN_IMAGE_URL || c.FRONT_MODEL_IMAGE_URL || '',
        }));

        // Compute size upcharges from sizesRaw[*].maxCasePrice
        // Min case price = base; everything above = upcharge.
        const minCase = Math.min(...sizesRaw.map(s => Number(s.maxCasePrice) || Infinity).filter(n => Number.isFinite(n)));
        const upchargeMap = {};
        for (const s of sizesRaw) {
            const size = String(s.size || '').toUpperCase();
            const price = Number(s.maxCasePrice) || 0;
            const upcharge = price > minCase ? price - minCase : 0;
            upchargeMap[size] = Math.round(upcharge * 100) / 100;
        }

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
            source: 'caspio-sanmar-bulk',
        };
    } catch (err) {
        console.error('[emb-quote-ai] lookup_product_details error:', err.message);
        return { error: 'network', message: err.message };
    }
}

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    if (name === 'recommend_top_sellers_emb') {
        try {
            return await recommendTopSellersEmb(input);
        } catch (err) {
            console.error('[emb-quote-ai] recommend_top_sellers_emb error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'lookup_product_details') {
        try {
            return await lookupProductDetails(input);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_product_details error:', err.message);
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
    const parts = [];
    if (typeof ctx.quoteID === 'string' && ctx.quoteID) {
        parts.push(`quoteID: ${ctx.quoteID}`);
    }
    return parts.length ? parts.join('\n') : null;
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
                        text: CONTRACT_EMB_QUOTE_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[emb-quote-ai] stream error:', err.message);
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

            // Run tools in parallel — Promise.all preserves order so tool_use_id alignment holds.
            const toolResults = await Promise.all(toolUseBlocks.map(async (tu) => {
                const t0 = Date.now();
                const result = await executeTool(tu.name, tu.input);
                const elapsed = Date.now() - t0;
                sendEvent('tool_result', { tool: tu.name, result });
                console.log(`[emb-quote-ai] tool ${tu.name} (${elapsed}ms) → ${JSON.stringify(result).slice(0, 120)}`);
                return {
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify(result),
                };
            }));
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        console.log(`[emb-quote-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${totalUsage.cache_read_input_tokens} cache_write=${totalUsage.cache_creation_input_tokens}`);
    } catch (e) {
        console.error('[emb-quote-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
