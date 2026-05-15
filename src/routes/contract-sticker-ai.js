// Contract Sticker AI — quote drafting assistant.
// Streams Claude responses (SSE) for the chat panel on the contract sticker page
// (/calculators/sticker-manual-pricing.html).
//
// Mirrors contract-embroidery-ai.js with two key differences:
//   1. The bot drives the conversation. Unlike CEMB where Ruthie pre-fills the
//      calculator before opening the chat, here the user just chats — the bot
//      collects size + qty + customer + shape from natural language and
//      resolves prices itself via the `quote_sticker_price` tool.
//   2. Tools: lookup_customer (reuse of the CEMB impl) +
//      quote_sticker_price (new — implements bounding-box + round-up rules,
//      backed by /api/sticker-pricing/quote logic in lib form).
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {                    // OPTIONAL — used only for the
//       quoteID: 'STK-2026-001' | null   // pre-generated quote ID display
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
const { CONTRACT_STICKER_AI_SYSTEM_PROMPT } = require('../../lib/contract-sticker-ai-prompt');
const { loadGrid, STANDARD_SIZES, STANDARD_QTYS, SETUP_FEE_PART, SETUP_FEE_AMOUNT } = require('./sticker-pricing');
const { computeBannerQuote } = require('./banner-pricing');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

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
        name: 'quote_sticker_price',
        description:
            "Look up the price for a STICKER line item. Width and height are in inches. " +
            "Implements two pricing rules automatically: " +
            "(1) BOUNDING-BOX: the larger of width/height rounds UP to the next standard " +
            "size (2x2, 3x3, 4x4, 5x5, 6x6). E.g. 2x3 → priced as 3x3. Circles, ovals, " +
            "and rounded-corner shapes also use bounding-box. " +
            "(2) QUANTITY ROUND-UP: qty rounds UP to the next standard tier " +
            "(50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000). E.g. 750 → priced as 1000. " +
            "Returns the PartNumber, the rounded size + qty, total + per-piece price, and a " +
            "description of which rules were applied (so you can explain the adjustment to " +
            "the user transparently). If the requested size or qty exceeds the grid, " +
            "returns offGrid: true — you must escalate to a manual quote in that case.",
        input_schema: {
            type: 'object',
            properties: {
                width: { type: 'number', description: 'Width in inches (e.g. 2, 3.5, 4)' },
                height: { type: 'number', description: 'Height in inches' },
                qty: { type: 'integer', description: 'Quantity of stickers requested' },
            },
            required: ['width', 'height', 'qty'],
        },
    },
    {
        name: 'quote_banner_price',
        description:
            "Look up the price for a BANNER line item. Banners price continuously: " +
            "width × height ÷ 144 (sqft) × $10/sqft × qty, with a $40-per-banner minimum. " +
            "Standard banners ship with hemmed edges + 4 corner grommets INCLUDED (no extra charge). " +
            "Optional finishing extras (call out only if customer asks): " +
            "  - Additional grommets ($0.50 each — beyond the 4 corners) " +
            "  - Pole pocket top/bottom/both ($2.50/linear foot) " +
            "  - Double-sided print (1.80× multiplier — covers second-side print + blockout liner) " +
            "Returns the computed PartNumber (BAN-{W}X{H}), per-banner + order totals, applied rules, " +
            "and a setup-fee note (GRT-50 $50 if new artwork). Use this for ANY rectangular banner " +
            "request, no matter how big — banners have no upper size limit on the grid.",
        input_schema: {
            type: 'object',
            properties: {
                widthIn: { type: 'number', description: 'Width in inches (e.g. 24 for 2 ft, 36 for 3 ft, 48 for 4 ft)' },
                heightIn: { type: 'number', description: 'Height in inches' },
                qty: { type: 'integer', description: 'Number of banners requested' },
                grommetCount: { type: 'integer', description: 'EXTRA grommets beyond the 4 corners. Default 0. Outdoor banners often add 1 per 2 ft of perimeter.' },
                polePockets: {
                    type: 'string',
                    enum: ['top', 'bottom', 'both', 'none'],
                    description: 'Pole pocket(s). Default "none". Use "top"/"bottom"/"both" if the customer asks for hanging-pole pockets.',
                },
                doubleSided: { type: 'boolean', description: 'True if customer wants two-sided print. Adds 1.80× multiplier.' },
            },
            required: ['widthIn', 'heightIn', 'qty'],
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
 * quote_sticker_price implementation. Applies bounding-box + round-up rules,
 * returns the matched grid row, and signals off-grid (manual quote) for
 * out-of-range requests.
 *
 * Returns a payload designed to be readable by Claude AND used by the frontend
 * (the part_number + size + quantity drives table-row highlighting on the page).
 */
async function quoteStickerPrice(input) {
    const widthRaw = Number(input?.width);
    const heightRaw = Number(input?.height);
    const qtyRaw = Math.trunc(Number(input?.qty));

    if (!Number.isFinite(widthRaw) || widthRaw <= 0
        || !Number.isFinite(heightRaw) || heightRaw <= 0
        || !Number.isFinite(qtyRaw) || qtyRaw <= 0) {
        return {
            error: 'bad_input',
            message: 'width, height, qty must all be positive numbers',
            received: { width: input?.width, height: input?.height, qty: input?.qty },
        };
    }

    const maxDim = Math.max(widthRaw, heightRaw);
    const boundingSize = STANDARD_SIZES.find(s => parseInt(s.split('x')[0], 10) >= maxDim);
    if (!boundingSize) {
        return {
            offGrid: true,
            reason: 'oversize_dimension',
            detail: `${widthRaw}"×${heightRaw}" — larger dimension ${maxDim}" exceeds our largest standard size (6×6).`,
            requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
            escalation: 'Collect specs (shape, color count, finish, ship date) and tell the user a custom quote will be returned within 1 business day.',
        };
    }

    const roundedQty = STANDARD_QTYS.find(q => q >= qtyRaw);
    if (!roundedQty) {
        return {
            offGrid: true,
            reason: 'oversize_quantity',
            detail: `${qtyRaw} pcs exceeds our largest standard quantity (10,000).`,
            requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
            escalation: 'Collect specs and tell the user a custom quote will be returned within 1 business day.',
        };
    }

    const { grid } = await loadGrid();
    const match = grid.find(row => row.Size === boundingSize && row.Quantity === roundedQty);
    if (!match) {
        return {
            error: 'pricing_lookup_failed',
            message: `No grid row for ${boundingSize} @ qty ${roundedQty}`,
        };
    }

    const requestedSizeIsSquareStandard = widthRaw === heightRaw
        && STANDARD_SIZES.includes(`${widthRaw}x${heightRaw}`);
    const sizeRule = requestedSizeIsSquareStandard
        ? null
        : `${widthRaw}"×${heightRaw}" rounds up to our ${match.Size} tier (bounding box).`;
    const qtyRule = roundedQty === qtyRaw
        ? null
        : `${qtyRaw} rounds up to our ${match.Quantity}-piece tier (next standard quantity).`;

    return {
        offGrid: false,
        partNumber: match.PartNumber,
        size: match.Size,
        quantity: match.Quantity,
        totalPrice: match.TotalPrice,
        pricePerSticker: match.PricePerSticker,
        isBestValue: !!match.IsBestValue,
        appliedRules: {
            boundingBox: sizeRule,
            quantityRoundUp: qtyRule,
        },
        requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
        setupFee: {
            partNumber: SETUP_FEE_PART,
            amount: SETUP_FEE_AMOUNT,
            note: 'One-time art setup fee — waived if customer has an existing approved design on file.',
        },
    };
}

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[contract-sticker-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    if (name === 'quote_sticker_price') {
        try {
            return await quoteStickerPrice(input);
        } catch (err) {
            console.error('[contract-sticker-ai] quote_sticker_price error:', err.message);
            return { error: err.message };
        }
    }
    if (name === 'quote_banner_price') {
        try {
            const polePockets = (input?.polePockets && input.polePockets !== 'none')
                ? input.polePockets : null;
            return await computeBannerQuote({
                widthIn: input?.widthIn,
                heightIn: input?.heightIn,
                qty: input?.qty,
                extras: {
                    grommetCount: Number(input?.grommetCount) || 0,
                    polePockets,
                    doubleSided: input?.doubleSided === true,
                },
            });
        } catch (err) {
            console.error('[contract-sticker-ai] quote_banner_price error:', err.message);
            return { error: err.message };
        }
    }
    return { error: `unknown tool: ${name}` };
}

// --- Anthropic client + context plumbing -------------------------------------

let anthropicClient = null;
function getAnthropicClient() {
    if (!anthropicClient) {
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY env var is not set on caspio-pricing-proxy. Run `heroku config:set ANTHROPIC_API_KEY=sk-ant-...` on this app.');
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

    // If the last user content is already a tool_result array (after a tool call),
    // leave it alone — never prepend CALC_CONTEXT to tool_result messages.
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
        const MAX_TOOL_ITERATIONS = 6;
        let finalStopReason = 'end_turn';

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const stream = client.messages.stream({
                model: 'claude-sonnet-4-6',
                max_tokens: 1500,
                tools: TOOLS,
                system: [
                    {
                        type: 'text',
                        text: CONTRACT_STICKER_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[contract-sticker-ai] stream error:', err.message);
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
                console.log(`[contract-sticker-ai] tool ${tu.name} → ${JSON.stringify(result).slice(0, 120)}`);
            }
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        const cacheRead = totalUsage.cache_read_input_tokens;
        const cacheWrite = totalUsage.cache_creation_input_tokens;
        console.log(`[contract-sticker-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${cacheRead} cache_write=${cacheWrite}`);
    } catch (e) {
        console.error('[contract-sticker-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
