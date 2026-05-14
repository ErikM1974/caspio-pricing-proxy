// Contract Embroidery AI — quote drafting assistant.
// Streams Claude responses (SSE) for the chat panel on the contract
// embroidery page (/calculators/embroidery-contract/).
//
// Mirrors the proven pattern from policies-ai-assist.js:
//   - SSE handshake + event-by-event streaming
//   - System prompt sent with cache_control: ephemeral (90% cost reduction
//     after first request in a session, since the prompt is frozen)
//   - Token usage logged for monitoring
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {
//       product: 'garment' | 'cap' | 'fullback',
//       qty: number,
//       stitches: number,
//       baseUnit: number,     // price per piece before LTM
//       finalUnit: number,    // price per piece with LTM rolled in
//       ltmFee: number,       // 50, 100, or 0
//       ltmPerPiece: number,  // ltmFee / qty when LTM applies; 0 otherwise
//       orderTotal: number    // finalUnit * qty
//     }
//   }
//
// Response: text/event-stream
//   event: delta        data: { text: "..." }
//   event: tool_result  data: { tool: "lookup_customer", result: {...} }
//   event: done         data: { stop_reason, usage }
//   event: error        data: { message }

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { CONTRACT_EMBROIDERY_AI_SYSTEM_PROMPT } = require('../../lib/contract-embroidery-ai-prompt');

// Internal API base — we call our own routes (e.g. company-contacts) from
// within the tool-execution loop. We use the live Heroku URL rather than
// localhost so the call goes through the same TLS/middleware as any
// external request (cleaner separation of concerns; ~10ms penalty vs an
// internal short-circuit, negligible compared to a Claude API round-trip).
const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Tool definitions for Claude — Phase 2 (2026-05-14). Currently just one:
// lookup_customer wraps /api/company-contacts/search so the model can
// auto-fill the recipient's name + email when Ruthie mentions a company.
const TOOLS = [
    {
        name: 'lookup_customer',
        description:
            "Search the NWCA customer/contact database for a company or contact. " +
            "Use this whenever Ruthie mentions a customer by company name OR contact name. " +
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
];

/**
 * Execute a tool call requested by Claude. Returns a JSON-serializable
 * object that gets passed back as `tool_result` content on the next
 * model turn.
 */
// Single search call wrapping /api/company-contacts/search. Returns the
// raw contacts array (or [] on failure). Caller is responsible for
// shaping/deduping.
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

/**
 * Resilient customer lookup. The Caspio search endpoint does exact-
 * substring matching, so phrases like "Chris Donahue at Donahue Graphics"
 * match nothing — no single field contains the whole sentence. When the
 * model passes a multi-word query that returns 0 hits, we split on
 * common connectors ("at", commas, etc.) and retry each fragment,
 * deduping by ID_Contact. Reps see the matches Claude expected, even if
 * Claude got the query construction wrong.
 */
async function lookupCustomerSmart(query) {
    const q = String(query || '').trim();
    if (q.length < 2) {
        return { matches: [], error: 'query too short — needs 2+ characters', query_used: q };
    }

    // Pass 1: query as-is
    const direct = await searchContacts(q);
    if (direct.length > 0) {
        return {
            matches: shape(direct),
            count: direct.length,
            query_used: q,
        };
    }

    // Pass 2: split on connectors and try each fragment
    // Catches: "Chris Donahue at Donahue Graphics", "John, Acme Inc",
    //          "Sherry from Acme Fuel", "Acme Inc — Allison".
    const fragments = q
        .split(/\s+at\s+|\s+from\s+|\s+with\s+|\s+for\s+|[,/—–|]/i)
        .map((s) => s.trim())
        .filter((s) => s.length >= 3);

    const seen = new Set();
    const combined = [];
    const triedFragments = [];
    for (const frag of fragments) {
        if (frag === q) continue;       // already tried as direct
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
        // Phase 5 (2026-05-14): pass through Account_Owner + Email_Salesrep
        // so the saved CEMB quote_sessions row reflects the customer's
        // actual assigned rep (instead of the hardcoded "Ruthie Nhoung").
        // Email is still SIGNED by Ruthie in the body — the saved record
        // captures the relationship owner for routing/reporting.
        account_owner: c.Account_Owner || null,
        email_salesrep: c.Email_Salesrep || null,
        // Phase 5: payment terms ("Net 10", "Net 30") show in the Quote
        // Details card on the customer-facing view.
        payment_terms: c.Payment_Terms || null,
        last_ordered: c.Customerdate_LastOrdered || null,
    }));
}

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[contract-embroidery-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    return { error: `unknown tool: ${name}` };
}

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

// Sanity check + sanitize calcContext before injecting it into the
// user-facing message. Returns a compact JSON string suitable for
// embedding at the top of the user turn.
function buildCalcContextBlock(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const product = String(ctx.product || 'garment');
    const validProducts = ['garment', 'cap', 'fullback'];
    if (!validProducts.includes(product)) return null;

    const safe = {
        product,
        qty: Number(ctx.qty) || 1,
        stitches: Number(ctx.stitches) || 8000,
        baseUnit: Number(ctx.baseUnit) || 0,
        finalUnit: Number(ctx.finalUnit) || 0,
        ltmFee: Number(ctx.ltmFee) || 0,
        ltmPerPiece: Number(ctx.ltmPerPiece) || 0,
        orderTotal: Number(ctx.orderTotal) || 0,
        // Phase 4 (2026-05-14): pre-generated CEMB quote ID so the AI can
        // reference it in the subject + intro. Frontend pre-fetches one ID
        // per AI panel session via /api/quote-sequence/CEMB.
        quoteID: typeof ctx.quoteID === 'string' && ctx.quoteID ? ctx.quoteID : null,
    };
    return JSON.stringify(safe, null, 2);
}

// Take the most recent user message and prepend the CALC_CONTEXT
// block so Claude always sees the live calculator state. The history
// (prior turns) is kept verbatim — Claude reads them as normal.
function withCalcContext(messages, ctx) {
    const calcBlock = buildCalcContextBlock(ctx);
    if (!Array.isArray(messages) || messages.length === 0) return messages || [];
    if (!calcBlock) return messages;

    const idx = messages.length - 1;
    const last = messages[idx];
    if (!last || last.role !== 'user') return messages;

    const annotated = {
        role: 'user',
        content: `CALC_CONTEXT:\n${calcBlock}\n\nRUTHIE:\n${last.content}`,
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

    // SSE handshake — same as policies-ai-assist.js
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
        // Round 11 Phase 2 (2026-05-14): tool-execution loop. The model may
        // request lookup_customer mid-stream; we execute it server-side and
        // continue the stream. The frontend sees one continuous SSE stream
        // of text deltas — the tool execution is invisible.
        let workingMessages = withCalcContext(messages, calcContext);
        let totalUsage = {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        };
        const MAX_TOOL_ITERATIONS = 5;   // Safety cap — should never need more than 2-3
        let finalStopReason = 'end_turn';

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const stream = client.messages.stream({
                model: 'claude-sonnet-4-6',
                max_tokens: 1500,
                tools: TOOLS,
                system: [
                    {
                        type: 'text',
                        text: CONTRACT_EMBROIDERY_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[contract-embroidery-ai] stream error:', err.message);
                sendEvent('error', { message: err.message });
            });

            const finalMessage = await stream.finalMessage();
            const usage = finalMessage.usage || {};
            totalUsage.input_tokens += usage.input_tokens || 0;
            totalUsage.output_tokens += usage.output_tokens || 0;
            totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
            totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;

            finalStopReason = finalMessage.stop_reason;

            // If the model didn't request a tool, we're done.
            if (finalMessage.stop_reason !== 'tool_use') break;

            // Otherwise execute each tool_use block and append tool_result back.
            const toolUseBlocks = (finalMessage.content || []).filter((b) => b.type === 'tool_use');
            if (toolUseBlocks.length === 0) break;

            // Append the assistant's full content (text + tool_use blocks) verbatim
            workingMessages.push({ role: 'assistant', content: finalMessage.content });

            // Execute each tool sequentially and collect results
            const toolResults = [];
            for (const tu of toolUseBlocks) {
                const result = await executeTool(tu.name, tu.input);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify(result),
                });
                // Forward the result to the frontend too. Phase 3 (2026-05-14)
                // uses this to capture the matched customer's company name +
                // email when we save the AI-drafted quote to quote_sessions.
                sendEvent('tool_result', { tool: tu.name, result });
                console.log(`[contract-embroidery-ai] tool ${tu.name} → ${JSON.stringify(result).slice(0, 120)}`);
            }
            workingMessages.push({ role: 'user', content: toolResults });
            // Loop — call the model again with the tool results
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        const cacheRead = totalUsage.cache_read_input_tokens;
        const cacheWrite = totalUsage.cache_creation_input_tokens;
        console.log(`[contract-embroidery-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${cacheRead} cache_write=${cacheWrite}`);
    } catch (e) {
        console.error('[contract-embroidery-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
