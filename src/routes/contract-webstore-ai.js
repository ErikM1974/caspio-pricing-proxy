// Contract Webstore AI — quote drafting + Q&A assistant.
// Streams Claude responses (SSE) for the chat panel on the webstores page
// (/calculators/webstores.html).
//
// Mirrors contract-sticker-ai.js / contract-emblem-ai.js. Two product
// modes through one chat (webstore-setup + fundraiser-item, like sticker
// handles sticker + banner). Four tools: lookup_customer + 2 pricing
// tools + web_search (NEW capability — see lib/web-search.js).
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {                       // OPTIONAL
//       quoteID: 'WEB-2026-007' | null
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
const { CONTRACT_WEBSTORE_AI_SYSTEM_PROMPT } = require('../../lib/contract-webstore-ai-prompt');
const { webSearch } = require('../../lib/web-search');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Fixed pricing constants — keep in sync with webstores-calculator.js
// frontend defaults and webstores-quote-service.js save shape.
const WEBSTORE_SETUP_FEE = 300.00;
const LOGO_DIGIT_FEE = 100.00;
const SURCHARGE_OPEN_CLOSE = 2.00;
const SURCHARGE_ON_DEMAND = 10.00;
const ANNUAL_MINIMUM = 2000.00;

// Fundraiser pricing defaults — match webstores-fundraiser.js line 71-74
const FUNDRAISER_DEFAULTS = {
    margin: 0.43,
    ccFee: 0.035,
    embellishment: 15.00,
    decorationCost: 8.00,
};
const ONE_NINETY_NINE_THRESHOLD = 600.00; // IRS 1099-NEC reporting threshold

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
        name: 'quote_webstore_setup',
        description:
            "Quote a new corporate webstore SETUP. Computes one-time setup fee + logo " +
            "digitization fee, identifies the per-item surcharge based on store type, " +
            "and returns the total + annual minimum context. " +
            "Pricing: $300 setup (flat) + $100 per logo (0-10 typical). " +
            "Surcharge: Open/Close stores = $2/item sold, On-Demand stores = $10/item. " +
            "Annual minimum: $2,000 in store sales/year. " +
            "Returns a structured payload designed for the PRICE_QUOTE block and frontend " +
            "store-quote card.",
        input_schema: {
            type: 'object',
            properties: {
                storeType: {
                    type: 'string',
                    enum: ['Open/Close', 'On-Demand'],
                    description: 'Open/Close = seasonal/campaign-driven ($2/item). On-Demand = year-round ($10/item).',
                },
                logoCount: {
                    type: 'integer',
                    description: 'Number of logos to digitize. 0 if customer already has approved designs on file. Typical 1-3.',
                },
                expectedAnnualVolume: {
                    type: 'integer',
                    description: 'Estimated annual items sold through the store. Used to flag whether the $2K annual minimum is at risk.',
                },
                existingArt: {
                    type: 'boolean',
                    description: 'True if customer has approved artwork on file with NWCA (waives logo fee even if logoCount > 0). Default false.',
                },
            },
            required: ['storeType', 'logoCount'],
        },
    },
    {
        name: 'quote_fundraiser_pricing',
        description:
            "Compute the supporter-facing sell price for a fundraiser item. Customer " +
            "specifies a blank garment cost + donation amount per item; tool computes the " +
            "rounded-up sell price that recovers margin, embellishment, donation, CC fee. " +
            "Formula: (blankCost / (1 - margin) + embellishment + donation) / (1 - ccFee), " +
            "rounded UP to nearest $5. " +
            "Defaults: margin 43%, ccFee 3.5%, embellishment $15, decorationCost $8 — " +
            "advanced reps may override. " +
            "Also flags the IRS $600 1099-NEC threshold if (donation × estimated annual " +
            "volume) > $600. " +
            "Returns full breakdown for the PRICE_QUOTE block.",
        input_schema: {
            type: 'object',
            properties: {
                blankCost: { type: 'number', description: 'Blank garment cost (what NWCA pays for the blank).' },
                donation: { type: 'number', description: 'Donation per item back to the customer program ($).' },
                margin: { type: 'number', description: 'Margin on blanks as decimal (0.43 = 43%). Default 0.43.' },
                ccFee: { type: 'number', description: 'Credit card processing fee as decimal (0.035 = 3.5%). Default 0.035.' },
                embellishment: { type: 'number', description: 'Embellishment fee per item. Default $15.00.' },
                decorationCost: { type: 'number', description: 'NWCA actual decoration cost (informational). Default $8.00.' },
                estimatedAnnualVolume: { type: 'integer', description: 'Estimated number of items sold per year. Used to flag $600 1099-NEC threshold.' },
            },
            required: ['blankCost', 'donation'],
        },
    },
    {
        name: 'web_search',
        description:
            "Search the live internet for information outside your training data. " +
            "USE WHEN: the customer asks about a competitor's pricing, current industry " +
            "events, recent regulation changes, specific InkSoft features outside this " +
            "prompt's knowledge, or general apparel-industry questions. " +
            "DO NOT USE for: questions this prompt already answers (webstore pricing, " +
            "setup process, basic platform info), hypotheticals, or opinion questions. " +
            "Returns 3-5 web results with title, URL, snippet + (when available) a " +
            "synthesized one-sentence answer. Cite the source URL inline when relaying " +
            "results to the rep.",
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query in natural language (e.g. "Spirit Sale webstore setup fee", "WA apparel sales tax 2026").' },
                purpose: { type: 'string', description: '1-sentence why-you-need-this. Helps you reason about whether the result is on-topic.' },
            },
            required: ['query'],
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

function quoteWebstoreSetup(input) {
    const storeType = String(input?.storeType || '').trim();
    const logoCount = Math.max(0, Math.trunc(Number(input?.logoCount) || 0));
    const expectedAnnualVolume = Math.max(0, Math.trunc(Number(input?.expectedAnnualVolume) || 0));
    const existingArt = input?.existingArt === true;

    if (!['Open/Close', 'On-Demand'].includes(storeType)) {
        return {
            error: 'bad_input',
            message: `storeType must be "Open/Close" or "On-Demand", got "${storeType}".`,
        };
    }
    if (logoCount > 20) {
        return {
            error: 'bad_input',
            message: `logoCount ${logoCount} is unusually high. Confirm with the rep — most stores use 1-3 logos.`,
        };
    }

    const setupFee = WEBSTORE_SETUP_FEE;
    const logoFee = existingArt ? 0 : (logoCount * LOGO_DIGIT_FEE);
    const totalSetup = setupFee + logoFee;
    const surchargePerItem = storeType === 'On-Demand' ? SURCHARGE_ON_DEMAND : SURCHARGE_OPEN_CLOSE;

    const annualSurchargeEst = expectedAnnualVolume > 0
        ? Math.round(expectedAnnualVolume * surchargePerItem * 100) / 100
        : null;

    const minimumAtRisk = expectedAnnualVolume > 0 && expectedAnnualVolume < (ANNUAL_MINIMUM / surchargePerItem);

    const lineItems = [
        {
            partNumber: 'WEBSTORE-SETUP',
            description: 'Web Store Setup Fee',
            quantity: 1,
            totalPrice: setupFee,
            pricePerUnit: setupFee,
        },
    ];
    if (!existingArt && logoCount > 0) {
        lineItems.push({
            partNumber: 'LOGO-DIGIT',
            description: `Logo Digitization (${logoCount} logo${logoCount === 1 ? '' : 's'})`,
            quantity: logoCount,
            totalPrice: logoFee,
            pricePerUnit: LOGO_DIGIT_FEE,
        });
    }

    return {
        productType: 'webstore-setup',
        partNumber: `WEB-SETUP-${storeType.replace(/\W/g, '')}`,
        storeType,
        logoCount,
        existingArt,
        setupFee,
        logoFee,
        totalSetup,
        surchargePerItem,
        annualMinimum: ANNUAL_MINIMUM,
        expectedAnnualVolume: expectedAnnualVolume || null,
        annualSurchargeEst,
        minimumAtRisk,
        lineItems,
        appliedRules: {
            existingArtWaiver: existingArt && logoCount > 0 ? `Logo fee waived — ${logoCount} existing design${logoCount === 1 ? '' : 's'} on file.` : null,
            minimumRisk: minimumAtRisk ? `At ${expectedAnnualVolume} items/year, the $${ANNUAL_MINIMUM}/year minimum may not be met. Annual shortfall billing could apply.` : null,
        },
    };
}

function quoteFundraiserPricing(input) {
    const blankCost = Number(input?.blankCost);
    const donation = Number(input?.donation);
    const margin = Number.isFinite(Number(input?.margin)) ? Number(input.margin) : FUNDRAISER_DEFAULTS.margin;
    const ccFee = Number.isFinite(Number(input?.ccFee)) ? Number(input.ccFee) : FUNDRAISER_DEFAULTS.ccFee;
    const embellishment = Number.isFinite(Number(input?.embellishment)) ? Number(input.embellishment) : FUNDRAISER_DEFAULTS.embellishment;
    const decorationCost = Number.isFinite(Number(input?.decorationCost)) ? Number(input.decorationCost) : FUNDRAISER_DEFAULTS.decorationCost;
    const estimatedAnnualVolume = Math.max(0, Math.trunc(Number(input?.estimatedAnnualVolume) || 0));

    if (!Number.isFinite(blankCost) || blankCost < 0) {
        return { error: 'bad_input', message: 'blankCost must be a non-negative number.' };
    }
    if (!Number.isFinite(donation) || donation < 0) {
        return { error: 'bad_input', message: 'donation must be a non-negative number.' };
    }
    if (margin >= 1 || margin < 0) {
        return { error: 'bad_input', message: `margin ${margin} out of range (must be 0 ≤ m < 1, e.g. 0.43 for 43%).` };
    }
    if (ccFee >= 1 || ccFee < 0) {
        return { error: 'bad_input', message: `ccFee ${ccFee} out of range (must be 0 ≤ f < 1, e.g. 0.035 for 3.5%).` };
    }

    // Formula (matches webstores-fundraiser.js:93)
    const blankWithMargin = blankCost / (1 - margin);
    const preCcSubtotal = blankWithMargin + embellishment + donation;
    const priceBeforeRound = preCcSubtotal / (1 - ccFee);
    const sellPrice = Math.ceil(priceBeforeRound / 5) * 5;
    const roundUpCushion = Math.round((sellPrice - priceBeforeRound) * 100) / 100;
    const ccFeeRecovery = Math.round((priceBeforeRound - preCcSubtotal) * 100) / 100;

    // Profit calc (informational — for breakdown display)
    const actualNwcaRevenue = sellPrice - donation - (sellPrice * ccFee);
    const actualNwcaCost = blankCost + decorationCost;
    const actualProfit = Math.round((actualNwcaRevenue - actualNwcaCost) * 100) / 100;

    // 1099-NEC threshold flag
    const annualDonationEst = estimatedAnnualVolume * donation;
    const taxThresholdHit = annualDonationEst > ONE_NINETY_NINE_THRESHOLD;

    return {
        productType: 'fundraiser-item',
        partNumber: 'FUNDRAISER-ITEM',
        pricing: {
            blankCost,
            donation,
            margin,
            ccFee,
            embellishment,
            decorationCost,
            priceBeforeRound: Math.round(priceBeforeRound * 100) / 100,
            sellPrice,
            roundUpCushion,
            estimatedAnnualVolume: estimatedAnnualVolume || null,
            estimatedAnnualDonation: estimatedAnnualVolume > 0 ? Math.round(annualDonationEst * 100) / 100 : null,
            estimatedProfit: actualProfit,
        },
        breakdown: {
            blankWithMargin: Math.round(blankWithMargin * 100) / 100,
            embellishmentFee: embellishment,
            donationBuiltIn: donation,
            ccFeeRecovery,
            roundedUpCushion: roundUpCushion,
        },
        appliedRules: {
            rounding: `Pre-round price $${priceBeforeRound.toFixed(2)} rounded UP to nearest $5 = $${sellPrice}.00 (+$${roundUpCushion} cushion for NWCA).`,
            taxThreshold: taxThresholdHit
                ? `Annual donation est $${annualDonationEst.toFixed(2)} exceeds $${ONE_NINETY_NINE_THRESHOLD} IRS reporting threshold — NWCA will issue a 1099-NEC at year-end.`
                : null,
            defaultsUsed: (
                margin === FUNDRAISER_DEFAULTS.margin
                && ccFee === FUNDRAISER_DEFAULTS.ccFee
                && embellishment === FUNDRAISER_DEFAULTS.embellishment
            ) ? 'Standard defaults applied (43% margin, 3.5% CC fee, $15 embellishment).' : null,
        },
    };
}

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[contract-webstore-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    if (name === 'quote_webstore_setup') {
        try {
            return quoteWebstoreSetup(input);
        } catch (err) {
            console.error('[contract-webstore-ai] quote_webstore_setup error:', err.message);
            return { error: err.message };
        }
    }
    if (name === 'quote_fundraiser_pricing') {
        try {
            return quoteFundraiserPricing(input);
        } catch (err) {
            console.error('[contract-webstore-ai] quote_fundraiser_pricing error:', err.message);
            return { error: err.message };
        }
    }
    if (name === 'web_search') {
        try {
            return await webSearch({
                query: input?.query,
                purpose: input?.purpose,
                maxResults: 5,
                searchDepth: 'basic',
            });
        } catch (err) {
            console.error('[contract-webstore-ai] web_search error:', err.message);
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
        // Bumped from 6 to 8 because webstore bot has 4 tools (vs 2-3 in
        // sticker/emblem) — may chain web_search → lookup → quote in one turn.
        const MAX_TOOL_ITERATIONS = 8;
        let finalStopReason = 'end_turn';

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const stream = client.messages.stream({
                model: 'claude-sonnet-4-6',
                max_tokens: 1800, // slightly higher than sticker/emblem because Q&A answers can be longer
                tools: TOOLS,
                system: [
                    {
                        type: 'text',
                        text: CONTRACT_WEBSTORE_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[contract-webstore-ai] stream error:', err.message);
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
                console.log(`[contract-webstore-ai] tool ${tu.name} → ${JSON.stringify(result).slice(0, 120)}`);
            }
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        const cacheRead = totalUsage.cache_read_input_tokens;
        const cacheWrite = totalUsage.cache_creation_input_tokens;
        console.log(`[contract-webstore-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${cacheRead} cache_write=${cacheWrite}`);
    } catch (e) {
        console.error('[contract-webstore-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
