// Policies Hub — AI semantic search.
// Public endpoint (no CRM auth) so any logged-in staff member can ask
// natural-language questions and get matched to relevant policies.
//
// Rate-limited at the mount in server.js to prevent abuse.
//
// Flow: client POSTs {query}; we fetch the current policy index from Caspio
// (just title/summary/category — small footprint, ~50 tokens/policy), build
// a compact prompt, call Claude Sonnet 4.6, and return ranked results as JSON.
// No streaming — single short response, easier UX.

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE = 'Policies';

let anthropicClient = null;
function getAnthropicClient() {
    if (!anthropicClient) {
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY env var is not set.');
        }
        anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return anthropicClient;
}

// Compact system prompt — cached via cache_control. Tells Claude exactly
// what shape of JSON to return so the client doesn't need to parse prose.
const SYSTEM_PROMPT = `You are a search assistant for Northwest Custom Apparel's internal Policies Hub.

When a staff member asks a question or describes what they're looking for, your job is to find the most relevant policies from the index they provide. Return ONLY a JSON object with this exact shape:

{
  "results": [
    {
      "policy_id": "the-slug-from-the-index",
      "confidence": "high" | "medium" | "low",
      "why": "One short sentence explaining why this policy matches the user's question."
    }
  ]
}

Rules:
- Return at most 5 results, ranked most-relevant first.
- If no policy is genuinely relevant, return {"results": []}. Don't pad with weak matches.
- "confidence":
  - "high" = the policy directly answers the user's question
  - "medium" = related but not a perfect match
  - "low" = tangentially related, only include if there's nothing better
- "why" must be a single sentence, plain English, addressing the user ("This explains how to…").
- Never invent a policy_id that's not in the provided index.
- Never include explanatory text outside the JSON. Output JSON and nothing else.`;

router.post('/', express.json({ limit: '64kb' }), async (req, res) => {
    const query = (req.body && typeof req.body.query === 'string') ? req.body.query.trim() : '';

    if (!query) {
        return res.status(400).json({ error: 'Missing or empty query' });
    }
    if (query.length > 300) {
        return res.status(400).json({ error: 'Query too long (max 300 chars)' });
    }

    let client;
    try {
        client = getAnthropicClient();
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }

    try {
        // Pull the live index — just Title/Summary/Category, Published+Active only.
        // We deliberately do NOT include Body_HTML — Claude can infer relevance from
        // titles+summaries, and including bodies would push the prompt past 100K tokens
        // once the policy count grows.
        const records = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
            'q.where': `Status='Published' AND Is_Active=1`,
            'q.select': 'Policy_ID,Title,Summary,Category',
            'q.limit': 500
        });

        if (records.length === 0) {
            return res.json({ results: [], policies_searched: 0 });
        }

        // Build a compact, scannable index. ~50-100 tokens per policy.
        const indexLines = records.map(r =>
            `- ${r.Policy_ID} | [${r.Category}] ${r.Title} | ${r.Summary || '(no summary)'}`
        );
        const indexText = indexLines.join('\n');

        const userMessage = `User's question: "${query}"

POLICY INDEX (one per line: policy_id | [category] title | summary):
${indexText}

Find the most relevant policies. Return JSON only.`;

        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            system: [
                {
                    type: 'text',
                    text: SYSTEM_PROMPT,
                    cache_control: { type: 'ephemeral' }
                }
            ],
            messages: [{ role: 'user', content: userMessage }]
        });

        // Extract text from the response
        const text = (response.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('')
            .trim();

        // Parse JSON. Be defensive — strip code fences if Claude wraps in ```json ... ```
        let parsed;
        try {
            const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
            parsed = JSON.parse(cleaned);
        } catch (parseErr) {
            console.error('[ai-search] failed to parse Claude response:', text.slice(0, 200));
            return res.status(502).json({
                error: 'AI returned unparseable response',
                raw: text.slice(0, 500)
            });
        }

        // Hydrate results with Title/Category/Summary from our local index
        // so the client doesn't need a follow-up fetch.
        const byId = new Map(records.map(r => [r.Policy_ID, r]));
        const hydrated = (parsed.results || []).map(r => {
            const meta = byId.get(r.policy_id);
            return {
                policy_id: r.policy_id,
                confidence: r.confidence || 'medium',
                why: r.why || '',
                // Only include if the model returned a valid id
                ...(meta ? {
                    Title: meta.Title,
                    Category: meta.Category,
                    Summary: meta.Summary
                } : {})
            };
        }).filter(r => byId.has(r.policy_id)); // drop hallucinated ids

        const usage = response.usage || {};
        console.log(`[ai-search] query="${query.slice(0, 60)}" results=${hydrated.length} in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0}`);

        res.json({
            query,
            results: hydrated,
            policies_searched: records.length,
            usage: {
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                cache_read_input_tokens: usage.cache_read_input_tokens || 0
            }
        });
    } catch (e) {
        console.error('[ai-search] error:', e.message);
        if (e instanceof APIError) {
            res.status(502).json({ error: `Claude API error ${e.status}: ${e.message}` });
        } else {
            res.status(500).json({ error: e.message || 'Search failed' });
        }
    }
});

module.exports = router;
