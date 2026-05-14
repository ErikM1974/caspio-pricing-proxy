// Policies Hub — AI Assist route.
// Streams Claude responses (SSE) for the TipTap editor's "AI Assist" panel.
// This route is protected upstream by requireCrmApiSecret (applied at mount
// time in server.js), so the only callers are role-gated frontends.
//
// System prompt is frozen (NWCA voice + style + action definitions) and
// cached via cache_control: ephemeral — only one author (Erik) hits this
// endpoint during a writing session, so cache reads dominate cost after
// the first request.

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { POLICY_AI_SYSTEM_PROMPT } = require('../../lib/policy-ai-prompt');

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

const VALID_AI_ACTIONS = new Set([
    'generate-from-prompt',
    'polish-draft',
    'expand-section',
    'summarize-section',
    'add-faq',
    'translate-to-spanish'
]);

// Build a focused user message from the action + context the editor sent.
// Keeps the system prompt (cached) frozen and varies only the user turn.
function buildUserMessage({ action, prompt, selectedText, surroundingContext, title, category }) {
    const lines = [`ACTION: ${action}`];
    if (title) lines.push(`POLICY TITLE: ${title}`);
    if (category) lines.push(`CATEGORY: ${category}`);

    if (action === 'generate-from-prompt') {
        lines.push('', 'USER PROMPT:', prompt || '(no prompt provided — generate based on title and category)');
    } else if (action === 'add-faq') {
        lines.push('', 'POLICY CONTENT (use this to derive realistic questions):',
            surroundingContext || selectedText || '(no content provided)');
    } else if (action === 'translate-to-spanish') {
        lines.push('', 'CONTENT TO TRANSLATE:', selectedText || surroundingContext || '(no content provided)');
    } else {
        // polish-draft / expand-section / summarize-section
        if (selectedText) lines.push('', 'SELECTED TEXT (the part to operate on):', selectedText);
        if (surroundingContext && surroundingContext !== selectedText) {
            lines.push('', 'SURROUNDING CONTEXT (for reference — do NOT include in your output):', surroundingContext);
        }
        if (prompt) lines.push('', 'ADDITIONAL INSTRUCTIONS FROM AUTHOR:', prompt);
    }

    return lines.join('\n');
}

router.post('/', express.json({ limit: '1mb' }), async (req, res) => {
    const { action, prompt, selectedText, surroundingContext, title, category } = req.body || {};

    if (!action || !VALID_AI_ACTIONS.has(action)) {
        return res.status(400).json({
            error: 'Invalid action',
            valid: Array.from(VALID_AI_ACTIONS)
        });
    }

    let client;
    try {
        client = getAnthropicClient();
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }

    // SSE handshake
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const sendEvent = (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const userMessage = buildUserMessage({ action, prompt, selectedText, surroundingContext, title, category });

        const stream = client.messages.stream({
            model: 'claude-sonnet-4-6',
            max_tokens: 4000,
            // Adaptive thinking: Sonnet 4.6 supports it; lets the model decide when to think.
            // Skipping for now — adds latency, and policy edits are fast-feedback.
            // thinking: { type: 'adaptive' },
            system: [
                {
                    type: 'text',
                    text: POLICY_AI_SYSTEM_PROMPT,
                    cache_control: { type: 'ephemeral' }
                }
            ],
            messages: [{ role: 'user', content: userMessage }]
        });

        stream.on('text', (delta) => {
            sendEvent('delta', { text: delta });
        });

        stream.on('error', (err) => {
            console.error('[ai-assist] stream error:', err.message);
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
                cache_creation_input_tokens: usage.cache_creation_input_tokens || 0
            }
        });
        res.end();

        // Log cache effectiveness for ongoing tuning
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheWrite = usage.cache_creation_input_tokens || 0;
        console.log(`[ai-assist] ${action} done — in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} cache_read=${cacheRead} cache_write=${cacheWrite}`);
    } catch (e) {
        console.error('[ai-assist] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
