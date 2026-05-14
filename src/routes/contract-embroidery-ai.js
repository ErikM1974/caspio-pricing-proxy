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
//   event: delta  data: { text: "..." }
//   event: done   data: { stop_reason, usage }
//   event: error  data: { message }

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { CONTRACT_EMBROIDERY_AI_SYSTEM_PROMPT } = require('../../lib/contract-embroidery-ai-prompt');

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
        const annotatedMessages = withCalcContext(messages, calcContext);

        const stream = client.messages.stream({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            system: [
                {
                    type: 'text',
                    text: CONTRACT_EMBROIDERY_AI_SYSTEM_PROMPT,
                    cache_control: { type: 'ephemeral' },
                },
            ],
            messages: annotatedMessages,
        });

        stream.on('text', (delta) => {
            sendEvent('delta', { text: delta });
        });

        stream.on('error', (err) => {
            console.error('[contract-embroidery-ai] stream error:', err.message);
            sendEvent('error', { message: err.message });
            res.end();
        });

        const finalMessage = await stream.finalMessage();
        const usage = finalMessage.usage || {};
        sendEvent('done', {
            stop_reason: finalMessage.stop_reason,
            usage: {
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
            },
        });
        res.end();

        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheWrite = usage.cache_creation_input_tokens || 0;
        console.log(`[contract-embroidery-ai] done — in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} cache_read=${cacheRead} cache_write=${cacheWrite}`);
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
