// Web search client for AI bots.
//
// Wraps the Tavily Search API (https://tavily.com/) — purpose-built for
// LLM agents. Returns clean snippets without the noise of raw HTML
// scraping. Free tier: 1,000 searches/month; paid: $0.005/query.
//
// Auth: requires TAVILY_API_KEY env var on the proxy Heroku app.
//   heroku config:set TAVILY_API_KEY=tvly-... --app caspio-pricing-proxy
//
// Graceful degradation: if the key is missing or Tavily returns an error,
// returns { error: '...' } so the bot can tell the rep "web search
// unavailable" instead of hanging.

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

/**
 * Search the web via Tavily.
 *
 * @param {Object} params
 * @param {string} params.query - Natural-language search query.
 * @param {string} [params.purpose] - Optional context, logged for telemetry only.
 * @param {number} [params.maxResults=5] - Max results to return (1-10).
 * @param {string} [params.searchDepth='basic'] - 'basic' (faster, free) or 'advanced' (deeper, paid tier).
 * @returns {Promise<Object>} {results: [{title, url, snippet, score}, ...], answer?: string} OR {error: string}.
 */
async function webSearch({ query, purpose, maxResults = 5, searchDepth = 'basic' } = {}) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
        return {
            error: 'web_search_unavailable',
            message: 'TAVILY_API_KEY env var is not set on this Heroku app. Set it with `heroku config:set TAVILY_API_KEY=tvly-... --app caspio-pricing-proxy` (free key at tavily.com). Bot should tell the rep web search is offline.',
        };
    }
    const trimmed = String(query || '').trim();
    if (trimmed.length < 3) {
        return {
            error: 'bad_query',
            message: 'Query too short — needs 3+ characters.',
        };
    }

    const payload = {
        api_key: apiKey,
        query: trimmed,
        search_depth: searchDepth === 'advanced' ? 'advanced' : 'basic',
        include_answer: true,
        max_results: Math.max(1, Math.min(10, Number(maxResults) || 5)),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000); // 15s hard timeout

    try {
        const resp = await fetch(TAVILY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            console.warn('[web-search] Tavily HTTP', resp.status, text.slice(0, 200));
            return {
                error: 'tavily_http_error',
                message: `Tavily returned HTTP ${resp.status}. ${text.slice(0, 120)}`,
            };
        }

        const data = await resp.json();
        const results = Array.isArray(data.results) ? data.results.slice(0, payload.max_results) : [];
        const shaped = results.map((r) => ({
            title: r.title || '',
            url: r.url || '',
            snippet: (r.content || r.snippet || '').slice(0, 500),
            score: typeof r.score === 'number' ? r.score : null,
        }));

        const out = {
            query_used: trimmed,
            purpose: purpose || null,
            results: shaped,
            result_count: shaped.length,
        };
        // Tavily's synthesized answer is gold for LLM consumption when present
        if (data.answer && typeof data.answer === 'string') {
            out.answer = data.answer.slice(0, 2000);
        }
        return out;
    } catch (err) {
        if (err.name === 'AbortError') {
            return { error: 'timeout', message: 'Web search timed out after 15s.' };
        }
        console.error('[web-search] error:', err.message);
        return { error: 'network', message: err.message };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { webSearch };
