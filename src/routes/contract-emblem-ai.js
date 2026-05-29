// Contract Emblem AI — quote drafting assistant.
// Streams Claude responses (SSE) for the chat panel on the embroidered emblem
// calculator (/calculators/embroidered-emblem/index.html).
//
// Mirrors contract-sticker-ai.js. Single product line (emblem patches), single
// quote tool (quote_emblem_price). Pricing data and rules come from the
// existing /api/emblem-pricing endpoint (Caspio-backed with inline fallback).
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {                       // OPTIONAL — used only for the
//       quoteID: 'PATCH1115-1' | null      // pre-generated quote ID display
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
const { CONTRACT_EMBLEM_AI_SYSTEM_PROMPT } = require('../../lib/contract-emblem-ai-prompt');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Standard quantity tiers — must match the order returned by /api/emblem-pricing.
const QTY_TIERS = [25, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000];

// Standard size keys (decimal string form, as stored in the pricing grid).
const SIZE_KEYS = [
    '1.00', '1.50', '2.00', '2.50', '3.00', '3.50', '4.00', '4.50',
    '5.00', '6.00', '7.00', '8.00', '9.00', '10.00', '11.00', '12.00',
];
const SIZE_KEYS_NUM = SIZE_KEYS.map(parseFloat);

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
        name: 'quote_emblem_price',
        description:
            "Look up the price for an embroidered emblem patch order. Width and height " +
            "in inches. Applies these pricing rules automatically: " +
            "(1) SIZE TIER = (width + height) / 2, rounded UP to next standard tier " +
            "(1.00, 1.50, 2.00, 2.50, 3.00, 3.50, 4.00, 4.50, 5.00, 6.00, 7.00, 8.00, " +
            "9.00, 10.00, 11.00, 12.00 — 16 tiers). " +
            "(2) QUANTITY TIER = largest standard tier ≤ requested qty (NOT rounded up — " +
            "the customer pays the higher per-piece price until they hit the next break). " +
            "Standard qty tiers: 25, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000. " +
            "(3) LTM fee $50 distributed per-patch when qty < 200 (built into the unit price). " +
            "(4) Modifier upcharges (multiplicative on base): metallic +25%, velcro +25%, " +
            "extraColors +10% per color over 7. (5) Digitizing $100 one-time for new designs. " +
            "(6) Rush +25% on unit price for under-10-business-day production. " +
            "Returns the synthesized PartNumber (EMB-{SIZE}-{QTY}), tier breakdown, " +
            "per-patch + total prices, applied-rule descriptions, and a setup-fee note. " +
            "If size or qty exceeds the grid, returns offGrid: true — escalate to manual quote.",
        input_schema: {
            type: 'object',
            properties: {
                width: { type: 'number', description: 'Width in inches (e.g. 3, 3.5, 4)' },
                height: { type: 'number', description: 'Height in inches' },
                qty: { type: 'integer', description: 'Quantity of patches requested (minimum 25)' },
                backing: {
                    type: 'string',
                    enum: ['iron-on', 'sewn-on', 'velcro'],
                    description: 'Backing type. Iron-on and sewn-on are standard (no upcharge). Velcro adds +25%.',
                },
                metallicThread: { type: 'boolean', description: 'True if customer wants metallic thread. Adds +25%. Default false.' },
                colorCount: { type: 'integer', description: 'Number of thread colors in design (1-15). Standard pricing covers up to 7; each color over 7 adds +10%.' },
                isNewDesign: { type: 'boolean', description: 'True if this is a new design (charges $100 digitizing fee). False if customer has an existing approved .DST file with NWCA. Default true.' },
                rush: { type: 'boolean', description: 'True if customer needs production in under 10 working days. Adds 25% upcharge on unit price. Default false.' },
            },
            required: ['width', 'height', 'qty', 'backing', 'colorCount'],
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

// Module-level cache for emblem pricing data — loaded once per process restart.
// /api/emblem-pricing already caches Caspio responses, but this avoids an
// extra HTTP hop per quote_emblem_price call.
let emblemGridCache = null;
let emblemGridCacheAt = 0;
const EMBLEM_GRID_TTL_MS = 10 * 60 * 1000; // 10 min — pick up Caspio price edits without a dyno restart
async function loadEmblemPricing() {
    const now = Date.now();
    if (emblemGridCache && (now - emblemGridCacheAt) < EMBLEM_GRID_TTL_MS) return emblemGridCache;
    try {
        const r = await fetch(`${INTERNAL_API_BASE}/api/emblem-pricing`);
        if (!r.ok) throw new Error('emblem-pricing API ' + r.status);
        const data = await r.json();
        if (!data.grid || !data.rules) throw new Error('emblem-pricing returned malformed payload');
        emblemGridCache = data;
        emblemGridCacheAt = now;
        return data;
    } catch (err) {
        console.error('[contract-emblem-ai] loadEmblemPricing failed:', err.message);
        // Serve the last good cache (if any) rather than failing the quote during
        // a transient upstream blip — but log it. An inline upstream fallback is
        // still surfaced to the rep via pricingSource (see quoteEmblemPrice).
        if (emblemGridCache) {
            console.warn('[contract-emblem-ai] serving cached emblem grid after refresh failure');
            return emblemGridCache;
        }
        throw err;
    }
}

/**
 * quote_emblem_price implementation. Applies all pricing rules (size tier,
 * qty tier, LTM, modifiers, digitizing, rush) and returns a payload designed
 * to be readable by Claude AND used by the frontend (the synthesized PN
 * drives pricing-grid cell highlighting on the page).
 */
async function quoteEmblemPrice(input) {
    const widthRaw = Number(input?.width);
    const heightRaw = Number(input?.height);
    const qtyRaw = Math.trunc(Number(input?.qty));
    const colorCount = Math.max(1, Math.trunc(Number(input?.colorCount) || 1));
    const backing = String(input?.backing || 'sewn-on').toLowerCase();
    const metallicThread = input?.metallicThread === true;
    const isNewDesign = input?.isNewDesign !== false; // default true
    const rush = input?.rush === true;

    if (!Number.isFinite(widthRaw) || widthRaw <= 0
        || !Number.isFinite(heightRaw) || heightRaw <= 0
        || !Number.isFinite(qtyRaw) || qtyRaw <= 0) {
        return {
            error: 'bad_input',
            message: 'width, height, qty must all be positive numbers',
            received: { width: input?.width, height: input?.height, qty: input?.qty },
        };
    }

    if (qtyRaw < 25) {
        return {
            offGrid: true,
            reason: 'below_minimum',
            detail: `Requested ${qtyRaw} patches — our minimum is 25.`,
            requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
            escalation: 'Tell the rep our minimum is 25 patches. Offer to flex up or escalate as a one-off.',
        };
    }

    if (colorCount > 15) {
        return {
            offGrid: true,
            reason: 'too_many_colors',
            detail: `${colorCount} thread colors exceeds our 15-color max for standard pricing.`,
            requested: { width: widthRaw, height: heightRaw, qty: qtyRaw, colorCount },
            escalation: 'Collect specs and escalate as a manual quote.',
        };
    }

    // Size tier: average dimension, rounded UP to next standard size.
    const avgSize = (widthRaw + heightRaw) / 2;
    const sizeTierNum = SIZE_KEYS_NUM.find(k => k >= avgSize);
    if (sizeTierNum === undefined) {
        return {
            offGrid: true,
            reason: 'oversize_dimension',
            detail: `${widthRaw}"×${heightRaw}" averages ${avgSize.toFixed(2)}" — exceeds our largest standard size (12.00" average).`,
            requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
            escalation: 'Collect specs and escalate as a manual quote.',
        };
    }
    const sizeKey = sizeTierNum.toFixed(2);

    // Qty tier: largest standard tier ≤ requested qty.
    let qtyIdx = -1;
    for (let i = QTY_TIERS.length - 1; i >= 0; i--) {
        if (QTY_TIERS[i] <= qtyRaw) { qtyIdx = i; break; }
    }
    if (qtyIdx === -1) {
        return {
            error: 'qty_tier_lookup_failed',
            message: `Could not map qty ${qtyRaw} to a standard tier`,
        };
    }
    const qtyTier = QTY_TIERS[qtyIdx];

    // Load grid + rules
    const pricing = await loadEmblemPricing();
    const { grid, rules } = pricing;
    const pricingSource = pricing.source || 'unknown'; // 'caspio' | 'inline' | 'unknown'
    const row = grid[sizeKey];
    if (!Array.isArray(row) || row[qtyIdx] == null) {
        return {
            error: 'pricing_lookup_failed',
            message: `No grid value at ${sizeKey} × tier idx ${qtyIdx} (qty ${qtyTier})`,
        };
    }

    const basePrice = Number(row[qtyIdx]);
    const metallicPct = Number(rules.Metallic_Pct) || 0.25;
    const velcroPct = Number(rules.Velcro_Pct) || 0.25;
    const extraColorPct = Number(rules.Extra_Color_Pct) || 0.10;
    const ltmFee = Number(rules.LTM_Fee) || 50.00;
    const ltmThreshold = Number(rules.LTM_Threshold) || 200;
    const digitizingFee = Number(rules.Digitizing_Fee) || 100.00;

    // Modifier percentage stack (multiplicative on base)
    let addOnPercentage = 0;
    if (metallicThread) addOnPercentage += metallicPct;
    if (backing === 'velcro') addOnPercentage += velcroPct;
    const extraColors = Math.max(0, colorCount - 7);
    addOnPercentage += extraColors * extraColorPct;

    const addOnCost = basePrice * addOnPercentage;

    // LTM: distributed per-patch
    const ltmApplies = qtyRaw < ltmThreshold;
    const ltmPerPatch = ltmApplies ? (ltmFee / qtyRaw) : 0;

    // Rush: applied on top of (basePrice + addOnCost) per-patch
    const rushMultiplier = rush ? 1.25 : 1.0;
    const pricePerPatchPreLTM = (basePrice + addOnCost) * rushMultiplier;
    const pricePerPatch = Math.round((pricePerPatchPreLTM + ltmPerPatch) * 100) / 100;
    const totalPrice = Math.round(pricePerPatch * qtyRaw * 100) / 100;

    // Synthesize the PartNumber. Frontend uses this to highlight the grid cell.
    const partNumber = `EMB-${sizeKey}-${qtyTier}`;

    // Build applied-rules descriptions (only non-null when relevant)
    const sizeRule = (Number(widthRaw) === Number(heightRaw)
        && SIZE_KEYS_NUM.includes(Number(widthRaw)))
        ? null
        : `${widthRaw}"×${heightRaw}" averages ${avgSize.toFixed(2)}" — quoted at our ${sizeKey}" tier.`;
    const qtyRule = qtyTier === qtyRaw
        ? null
        : `${qtyRaw} maps to the ${qtyTier}-piece tier (next break is ${QTY_TIERS[qtyIdx + 1] || 'N/A'} for a lower per-patch rate).`;
    const rushRule = rush
        ? `25% rush upcharge applied for under-10-business-day production.`
        : null;

    return {
        offGrid: false,
        pricingSource,
        partNumber,
        size: sizeKey,
        quantity: qtyTier,
        requestedQuantity: qtyRaw,
        totalPrice,
        pricePerPatch,
        basePrice,
        backing,
        colorCount,
        modifiers: {
            metallicThread,
            velcroBacking: backing === 'velcro',
            extraColors,
            addOnPercentage: Math.round(addOnPercentage * 10000) / 10000,
        },
        ltm: {
            applies: ltmApplies,
            perPatchAmount: Math.round(ltmPerPatch * 100) / 100,
            threshold: ltmThreshold,
            feeAmount: ltmFee,
        },
        appliedRules: {
            sizeTier: sizeRule,
            quantityTier: qtyRule,
            rush: rushRule,
        },
        digitizingFee: {
            partNumber: 'DIG-100',
            amount: digitizingFee,
            include: isNewDesign,
            note: isNewDesign
                ? 'One-time fee — covers digitizing artwork into a .DST embroidery file with one round of sew-out proof.'
                : 'Waived — existing design on file.',
        },
        requested: { width: widthRaw, height: heightRaw, qty: qtyRaw, backing, metallicThread, colorCount, isNewDesign, rush },
    };
}

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[contract-emblem-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    if (name === 'quote_emblem_price') {
        try {
            return await quoteEmblemPrice(input);
        } catch (err) {
            console.error('[contract-emblem-ai] quote_emblem_price error:', err.message);
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
                        text: CONTRACT_EMBLEM_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[contract-emblem-ai] stream error:', err.message);
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
                console.log(`[contract-emblem-ai] tool ${tu.name} → ${JSON.stringify(result).slice(0, 120)}`);
            }
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        const cacheRead = totalUsage.cache_read_input_tokens;
        const cacheWrite = totalUsage.cache_creation_input_tokens;
        console.log(`[contract-emblem-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${cacheRead} cache_write=${cacheWrite}`);
    } catch (e) {
        console.error('[contract-emblem-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
