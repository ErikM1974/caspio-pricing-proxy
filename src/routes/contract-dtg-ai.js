// Contract DTG AI — quote drafting assistant.
// Parallel to contract-embroidery-ai.js — same SSE pipeline, same
// lookup_customer tool, different prompt + calcContext shape.
//
// Streams Claude responses (SSE) for the chat panel on the contract
// DTG page (/calculators/dtg-contract/).
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {
//       qty: number,
//       locs: string[],                // ['LC', 'FF']
//       locationNames: string[],        // ['Left Chest', 'Full Front']
//       heavyweight: boolean,
//       tier: '1-23' | '24-47' | '48-71' | '72+',
//       perLocRate: number,
//       heavyweightCharge: number,      // 0 or 1.00
//       baseUnit: number,               // before LTM
//       finalUnit: number,              // after LTM rollin
//       ltmFee: number,                 // 50 when qty<=23, else 0
//       ltmPerPiece: number,
//       orderTotal: number,
//       quoteID: string | null,
//     }
//   }
//
// Response: text/event-stream (same event types as the embroidery route).

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { CONTRACT_DTG_AI_SYSTEM_PROMPT } = require('../../lib/contract-dtg-ai-prompt');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

const TOOLS = [
    {
        name: 'lookup_customer',
        description:
            "Search the NWCA customer/contact database for a company or contact. " +
            "Use this whenever Ruth mentions a customer by company name OR contact name. " +
            "Returns up to 5 matches with company, contact name, email, service rep, " +
            "and last-ordered date. Pass the most distinctive phrase.",
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
];

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
        address2: c.Address2 || null,
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

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[contract-dtg-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    return { error: `unknown tool: ${name}` };
}

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
    const validTiers = ['1-23', '24-47', '48-71', '72+'];
    const tier = String(ctx.tier || '');
    if (!validTiers.includes(tier)) return null;

    const locs = Array.isArray(ctx.locs) ? ctx.locs.filter((c) => typeof c === 'string') : [];
    const locationNames = Array.isArray(ctx.locationNames)
        ? ctx.locationNames.filter((c) => typeof c === 'string')
        : [];
    if (locs.length === 0) return null;

    const safe = {
        qty: Number(ctx.qty) || 1,
        locs,
        locationNames,
        heavyweight: !!ctx.heavyweight,
        tier,
        perLocRate: Number(ctx.perLocRate) || 0,
        heavyweightCharge: Number(ctx.heavyweightCharge) || 0,
        baseUnit: Number(ctx.baseUnit) || 0,
        finalUnit: Number(ctx.finalUnit) || 0,
        ltmFee: Number(ctx.ltmFee) || 0,
        ltmPerPiece: Number(ctx.ltmPerPiece) || 0,
        orderTotal: Number(ctx.orderTotal) || 0,
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

    const annotated = {
        role: 'user',
        content: `CALC_CONTEXT:\n${calcBlock}\n\nRUTH:\n${last.content}`,
    };
    return [...messages.slice(0, idx), annotated];
}

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
        const MAX_TOOL_ITERATIONS = 5;
        let finalStopReason = 'end_turn';

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const stream = client.messages.stream({
                model: 'claude-sonnet-4-6',
                max_tokens: 1500,
                tools: TOOLS,
                system: [
                    {
                        type: 'text',
                        text: CONTRACT_DTG_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[contract-dtg-ai] stream error:', err.message);
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
                console.log(`[contract-dtg-ai] tool ${tu.name} → ${JSON.stringify(result).slice(0, 120)}`);
            }
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        const cacheRead = totalUsage.cache_read_input_tokens;
        const cacheWrite = totalUsage.cache_creation_input_tokens;
        console.log(`[contract-dtg-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${cacheRead} cache_write=${cacheWrite}`);
    } catch (e) {
        console.error('[contract-dtg-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
