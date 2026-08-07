// 253gear product-copy drafter — streams a hook + local history for Steve to edit.
//
// Mirrors src/routes/contract-webstore-ai.js: POST /chat, text/event-stream, the same
// delta / tool_result / done / error events, so the app's AI_CHAT_ROUTES forwarder
// picks it up with a one-line change and the browser client is the existing one.
//
// WHY WEB SEARCH IS WIRED IN. The copy failures on this store were not style problems,
// they were factual ones: the Flying Boots Cafe was described as gone (it trades),
// Washington State Pride was described as a repeating pattern (it is a flag state
// shape), and "100% cotton, 6.1 oz" went onto 40 products. Giving the model a search
// tool changes the job from RECALLING a fact to CHECKING one, and the prompt requires
// a source for every claim so Steve can verify rather than trust.
//
// The system prompt lives in the Caspio config table (`description_prompt`) so Erik
// can retune the voice with no deploy. The rules below are appended to whatever he
// writes, because they are the ones that have already cost money.

'use strict';

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { webSearch } = require('../../lib/web-search');
const { loadConfig } = require('../utils/shopify-config');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;
const MAX_TOOL_ITERATIONS = 6;

let anthropicClient = null;
function getAnthropicClient() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
        anthropicClient = new Anthropic({ apiKey });
    }
    return anthropicClient;
}

/**
 * Non-negotiable rules, appended after Erik's editable prompt.
 * Every line here traces to something that actually shipped wrong.
 */
const HARD_RULES = `
NON-NEGOTIABLE RULES (these override anything above):

1. Use ONLY facts the user supplied, or facts a web_search result supports. If you
   cannot support a claim, leave it out. Never fill a gap from memory.
2. Never state or imply that a business, venue or landmark has CLOSED, moved, or is
   "long gone" unless a search result says so and you cite it. A previous description
   said the Flying Boots Cafe was gone; it is open and trading.
3. Never describe fabric, weight, blend or garment construction. Not a word. That
   copy comes from the SanMar product data, not from you.
4. Every factual sentence about the place must end with its source in the form
   [source: <domain or "Erik">]. Facts the user supplied are [source: Erik].
5. Structure: ONE short hook sentence as the first paragraph — the storefront renders
   it directly under the price — then the history. Target 200+ words total, mostly
   distinctive text. No templated filler, no "look no further", no invented nostalgia.
6. If you have too little material to reach 200 words honestly, write what you can
   support and say plainly what else you would need. A short true description beats a
   padded one.`;

const TOOLS = [{
    name: 'web_search',
    description:
        'Search the web to CHECK a fact about a place, landmark or business before writing it. ' +
        'Use it for anything you would otherwise be recalling: dates, who ran a place, ' +
        'whether it still operates. Returns titles, URLs and snippets to cite.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'What to verify, in natural language.' },
            purpose: { type: 'string', description: 'Why you are checking it (telemetry only).' }
        },
        required: ['query']
    }
}];

async function executeTool(name, input) {
    if (name === 'web_search') {
        return webSearch({
            query: String((input && input.query) || ''),
            purpose: String((input && input.purpose) || '253gear copy fact-check'),
            maxResults: 5
        });
    }
    return { error: `Unknown tool: ${name}` };
}

/**
 * Turn the structured facts pane into a first user message.
 * Kept explicit so the model can tell supplied facts (citable as Erik) from anything
 * it later finds by search.
 */
function factsMessage(facts = {}, designName, city) {
    const lines = [];
    if (designName) lines.push(`Design: ${designName}`);
    if (city) lines.push(`City / collection: ${city}`);
    const labels = {
        landmark: 'Landmark or subject',
        years: 'Years it operated',
        whoRanIt: 'Who ran it',
        whatItLookedLike: 'What it looked like',
        notes: 'Other notes',
        sources: 'Sources the user already has'
    };
    for (const [key, label] of Object.entries(labels)) {
        const v = String((facts && facts[key]) || '').trim();
        if (v) lines.push(`${label}: ${v}`);
    }
    const raw = String((facts && facts.raw) || '').trim();
    if (raw) lines.push(`\nFirst-hand notes from Erik/Steve (treat as fact, [source: Erik]):\n${raw}`);

    if (!lines.length) {
        return 'No facts supplied yet. Ask me what you need before writing anything.';
    }
    return `Write the product description from these facts.\n\n${lines.join('\n')}`;
}

// POST /api/shopify-description-ai/chat
router.post('/chat', express.json({ limit: '256kb' }), async (req, res) => {
    const { messages, facts, designName, city } = req.body || {};

    let workingMessages;
    if (Array.isArray(messages) && messages.length) {
        workingMessages = messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
            .map((m) => ({ role: m.role, content: m.content }));
    } else {
        workingMessages = [{ role: 'user', content: factsMessage(facts, designName, city) }];
    }
    if (!workingMessages.length) {
        return res.status(400).json({ error: 'messages array or facts object is required' });
    }

    let client;
    try {
        client = getAnthropicClient();
    } catch (e) {
        return res.status(503).json({ error: e.message, code: 'NOT_CONFIGURED' });
    }

    // Erik's editable voice + the rules that are not his to soften.
    let systemPrompt = HARD_RULES;
    try {
        const cfg = await loadConfig();
        if (cfg.descriptionPrompt) systemPrompt = `${cfg.descriptionPrompt}\n${HARD_RULES}`;
    } catch (e) {
        // Config missing is not fatal for drafting — the hard rules alone still produce
        // safe copy, and the publish path refuses separately if config is incomplete.
        console.warn('[shopify-description-ai] config unavailable, using hard rules only:', e.message);
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const sendEvent = (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const totalUsage = { input_tokens: 0, output_tokens: 0 };
        let finalStopReason = 'end_turn';

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const stream = client.messages.stream({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                tools: TOOLS,
                system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
                messages: workingMessages
            });

            stream.on('text', (delta) => sendEvent('delta', { text: delta }));
            stream.on('error', (err) => {
                console.error('[shopify-description-ai] stream error:', err.message);
                sendEvent('error', { message: err.message });
            });

            const finalMessage = await stream.finalMessage();
            totalUsage.input_tokens += (finalMessage.usage && finalMessage.usage.input_tokens) || 0;
            totalUsage.output_tokens += (finalMessage.usage && finalMessage.usage.output_tokens) || 0;
            finalStopReason = finalMessage.stop_reason;

            if (finalMessage.stop_reason !== 'tool_use') break;

            const toolUses = (finalMessage.content || []).filter((b) => b.type === 'tool_use');
            if (!toolUses.length) break;

            workingMessages.push({ role: 'assistant', content: finalMessage.content });
            const toolResults = [];
            for (const tu of toolUses) {
                const result = await executeTool(tu.name, tu.input);
                toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
                sendEvent('tool_result', { tool: tu.name, result });
            }
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();
        console.log(`[shopify-description-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens}`);
    } catch (e) {
        console.error('[shopify-description-ai] error:', e.message);
        sendEvent('error', {
            message: e instanceof APIError ? `Claude API error ${e.status}: ${e.message}` : e.message
        });
        res.end();
    }
});

module.exports = router;
module.exports.HARD_RULES = HARD_RULES;
module.exports.factsMessage = factsMessage;
