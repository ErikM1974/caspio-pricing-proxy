// EMB Quote AI — research assistant for the Embroidery Quote Builder.
//
// Streams Claude responses (SSE) for the chat panel on
// /quote-builders/embroidery-quote-builder.html.
//
// Tools (3): lookup_customer, recommend_top_sellers_emb, lookup_product_details.
// NO pricing tool — rep computes pricing in the form. NO web_search — defer.
//
// Mirrors src/routes/dtg-quote-ai.js. Tool implementations for lookup_customer
// + lookup_product_details are cloned from the DTG route (they hit shared
// proxy infrastructure — /api/company-contacts/search + /api/dtg/product-bundle —
// so the implementations are method-agnostic). Future cleanup: extract to a
// shared lib/quote-ai-shared-tools.js module.
//
// Request body:
//   {
//     messages: [{ role: 'user' | 'assistant', content: string }, ...],
//     calcContext: {                  // OPTIONAL
//       quoteID: 'EMB-2026-088' | null
//     }
//   }
//
// Response: text/event-stream
//   event: delta        data: { text: "..." }
//   event: tool_result  data: { tool: "...", result: {...} }
//   event: done         data: { stop_reason, usage }
//   event: error        data: { message }
//
// Created 2026-05-24 — EMB Chat B (Phase 11 unified UX rollout).

const express = require('express');
const router = express.Router();
const { Anthropic, APIError } = require('@anthropic-ai/sdk');
const { CONTRACT_EMB_QUOTE_AI_SYSTEM_PROMPT } = require('../../lib/emb-quote-ai-prompt');
const { EMB_CURATED_PRODUCTS } = require('../../lib/emb-curated-products');
const { inferIndustry } = require('../../lib/industry-inference');
const { webSearch } = require('../../lib/web-search');
const embPricingCache = require('../../lib/emb-pricing-cache');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Loopback calls to now-gated internal endpoints (customer-profile, industry-lookalikes)
// must carry the CRM secret — INTERNAL_API_BASE is the PUBLIC proxy URL, so these
// requests pass back through requireCrmApiSecret. Same-process, so the env var is present.
const INTERNAL_AUTH_HEADERS = process.env.CRM_API_SECRET
    ? { 'x-crm-api-secret': process.env.CRM_API_SECRET }
    : {};

const TOOLS = [
    {
        name: 'lookup_customer',
        description:
            "Search the NWCA customer/contact database for a company or contact. " +
            "Use this whenever the user mentions a customer by company name OR contact name. " +
            "Returns up to 5 matches with company, contact name, email, service rep, " +
            "last-ordered date, AND (as of E2): Customer_Type (Erik's manual industry " +
            "classification — 15 buckets like Construction, Corporate, Food Service, " +
            "Fire/Police, School, Medical, Military, Retail, Religious, etc.), " +
            "Account_Tier (GOLD/SILVER/BRONZE/Win Back/House), YTD_Sales (year-to-date $), " +
            "Customer_Warning (any rep alert), Is_Active/Is_Dead/Is_Stale flags.\n\n" +
            "After this returns a match with id_Customer, IMMEDIATELY call " +
            "lookup_customer_master_profile(idCustomer) to get the customer's full 10-year " +
            "buying history — top styles, top brands, last bought, reorder probability. " +
            "That's what makes the bot sound like a senior AE.\n\n" +
            "Pass the most distinctive phrase (e.g. 'Acme Fuel' or 'Allison Dumas' or an email fragment).",
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
        name: 'recommend_top_sellers_emb',
        description:
            "Return NWCA's actual top-selling EMBROIDERY products from the curated " +
            "10-year sales data. Use when the rep asks 'what's our best polo for embroidery?' " +
            "/ 'top sellers' / 'what do you recommend for a hoodie?' / 'best Carhartt?' / " +
            "'top Nike?' / 'what Richardson do we sell?'. Filter by category OR brand OR both. " +
            "Each product returned includes real sales numbers, top 4 colors with units, and " +
            "swatch image URLs.",
        input_schema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description:
                        'Category filter (OPTIONAL). Common values: "T-Shirt", "Polo", "Sweatshirt", ' +
                        '"Hoodie", "Jacket", "Cap", "Beanie", "Bag", "Workwear", "Woven Shirt", ' +
                        '"Activewear", "Accessory", or "any" for mixed across all categories. ' +
                        'Omit to allow any category.',
                },
                brand: {
                    type: 'string',
                    description:
                        'Brand filter (OPTIONAL). Common values from NWCA top sellers: ' +
                        '"Port Authority", "Port & Co", "Carhartt", "Sport-Tek", "Nike", ' +
                        '"OGIO", "CornerStone", "Red Kap", "Gildan", "New Era", "Richardson", ' +
                        '"Eddie Bauer", "The North Face". Case-insensitive partial match — ' +
                        '"Carhartt" matches Carhartt, "Port" matches both Port Authority and Port & Co. ' +
                        'If the brand has NO entries in our curated top sellers, the tool returns ' +
                        'count:0 — when that happens, tell the rep we do not have that brand in our ' +
                        'top embroidery sellers and suggest a close equivalent we DO carry.',
                },
                limit: { type: 'integer', description: 'Max products to return (1-10). Default 3.' },
            },
        },
    },
    {
        name: 'lookup_product_details',
        description:
            "Look up the ACTUAL catalog details for a SanMar/NWCA style number — colors, sizes, " +
            "size upcharges, product title/description. Calls /api/dtg/product-bundle (returns " +
            "generic SanMar data — works for EMB too). " +
            "USE WHENEVER: the rep asks 'what colors does PC54 come in?', 'what sizes?', " +
            "or before quoting a non-standard color (sanity-check the color exists in the catalog). " +
            "NEVER guess catalog colors — always call this tool to ground your answer in real data.",
        input_schema: {
            type: 'object',
            properties: {
                styleNumber: { type: 'string', description: 'SanMar/NWCA style number (e.g. PC54, K500, PC78H).' },
            },
            required: ['styleNumber'],
        },
    },
    {
        name: 'find_styles_by_color',
        description:
            "Find all SanMar styles that come in a specific color — by PMS code OR by " +
            "color name. Use when the rep needs COLOR MATCHING across multiple garments:\n" +
            "  • 'I need a charcoal cap AND a charcoal jacket'  → colorName: 'Charcoal'\n" +
            "  • 'Black t-shirt, hoodie, and beanie set'        → colorName: 'Black'\n" +
            "  • 'I need everything that comes in PMS 7427C'    → pmsColor: '7427C'\n" +
            "  • 'Match this polo's burgundy across products'   → look up the polo's PMS\n" +
            "    first via lookup_product_details, then call this with the PMS\n" +
            "Pass EITHER pmsColor OR colorName (at least one). Combine with category to " +
            "narrow ('I need a CAP that matches' → category: 'Caps'). PMS match is exact; " +
            "color name match is case-insensitive substring so 'charcoal' hits 'Charcoal', " +
            "'Dark Charcoal', 'Charcoal Hthr', etc.\n" +
            "Returns up to 15 styles with the matching color + product image.",
        input_schema: {
            type: 'object',
            properties: {
                pmsColor: {
                    type: 'string',
                    description: 'PMS code (e.g. "7427C", "382C"). Case-insensitive. ' +
                        'Format varies — some have spaces ("382 C"), some don\'t ("382C"). ' +
                        'Tool normalizes both formats. Pass this when matching by exact Pantone.',
                },
                colorName: {
                    type: 'string',
                    description: 'Color name (e.g. "Charcoal", "Black", "Navy", "Burgundy"). ' +
                        'Case-insensitive substring match against COLOR_NAME, so "charcoal" ' +
                        'returns styles in Charcoal, Dark Charcoal, Charcoal Hthr, etc. ' +
                        'Pass this when the rep just names a color (way more common than PMS).',
                },
                category: {
                    type: 'string',
                    description: 'OPTIONAL category narrow (T-Shirts / Polos/Knits / Sweatshirts/Fleece / Outerwear / Caps / Bags / Workwear / Woven Shirts / Accessories / Activewear).',
                },
                fit: {
                    type: 'string',
                    description: 'OPTIONAL fit filter — "Ladies" returns only ladies-cut styles, ' +
                        '"Mens" returns only men\'s/unisex (filters OUT Ladies). Matches based ' +
                        'on "Ladies" or "Women" or "Womens" appearing in the product title. ' +
                        'Use for "I need a ladies t-shirt in black" / "men\'s polo in navy".',
                    enum: ['Ladies', 'Mens', 'any'],
                },
                limit: { type: 'integer', description: 'Max styles to return (1-15). Default 10.' },
            },
        },
    },
    {
        name: 'rank_styles_by_price',
        description:
            "Rank SanMar styles within a category by RELATIVE cost — cheapest or most " +
            "expensive — without exposing the actual dollar amount. Use when the rep " +
            "asks for cost-based recommendations like:\n" +
            "  • 'What's the cheapest polo for embroidery?'\n" +
            "  • 'Most expensive Carhartt jacket?'\n" +
            "  • 'Cheapest ladies hoodie under Sport-Tek?'\n" +
            "  • 'Top 3 most expensive caps'\n" +
            "Server-side ranks by our SanMar wholesale case price, then strips the price " +
            "from the response. You'll receive ONLY the ranked list (style, name, brand). " +
            "🔴 CRITICAL: Your reply MUST NOT include dollar amounts. Use relative language " +
            "only — 'cheapest', 'least expensive', 'mid-tier', 'premium pick', 'most expensive'. " +
            "Reps can quote actual customer pricing via the form once they pick a style.",
        input_schema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description: 'REQUIRED — the SanMar category to rank within: "T-Shirts", ' +
                        '"Polos/Knits", "Sweatshirts/Fleece", "Outerwear", "Caps", "Bags", ' +
                        '"Workwear", "Woven Shirts", "Accessories", "Activewear". You MUST ' +
                        'pass a category — ranking across mixed categories isn\'t meaningful ' +
                        '(a polo will always be cheaper than a jacket).',
                },
                sort: {
                    type: 'string',
                    enum: ['cheapest', 'most_expensive'],
                    description: 'REQUIRED — "cheapest" sorts ascending, "most_expensive" descending.',
                },
                brand: {
                    type: 'string',
                    description: 'OPTIONAL brand narrow (case-insensitive substring). ' +
                        '"Carhartt" / "Port" / "Sport-Tek" / etc.',
                },
                fit: {
                    type: 'string',
                    enum: ['Ladies', 'Mens', 'any'],
                    description: 'OPTIONAL fit filter — Ladies (only ladies-cut) / Mens ' +
                        '(only mens or unisex) / any.',
                },
                limit: { type: 'integer', description: 'Max styles to return (1-10). Default 5.' },
            },
            required: ['category', 'sort'],
        },
    },
    // === EMB Smart A1: lookup_customer_history ============================
    {
        name: 'lookup_customer_history',
        description:
            "Pull THIS customer's actual order history from the past year — top items they've " +
            "ordered before, top brands, top categories, average order size, total revenue, " +
            "last ship-to. Call this RIGHT AFTER lookup_customer matches a real customer record " +
            "with an idCustomer. This is what makes you sound like a senior account manager: " +
            "instead of generic top sellers, you can say 'Acme Electrical's last year — PC78H " +
            "Jet Black (24 pieces), C112 Black (36 pieces). Avg order $1,800. Want me to quote " +
            "more of these?'.\n" +
            "If the customer is COLD (no order history), the response has hasHistory: false — " +
            "fall back to lookup_lookalike_customers(industry) for what other similar customers buy.",
        input_schema: {
            type: 'object',
            properties: {
                idCustomer: {
                    type: 'integer',
                    description: 'Customer ID from a prior lookup_customer call. Must be a positive integer.',
                },
                windowDays: {
                    type: 'integer',
                    description: 'Days of history to scan. Default 365 (one year). Min 30, max 730.',
                },
            },
            required: ['idCustomer'],
        },
    },
    // === EMB Smart A2: lookup_lookalike_customers ==========================
    {
        name: 'lookup_lookalike_customers',
        description:
            "Return what OTHER NWCA customers in the same INDUSTRY have actually purchased — " +
            "their top SanMar styles + most popular colors. Use this when:\n" +
            "  • The customer is COLD (lookup_customer_history returned hasHistory: false)\n" +
            "  • The rep asks 'what do other [industry] customers buy?' / 'what's typical for schools?'\n" +
            "  • The customer has limited history and you want to broaden suggestions\n" +
            "  • A NEW customer name suggests an industry (e.g. 'Fife High School' → Education)\n" +
            "Data is pre-aggregated from real NWCA orders — every style returned is a SanMar " +
            "catalog item with real unit counts. Bot reply pattern: 'Other [industry] customers " +
            "commonly buy: STYLE1 (top color: X, Y units), STYLE2, STYLE3. Based on N customers / $Y in orders.'\n" +
            "🔴 If the response includes sampleSizeNote, MENTION IT — small buckets need hedging.",
        input_schema: {
            type: 'object',
            properties: {
                industry: {
                    type: 'string',
                    description: 'One of the 18 valid industry buckets: Construction, Construction/Trades, ' +
                        'Construction/Electrical, Public Safety, Professional Services, Education, ' +
                        'Government, Retail, Agriculture, Hospitality, Healthcare, Religious, ' +
                        'Logistics/Transportation, Manufacturing, Energy/Utilities, Sports/Recreation, ' +
                        'Non-profit, Unknown. Use EXACT spelling (case-sensitive on slashes).',
                },
                limit: {
                    type: 'integer',
                    description: 'Max styles to return (1-25). Default 10.',
                },
            },
            required: ['industry'],
        },
    },
    // === EMB Smart A3: classify_company_via_web ============================
    {
        name: 'classify_company_via_web',
        description:
            "When the customer's company name doesn't reveal their industry (e.g. 'Apex Solutions', " +
            "'Diamond Catering', 'Puget Systems'), Google them and read the snippet to figure out " +
            "what kind of business they are. ONLY call this when:\n" +
            "  • lookup_customer succeeded but the name is ambiguous, AND\n" +
            "  • You can't already infer the industry from the name itself\n" +
            "Returns: { industry, confidence, signal, snippet } — uses the same 18 industry buckets " +
            "as lookup_lookalike_customers, so you can chain: classify_company_via_web → " +
            "lookup_lookalike_customers(industry).\n" +
            "🔴 ON ERROR (Tavily quota / network): the tool returns { error: 'web_search_unavailable' }. " +
            "When that happens, ask the rep to tell you the customer's industry directly instead of crashing.",
        input_schema: {
            type: 'object',
            properties: {
                companyName: {
                    type: 'string',
                    description: 'The customer\'s company name. 3+ chars.',
                },
            },
            required: ['companyName'],
        },
    },
    // === EMB Smart E2: lookup_customer_master_profile ======================
    {
        name: 'lookup_customer_master_profile',
        description:
            "Pull the FULL 10-year profile for one customer. Call this RIGHT AFTER " +
            "lookup_customer matches a real customer with an id_Customer. Returns: " +
            "Customer_Type, Account_Tier (GOLD/SILVER/BRONZE/Win Back/House), Sales_Rep, " +
            "Total_Revenue_10yr (10yr SanMar spend), Order_Count_10yr, Avg_Order_Size, " +
            "Top_5_Styles (their actual buys, ranked by units), Top_Style_Top_3_Colors, " +
            "Top_3_Brands, Top_Design_Type, Last_Style_Bought + Last_Color_Bought, " +
            "Last_Order_Date, Reorder_Probability (high/medium/low), Customer_Warning, " +
            "Payment_Terms, Phone_Best, Email. This is what makes you sound like a senior AE.\n\n" +
            "Bot reply pattern:\n" +
            "  \"Absher Construction — Customer_Type: Construction, GOLD tier (Nika's account), " +
            "63 SanMar orders over 10 years totaling $23K, last ordered May 22 (high reorder " +
            "probability). Top items: BG500 bags (270 each), CP90 caps, C914 beanies. Brand " +
            "mix: Port & Co (451 units), Port Authority (68). They pay Net 10. Want to quote " +
            "more of these?\"\n\n" +
            "🔴 ALWAYS surface Customer_Warning if non-empty BEFORE quoting.\n" +
            "🔴 If hasHistory:false / found:false, customer hasn't bought SanMar from us in " +
            "10 years — fall back to lookup_lookalike_customers(Customer_Type) for ideas.",
        input_schema: {
            type: 'object',
            properties: {
                idCustomer: {
                    type: 'integer',
                    description: 'Customer ID from a prior lookup_customer call. Must be a positive integer.',
                },
                companyName: {
                    type: 'string',
                    description: 'OPTIONAL — pass instead of idCustomer if you only have the name. ' +
                        'Substring match (case-insensitive). Returns the highest-revenue match.',
                },
            },
        },
    },
    // === EMB Smart E2: lookup_style_performance ============================
    {
        name: 'lookup_style_performance',
        description:
            "Pull 10-year performance data for ONE SanMar style — how it's actually sold " +
            "for NWCA over a decade. Returns: total_units_10yr, total_revenue_10yr, " +
            "total_orders_10yr, avg_margin_pct, decade_rank, brand_name, category_name, " +
            "subcategory_name, top 3 colors with units, customer_types_that_buy (% per type), " +
            "frequently_paired_with (top 3 co-ordered styles), companion_styles (SanMar's " +
            "curated companion list — usually men's/ladies' pairs), keywords, product_status.\n\n" +
            "Use when the rep asks:\n" +
            "  • 'How does PC54 actually sell for us?' → lookup_style_performance('PC54')\n" +
            "  • 'What goes well with C112?'           → check frequently_paired_with\n" +
            "  • 'Is CTJ162 worth recommending?'       → margin + status + decade_rank\n" +
            "  • 'Who buys ST650?'                     → customer_types_that_buy\n\n" +
            "🔴 NEVER mention raw dollar amounts (avg_sell_price, avg_our_cost, msrp) to the " +
            "rep in chat — only show margin % and unit volume. Dollars stay internal.",
        input_schema: {
            type: 'object',
            properties: {
                style: {
                    type: 'string',
                    description: 'SanMar style number (PC54, CP90, K500, J317, etc.) — case-insensitive.',
                },
            },
            required: ['style'],
        },
    },
    // === EMB Smart E2: recommend_high_margin_alternative ===================
    {
        name: 'recommend_high_margin_alternative',
        description:
            "When the rep is about to quote a LOW-MARGIN style, suggest profitable " +
            "same-category alternatives. Returns the base style's margin + up to 5 same-category " +
            "styles with HIGHER avg_margin_pct + meaningful 10yr unit volume (proven sellers).\n\n" +
            "Use proactively when the rep mentions a style and you know (from " +
            "lookup_style_performance) its margin is below ~40%. Common low-margin styles: " +
            "Carhartt jackets (CTJ162 = 14.6%, CT100617 = 35.6%) — bot can suggest comparable " +
            "Port Authority / Eddie Bauer alternatives with 50-70% margins.\n\n" +
            "🔴 NO DOLLAR AMOUNTS. Talk margins as PERCENTAGES + relative language only: " +
            "'this style runs at X% margin, an alternative is Y% margin — more profitable'. " +
            "Never mention what we paid or what we sold it for.\n\n" +
            "Reply pattern:\n" +
            "  \"CTJ162 (Carhartt Shoreline) runs at 14.6% margin. If customer is " +
            "flexible, comparable Outerwear alternatives with much higher margin: " +
            "J317 Port Authority Soft Shell (62%), EB532 Eddie Bauer Shaded Crosshatch " +
            "(44%). All proven sellers — 1,000+ lifetime units each.\"",
        input_schema: {
            type: 'object',
            properties: {
                style: {
                    type: 'string',
                    description: 'The base SanMar style we want to find alternatives for.',
                },
            },
            required: ['style'],
        },
    },
    {
        name: 'search_products_by_keyword',
        description:
            "Search ALL of SanMar's ~30K product catalog by keyword/concept. The KEYWORDS " +
            "field SanMar maintains per product is incredibly rich — includes synonyms, " +
            "misspellings, feature tags ('water resistant', 'wind-resistant', 'soft shell', " +
            "'corporate attire', 'budget friendly', 'fleece lined'), and category descriptors. " +
            "Use this when the rep asks for a CONCEPT or FEATURE rather than a brand/category, " +
            "and the answer might NOT be in our top-40 curated list:\n" +
            "  • 'I need a waterproof jacket'           → q: 'waterproof'\n" +
            "  • 'Something moisture-wicking for hot weather' → q: 'moisture wicking'\n" +
            "  • 'Find me a high-vis safety vest'       → q: 'high visibility'\n" +
            "  • 'Show me a Carhartt softshell'         → q: 'softshell' + brand filter\n" +
            "  • 'What flame-resistant stuff do we sell?' → q: 'flame resistant'\n" +
            "  • 'Need a heavy-duty winter beanie'      → q: 'heavyweight beanie'\n" +
            "Returns up to 10 matching products with title, brand, category, image, status. " +
            "Filter by ACTIVE-only by default — rep doesn't want to pitch discontinued SKUs. " +
            "When the rep mentions a SPECIFIC style # (PC54, J317), use lookup_product_details " +
            "instead. When they ask for 'top sellers' / 'best X', use recommend_top_sellers_emb.",
        input_schema: {
            type: 'object',
            properties: {
                q: {
                    type: 'string',
                    description: 'Free-text search term — feature, fabric, attribute, or concept. 2+ chars.',
                },
                brand: {
                    type: 'string',
                    description: 'OPTIONAL brand filter to narrow results (e.g. "Carhartt", "Port Authority").',
                },
                category: {
                    type: 'string',
                    description: 'OPTIONAL SanMar category to narrow (T-Shirts / Polos/Knits / Sweatshirts/Fleece / Outerwear / Caps / Bags / Workwear / Woven Shirts / Accessories / Activewear).',
                },
                limit: { type: 'integer', description: 'Max results to return (1-10). Default 5.' },
            },
            required: ['q'],
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
        return { matches: shapeContacts(direct), count: direct.length, query_used: q };
    }
    // Fallback: split on common conjunctions ("Allison at Acme") and search each fragment.
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
        matches: shapeContacts(combined),
        count: combined.length,
        query_used: q,
        fragments_tried: triedFragments.length > 0 ? triedFragments : undefined,
    };
}

function shapeContacts(contacts) {
    return contacts.map((c) => {
        const company = c.CustomerCompanyName || null;
        // E2 (2026-05-25): Erik's manual Customer_Type now flows through from
        // contacts CSV — prefer that over my regex inference. Only fall back
        // to inferIndustry when Customer_Type is blank/missing.
        const erikType = (c.Customer_Type || '').trim();
        const inf = !erikType && company
            ? inferIndustry(company)
            : { industry: erikType || 'Unknown', confidence: erikType ? 'manual' : 'unknown', signal: erikType ? 'Customer_Type (Erik)' : null };
        return {
            company,
            customer_number: c.id_Customer != null ? String(c.id_Customer) : null,
            id_Customer: c.id_Customer != null ? Number(c.id_Customer) : null, // numeric form for lookup_customer_master_profile
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
            // NEW (EMB Smart A2): industry inferred from company name OR
            // Erik's manual Customer_Type when present (preferred).
            // If 'Unknown' AND industry_confidence='unknown', the bot should
            // call classify_company_via_web.
            industry: inf.industry,
            industry_confidence: inf.confidence,
            industry_signal: inf.signal,
            // NEW (EMB Smart E2): senior-AE context fields. Bot uses these
            // BEFORE deciding whether to call lookup_customer_master_profile.
            // Customer_Warning surfaces deal-breakers (e.g. "DO NOT ship to
            // wrong address again"). YTD_Sales flags whales. Account_Tier
            // tells the bot how white-glove to be.
            customer_type: inf.industry,                             // mirror of `industry` for clarity
            account_tier: c.Account_Tier || null,                    // e.g. "GOLD '26 - NIKA"
            sales_group: c.Sales_Group || null,                      // rep/team label
            ytd_sales: Number(c.YTD_Sales) || 0,                     // year-to-date $ (all categories, not just SanMar)
            customer_warning: c.Customer_Warning || null,            // any free-text alert from CRM
            is_active: c.Is_Active === true,
            is_dead: c.Is_Dead === true,
            is_stale: c.Is_Stale === true,
            tax_exempt_number: c.Tax_Exempt_Number || null,
            is_tax_exempt: c.Is_Tax_Exempt === true,
        };
    });
}

/**
 * recommend_top_sellers_emb — pull from lib/emb-curated-products.js.
 *
 * Data source: lib/emb-curated-products.js (generated by
 * scripts/aggregate-emb-top-sellers.js from Erik's 10yr EMB sales export).
 * Caspio table EMB_Top_Sellers_2026 is NOT used for v1 — keeps the chat
 * stack zero-dependency on Caspio for top-sellers data. If we ever want
 * per-color analytics for the bot to reference ("PC54 navy: 2,139 units"),
 * we can wire to the Caspio table at that point (route file is mounted +
 * ready in src/routes/emb-top-sellers.js).
 *
 * Category aliases: bot may pass "T-Shirt" / "Hoodie" / etc. — map to the
 * internal bucket keys (tshirts / sweatshirts / etc.).
 */
const CATEGORY_ALIASES = {
    'T-Shirt': 'tshirts', 'T-Shirts': 'tshirts', 'Tshirt': 'tshirts', 'Tee': 'tshirts',
    'Polo': 'polos', 'Polos': 'polos', 'Polos/Knits': 'polos',
    'Sweatshirt': 'sweatshirts', 'Sweatshirts': 'sweatshirts', 'Hoodie': 'sweatshirts', 'Hoodies': 'sweatshirts', 'Fleece': 'sweatshirts', 'Sweatshirts/Fleece': 'sweatshirts',
    'Jacket': 'outerwear', 'Jackets': 'outerwear', 'Outerwear': 'outerwear', 'Vest': 'outerwear', 'Vests': 'outerwear',
    'Cap': 'caps', 'Caps': 'caps', 'Hat': 'caps', 'Hats': 'caps',
    'Beanie': 'caps', 'Beanies': 'caps',   // beanies are in the Caps category
    'Bag': 'bags', 'Bags': 'bags', 'Backpack': 'bags', 'Tote': 'bags',
    'Workwear': 'workwear', 'Work Shirt': 'workwear', 'Work Pants': 'workwear',
    'Woven': 'wovenshirts', 'Woven Shirt': 'wovenshirts', 'Woven Shirts': 'wovenshirts', 'Button Down': 'wovenshirts',
    'Accessory': 'accessories', 'Accessories': 'accessories', 'Towel': 'accessories', 'Blanket': 'accessories',
    'Activewear': 'activewear', 'Athletic': 'activewear',
};

async function recommendTopSellersEmb(input) {
    try {
        const rawCategory = String(input?.category || 'any').trim();
        const rawBrand    = String(input?.brand || '').trim();
        const limit = Math.max(1, Math.min(10, Number(input?.limit) || 3));

        // Resolve bucket key — exact match first, then alias map, then 'any'.
        let bucketKey = null;
        if (rawCategory && rawCategory !== 'any') {
            if (EMB_CURATED_PRODUCTS[rawCategory.toLowerCase()]) {
                bucketKey = rawCategory.toLowerCase();
            } else if (CATEGORY_ALIASES[rawCategory]) {
                bucketKey = CATEGORY_ALIASES[rawCategory];
            }
        }

        // Pull candidates from the category bucket (or all if 'any')
        let products;
        if (bucketKey) {
            products = (EMB_CURATED_PRODUCTS[bucketKey] || []).slice();
        } else {
            // 'any' → mix across all categories, sorted by overall salesRank
            products = Object.values(EMB_CURATED_PRODUCTS)
                .flat()
                .sort((a, b) => (a.salesRank || 999) - (b.salesRank || 999));
        }

        // Brand filter (Erik 2026-05-24): "what's the top-selling Carhartt?" /
        // "best Nike?" / "what Richardson do we sell?" — bot passes brand and
        // we narrow the candidate list. Case-insensitive substring match so
        // "Port" matches both "Port Authority" and "Port & Co", and "carhartt"
        // matches "Carhartt". If no matches, return count:0 — bot's system
        // prompt teaches it to surface that politely + suggest equivalents.
        if (rawBrand) {
            const needle = rawBrand.toLowerCase();
            products = products.filter(p =>
                String(p.brand || '').toLowerCase().includes(needle)
            );
        }

        // Trim to limit + return only the fields the bot needs
        products = products.slice(0, limit).map(p => ({
            styleNumber: p.styleNumber,
            name:        p.name,
            brand:       p.brand,
            category:    p.category,
            subcategory: p.subcategory,
            salesData:   p.salesData,
            salesRank:   p.salesRank,
            quality:     p.quality || 'excellent',
            bestColors:  Array.isArray(p.bestColors) ? p.bestColors.slice(0, 4) : [],
            notes:       p.notes || '',
            bestFor:     p.bestFor || '',
        }));

        // Hydrate main_image_url per style from SanMar bundle endpoint so the
        // bot can include the product hero in its reply.
        try {
            const imageMap = await hydrateEmbImages(products.map(p => p.styleNumber));
            for (const p of products) {
                const url = imageMap[p.styleNumber];
                if (url) p.mainImageUrl = url;
            }
        } catch (hyErr) {
            console.warn('[emb-quote-ai] image hydration skipped:', hyErr.message);
        }

        return {
            category: rawCategory,
            brand: rawBrand || null,
            resolvedBucket: bucketKey || 'any',
            count: products.length,
            products,
        };
    } catch (err) {
        console.error('[emb-quote-ai] recommend_top_sellers_emb error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

// Strip the trailing ". STYLENUMBER" SanMar appends to product titles.
function stripStyleSuffix(title) {
    return String(title || '').replace(/\.?\s*[A-Z0-9]+\s*$/, '').trim();
}

// Guess brand from the start of a SanMar product title.
function extractBrand(title) {
    const t = String(title || '').trim();
    if (/^Port\s*&\s*Co/i.test(t)) return 'Port & Company';
    if (/^BELLA\+CANVAS/i.test(t)) return 'BELLA+CANVAS';
    if (/^District/i.test(t)) return 'District';
    if (/^Sport-Tek/i.test(t)) return 'Sport-Tek';
    if (/^Next Level/i.test(t)) return 'Next Level Apparel';
    if (/^Carhartt/i.test(t)) return 'Carhartt';
    if (/^OGIO/i.test(t)) return 'OGIO';
    if (/^Eddie Bauer/i.test(t)) return 'Eddie Bauer';
    if (/^Nike/i.test(t)) return 'Nike';
    if (/^New Era/i.test(t)) return 'New Era';
    if (/^Richardson/i.test(t)) return 'Richardson';
    if (/^Gildan/i.test(t)) return 'Gildan';
    return t.split(/\s+/)[0] || '';
}

// Per-dyno image cache. Top-up rather than full-refetch.
let _embImageCache = null;
let _embImagePromise = null;
async function hydrateEmbImages(styles) {
    if (_embImageCache) {
        const missing = styles.filter((s) => !(s in _embImageCache));
        if (!missing.length) return _embImageCache;
    }
    if (_embImagePromise) return _embImagePromise;
    const toFetch = Array.from(new Set(styles));
    _embImagePromise = Promise.all(toFetch.map(async (style) => {
        try {
            const r = await fetch(`${INTERNAL_API_BASE}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(style)}`);
            if (!r.ok) return [style, null];
            const j = await r.json();
            const colors = (j && j.product && Array.isArray(j.product.colors)) ? j.product.colors : [];
            const first = colors.find((c) => c && c.MAIN_IMAGE_URL);
            return [style, first ? first.MAIN_IMAGE_URL : null];
        } catch {
            return [style, null];
        }
    })).then((entries) => {
        _embImageCache = Object.assign({}, _embImageCache || {}, Object.fromEntries(entries));
        _embImagePromise = null;
        return _embImageCache;
    });
    return _embImagePromise;
}

/**
 * lookup_product_details — live SanMar query via /api/dtg/product-bundle.
 * The endpoint returns generic SanMar data (not DTG-specific), so it's
 * safe to reuse here for EMB.
 */
async function lookupProductDetails(input) {
    const styleNumber = String(input?.styleNumber || '').trim().toUpperCase();
    if (!styleNumber) return { error: 'missing_style', message: 'styleNumber is required' };

    try {
        const r = await fetch(`${INTERNAL_API_BASE}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(styleNumber)}`);
        if (!r.ok) {
            return { error: 'not_found', message: `Style ${styleNumber} not in SanMar catalog`, styleNumber };
        }
        const data = await r.json();
        const product = data.product || {};
        const colorsRaw = Array.isArray(product.colors) ? product.colors : [];
        const sizesRaw = Array.isArray(product.sizes) ? product.sizes : [];

        const colors = colorsRaw.map((c) => ({
            name: c.COLOR_NAME || '',
            catalog: c.CATALOG_COLOR || '',
            swatchUrl: c.COLOR_SWATCH_IMAGE_URL || c.SWATCH_IMAGE_URL || '',
            modelUrl: c.MAIN_IMAGE_URL || c.FRONT_MODEL_IMAGE_URL || '',
            // Erik 2026-05-24: PMS code per color — bot uses this for color
            // matching across products ("find a hoodie that matches THIS
            // polo's burgundy"). Not all colors have PMS values populated.
            pmsColor: c.PMS_COLOR || c.pmsColor || '',
        }));

        // Compute size upcharges from sizesRaw[*].maxCasePrice
        // Min case price = base; everything above = upcharge.
        const minCase = Math.min(...sizesRaw.map(s => Number(s.maxCasePrice) || Infinity).filter(n => Number.isFinite(n)));
        const upchargeMap = {};
        for (const s of sizesRaw) {
            const size = String(s.size || '').toUpperCase();
            const price = Number(s.maxCasePrice) || 0;
            const upcharge = price > minCase ? price - minCase : 0;
            upchargeMap[size] = Math.round(upcharge * 100) / 100;
        }

        const sizes = sizesRaw.map((s) => {
            const size = String(s.size || '').toUpperCase();
            const upcharge = Number(upchargeMap[size]) || 0;
            return {
                size,
                maxCasePrice: Number(s.maxCasePrice) || 0,
                upcharge,
                hasUpcharge: upcharge > 0,
            };
        });

        const hasUpcharges = sizes.some(s => s.hasUpcharge);
        const upchargeSummary = hasUpcharges
            ? sizes.filter(s => s.hasUpcharge).map(s => `${s.size} +$${s.upcharge.toFixed(2)}`).join(', ')
            : null;

        // Erik 2026-05-24: companion styles + PMS-per-color enrichment.
        // The bundle endpoint doesn't surface COMPANION_STYLES or PMS_COLOR
        // so we do a small parallel Caspio query to grab them. Best-effort:
        // if it fails the bot still gets the basic lookup back.
        let companionStyles = [];
        const pmsByColor = {};  // {COLOR_NAME_LOWER: 'PMS code'}
        try {
            const enrichRows = await fetchAllCaspioPages(
                '/tables/Sanmar_Bulk_251816_Feb2024/records',
                {
                    'q.where': `STYLE='${styleNumber.replace(/'/g, "''")}'`,
                    'q.select': 'COMPANION_STYLES, COLOR_NAME, PMS_COLOR',
                }
            );
            if (Array.isArray(enrichRows) && enrichRows.length > 0) {
                // COMPANION_STYLES is the same value across all rows for a
                // style — take from the first row. Split on common separators.
                const csRaw = enrichRows[0].COMPANION_STYLES || '';
                companionStyles = String(csRaw)
                    .split(/[,;\s]+/)
                    .map(s => s.trim())
                    .filter(s => s && s.toUpperCase() !== styleNumber.toUpperCase());
                // PMS varies per color
                for (const r of enrichRows) {
                    if (r.COLOR_NAME && r.PMS_COLOR) {
                        pmsByColor[String(r.COLOR_NAME).toLowerCase()] = r.PMS_COLOR;
                    }
                }
                // Stamp PMS onto each color in our colors[] response
                for (const c of colors) {
                    const key = String(c.name || '').toLowerCase();
                    if (pmsByColor[key]) c.pmsColor = pmsByColor[key];
                }
            }
        } catch (enrichErr) {
            console.warn(`[emb-quote-ai] companion/PMS enrichment failed for ${styleNumber}:`, enrichErr.message);
        }

        return {
            styleNumber,
            title: product.title || product.PRODUCT_TITLE || '',
            description: product.description || product.PRODUCT_DESCRIPTION || '',
            colors,
            colorCount: colors.length,
            sizes,
            sizeCount: sizes.length,
            hasUpcharges,
            upchargeSummary,
            companionStyles,         // e.g. ["L500"] for K500 (ladies' equivalent)
            hasCompanions: companionStyles.length > 0,
            source: 'caspio-sanmar-bulk',
        };
    } catch (err) {
        console.error('[emb-quote-ai] lookup_product_details error:', err.message);
        return { error: 'network', message: err.message };
    }
}

/**
 * find_styles_by_color — query SanMar bulk for all styles where any
 * color matches a PMS code OR a color name. Used for cross-product color
 * matching (rep: "I need a charcoal cap AND charcoal jacket" / "black
 * t-shirt set across men's + ladies'").
 *
 * Erik 2026-05-24 — supports two query modes:
 *   - colorName: "Charcoal" → case-insensitive substring match against
 *     COLOR_NAME. Hits "Charcoal", "Dark Charcoal", "Charcoal Heather",
 *     "Charcoal Hthr", etc. More forgiving than exact PMS match.
 *   - pmsColor: "7427C" → exact Pantone match. Use when the rep wants
 *     IDENTICAL color across products (true uniform sets).
 *
 * Optional fit filter ('Ladies' / 'Mens' / 'any') narrows by product
 * title — "Ladies" / "Women" / "Womens" in title = Ladies; everything
 * else = Mens (which includes Unisex). Lets the bot answer "ladies
 * t-shirt in black" specifically.
 *
 * Returns aggregated per-style. Same product, multiple color matches,
 * counts once.
 */
async function findStylesByColor(input) {
    const pmsRaw   = String(input?.pmsColor  || '').trim();
    const nameRaw  = String(input?.colorName || '').trim();
    const category = String(input?.category  || '').trim();
    const fitRaw   = String(input?.fit       || '').trim().toLowerCase();
    const limit    = Math.max(1, Math.min(15, Number(input?.limit) || 10));

    if (!pmsRaw && !nameRaw) {
        return {
            error: 'no_color_filter',
            message: 'Pass at least one of: pmsColor (e.g. "7427C") or colorName (e.g. "Charcoal")',
        };
    }

    try {
        const whereConditions = [`PRODUCT_STATUS='Active'`];

        if (pmsRaw) {
            // Normalize PMS — strip spaces, uppercase. SanMar stores both
            // "382 C" and "382C" inconsistently. Match against both formats.
            const pmsNoSpace = pmsRaw.replace(/\s+/g, '').toUpperCase();
            const pmsWithSpace = pmsNoSpace.replace(/^(\d+)([A-Z]+)$/, '$1 $2');
            const sqlNoSpace = pmsNoSpace.replace(/'/g, "''");
            const sqlWithSpace = pmsWithSpace.replace(/'/g, "''");
            whereConditions.push(`(PMS_COLOR='${sqlNoSpace}' OR PMS_COLOR='${sqlWithSpace}')`);
        }

        if (nameRaw) {
            // Case-insensitive substring on COLOR_NAME. Caspio LIKE is
            // case-insensitive by default, no UPPER() needed.
            const sqlName = nameRaw.replace(/'/g, "''");
            whereConditions.push(`COLOR_NAME LIKE '%${sqlName}%'`);
        }

        if (category) {
            whereConditions.push(`CATEGORY_NAME='${category.replace(/'/g, "''")}'`);
        }

        const rows = await fetchAllCaspioPages(
            '/tables/Sanmar_Bulk_251816_Feb2024/records',
            {
                'q.where': whereConditions.join(' AND '),
                'q.select': 'STYLE, PRODUCT_TITLE, BRAND_NAME, CATEGORY_NAME, SUBCATEGORY_NAME, COLOR_NAME, CATALOG_COLOR, PMS_COLOR, PRODUCT_IMAGE, COLOR_SQUARE_IMAGE',
                'q.orderBy': 'UNIQUE_KEY', // stable pagination — category-wide raw scans span many pages; unordered reads drop rows
            }
        );

        // Apply fit filter client-side (PRODUCT_TITLE pattern match — Caspio
        // LIKE doesn't have word-boundary support, so it's cleaner here).
        const ladiesRe = /\b(ladies|women|womens|woman's|women's)\b/i;
        const wantsLadies = fitRaw === 'ladies' || fitRaw === "ladies'";
        const wantsMens   = fitRaw === 'mens' || fitRaw === "men's" || fitRaw === 'men';
        const filteredRows = rows.filter(r => {
            if (!wantsLadies && !wantsMens) return true;
            const title = String(r.PRODUCT_TITLE || '');
            const isLadies = ladiesRe.test(title);
            if (wantsLadies) return isLadies;
            if (wantsMens)   return !isLadies;
            return true;
        });

        // Aggregate per style — bot wants distinct products, not duplicate
        // rows for each color match. Keep the first matching color as the
        // "exemplar" so the bot can show the swatch.
        const byStyle = new Map();
        for (const r of filteredRows) {
            const style = r.STYLE;
            if (!style) continue;
            if (!byStyle.has(style)) {
                byStyle.set(style, {
                    styleNumber: style,
                    name: stripStyleSuffix(r.PRODUCT_TITLE || ''),
                    brand: r.BRAND_NAME || '',
                    category: r.CATEGORY_NAME || '',
                    subcategory: r.SUBCATEGORY_NAME || '',
                    fit: ladiesRe.test(r.PRODUCT_TITLE || '') ? 'Ladies' : 'Mens',
                    matchingColors: [],
                    mainImageUrl: r.PRODUCT_IMAGE || '',
                });
            }
            const s = byStyle.get(style);
            if (s.matchingColors.length < 3) {
                s.matchingColors.push({
                    name: r.COLOR_NAME || '',
                    catalog: r.CATALOG_COLOR || '',
                    pmsColor: r.PMS_COLOR || '',
                    swatchUrl: r.COLOR_SQUARE_IMAGE || '',
                });
            }
        }

        const products = [...byStyle.values()].slice(0, limit);

        return {
            pmsColor: pmsRaw || null,
            colorName: nameRaw || null,
            category: category || null,
            fit: fitRaw || null,
            count: products.length,
            totalMatches: byStyle.size,
            products,
        };
    } catch (err) {
        console.error('[emb-quote-ai] find_styles_by_color error:', err.message);
        return { error: 'tool_exception', message: err.message, pmsColor: pmsRaw, colorName: nameRaw };
    }
}

/**
 * rank_styles_by_price — server-side cost ranking with PRICES STRIPPED
 * before the response goes to the LLM. The bot only sees the ranked list
 * (style/name/brand/image), never the dollar amount. This is intentional:
 * even if a future prompt-injection tried to extract pricing, the model
 * has no number to leak — it isn't in the tool result.
 *
 * Ranking is by MIN(CASE_PRICE) per style (a style's colors have varying
 * prices; we use the lowest as the style's "base cost" — matches what
 * a rep would quote for the most common colorway). For "cheapest" we
 * sort ascending; "most_expensive" descending.
 *
 * Erik 2026-05-24 — answers "what's the cheapest polo?" / "most expensive
 * Carhartt jacket?" without exposing NWCA's wholesale cost basis.
 */
async function rankStylesByPrice(input) {
    const category = String(input?.category || '').trim();
    const sort     = String(input?.sort     || '').trim().toLowerCase();
    const brand    = String(input?.brand    || '').trim();
    const fitRaw   = String(input?.fit      || '').trim().toLowerCase();
    const limit    = Math.max(1, Math.min(10, Number(input?.limit) || 5));

    if (!category) {
        return { error: 'missing_category', message: 'category is required (e.g. "Polos/Knits")' };
    }
    if (sort !== 'cheapest' && sort !== 'most_expensive') {
        return { error: 'bad_sort', message: 'sort must be "cheapest" or "most_expensive"', sort };
    }

    try {
        // Pull all (style, color) rows in the category with CASE_PRICE for
        // ranking. Active-only — no recommending discontinued SKUs.
        const whereConditions = [
            `CATEGORY_NAME='${category.replace(/'/g, "''")}'`,
            `PRODUCT_STATUS='Active'`,
        ];
        const rows = await fetchAllCaspioPages(
            '/tables/Sanmar_Bulk_251816_Feb2024/records',
            {
                'q.where': whereConditions.join(' AND '),
                // CASE_PRICE is used internally for ranking + DROPPED before
                // returning. The model literally never sees the number.
                'q.select': 'STYLE, PRODUCT_TITLE, BRAND_NAME, CATEGORY_NAME, SUBCATEGORY_NAME, CASE_PRICE, PRODUCT_IMAGE',
                'q.orderBy': 'UNIQUE_KEY', // stable pagination — category-wide raw scans span many pages; unordered reads drop rows
            }
        );

        // Apply brand filter client-side (Caspio LIKE with case-insensitivity
        // is fine but keeps the logic in one place alongside the fit filter).
        const ladiesRe = /\b(ladies|women|womens|woman's|women's)\b/i;
        const wantsLadies = fitRaw === 'ladies' || fitRaw === "ladies'";
        const wantsMens   = fitRaw === 'mens' || fitRaw === "men's" || fitRaw === 'men';
        const brandNeedle = brand.toLowerCase();

        const filtered = rows.filter(r => {
            if (brand && !String(r.BRAND_NAME || '').toLowerCase().includes(brandNeedle)) return false;
            if (wantsLadies || wantsMens) {
                const isLadies = ladiesRe.test(r.PRODUCT_TITLE || '');
                if (wantsLadies && !isLadies) return false;
                if (wantsMens   && isLadies)  return false;
            }
            return true;
        });

        // Group by STYLE — take MIN(CASE_PRICE) as the style's base cost.
        // Cheapest color within the style sets its rank position.
        const byStyle = new Map();
        for (const r of filtered) {
            const style = r.STYLE;
            if (!style) continue;
            const price = Number(r.CASE_PRICE);
            if (!Number.isFinite(price) || price <= 0) continue; // skip rows w/o price
            if (!byStyle.has(style)) {
                byStyle.set(style, {
                    styleNumber: style,
                    name: stripStyleSuffix(r.PRODUCT_TITLE || ''),
                    brand: r.BRAND_NAME || '',
                    category: r.CATEGORY_NAME || '',
                    subcategory: r.SUBCATEGORY_NAME || '',
                    fit: ladiesRe.test(r.PRODUCT_TITLE || '') ? 'Ladies' : 'Mens',
                    mainImageUrl: r.PRODUCT_IMAGE || '',
                    _minCasePrice: price,           // INTERNAL — stripped before return
                });
            } else {
                const s = byStyle.get(style);
                if (price < s._minCasePrice) s._minCasePrice = price;
            }
        }

        // Sort by internal price field
        const sortAsc = sort === 'cheapest';
        const ranked = [...byStyle.values()].sort((a, b) =>
            sortAsc ? a._minCasePrice - b._minCasePrice : b._minCasePrice - a._minCasePrice
        ).slice(0, limit);

        // 🔴 STRIP the internal price field before returning. Never goes to LLM.
        // Add a positional rank for the bot's reply.
        const products = ranked.map((s, i) => ({
            rankPosition:  i + 1,
            styleNumber:   s.styleNumber,
            name:          s.name,
            brand:         s.brand,
            category:      s.category,
            subcategory:   s.subcategory,
            fit:           s.fit,
            mainImageUrl:  s.mainImageUrl,
            // NOTE: _minCasePrice deliberately NOT included. Server-side
            // ranked; bot only sees order. See route header comment.
        }));

        return {
            category,
            sort,
            brand: brand || null,
            fit: fitRaw || null,
            count: products.length,
            totalCandidates: byStyle.size,
            products,
            // Friendly reminder embedded in the result so the model
            // is double-reminded not to fabricate prices.
            _reminder: 'CASE_PRICE was used for ranking but is intentionally NOT included in this response. Do NOT mention dollar amounts in your reply.',
        };
    } catch (err) {
        console.error('[emb-quote-ai] rank_styles_by_price error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

/**
 * search_products_by_keyword — full-catalog SanMar search by keyword/concept.
 *
 * Hits the existing /api/products/search endpoint which searches across
 * STYLE / PRODUCT_TITLE / PRODUCT_DESCRIPTION / KEYWORDS / BRAND_NAME with
 * a single LIKE query. KEYWORDS is the most useful — SanMar packs every
 * variant + synonym + misspelling in there (e.g. "water resistant water
 * reistant water resistent water-resistant water-resistance" all in one
 * row for J317).
 *
 * Filters down to ACTIVE products only (no discontinued pitching) and
 * keeps the response compact (no descriptions in the chip data — bot can
 * call lookup_product_details for deeper details on any one hit).
 *
 * Erik 2026-05-24 — opens up the entire SanMar catalog to the bot when
 * the rep asks for something not in our top 40 (e.g. "high-vis safety vest"
 * or "flame-resistant work shirt").
 */
async function searchProductsByKeyword(input) {
    const q     = String(input?.q || '').trim();
    const brand = String(input?.brand || '').trim();
    const category = String(input?.category || '').trim();
    const limit = Math.max(1, Math.min(10, Number(input?.limit) || 5));

    if (q.length < 2) {
        return { error: 'query_too_short', message: 'Need 2+ characters', q };
    }

    try {
        // Build query — proxy's /api/products/search already does the
        // KEYWORDS / TITLE / DESCRIPTION / BRAND OR-match for us.
        const params = new URLSearchParams({ q, status: 'Active', limit: String(limit * 3) });
        if (brand) params.set('brand', brand);
        if (category) params.set('category', category);
        const url = `${INTERNAL_API_BASE}/api/products/search?${params.toString()}`;
        const r = await fetch(url);
        if (!r.ok) {
            return { error: 'search_failed', message: `HTTP ${r.status}`, q };
        }
        const body = await r.json();
        const products = (body?.data?.products || body?.products || []);

        // Trim to limit + drop heavy fields. Keep just what the bot needs to
        // explain the match + cite the product. Bot can call
        // lookup_product_details for colors/sizes if the rep wants to dig in.
        const trimmed = products.slice(0, limit).map(p => ({
            styleNumber: p.styleNumber || p.STYLE || '',
            name:        stripStyleSuffix(p.productName || p.PRODUCT_TITLE || ''),
            brand:       p.brand || p.BRAND_NAME || '',
            category:    p.category || p.CATEGORY_NAME || '',
            subcategory: p.subcategory || p.SUBCATEGORY_NAME || '',
            // Short description snippet (first 200 chars, single line) so
            // the bot has context to explain WHY this style matched the query.
            descriptionSnippet: String(p.description || p.PRODUCT_DESCRIPTION || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 200),
            // Hero image so the bot can include the visual in its reply.
            mainImageUrl: p.images?.main || p.PRODUCT_IMAGE || '',
            // Price hint — bot can mention price range without quoting exact.
            piecePrice:  p.pricing?.minPrice ?? p.PIECE_PRICE ?? null,
            status:      p.status || p.PRODUCT_STATUS || 'Active',
            // Phase G follow-up (2026-05-25): NWCA history cross-reference.
            // Filled in by enrichWithNwcaHistory below — null until then.
            nwca_units_10yr: null,
            nwca_decade_rank: null,
        }));

        // Phase G follow-up: cross-reference each search hit with our 10yr sales
        // table so the bot can surface proven sellers ahead of catalog-only styles.
        // ONE Caspio batch query (style IN list), not per-result. Failure-tolerant —
        // if this lookup fails, results are still returned without history fields.
        try {
            const styleList = trimmed.map(t => t.styleNumber).filter(Boolean);
            if (styleList.length > 0) {
                const { fetchAllCaspioPages } = require('../utils/caspio');
                const inClause = styleList.map(s => `'${String(s).replace(/'/g, "''")}'`).join(',');
                const histRows = await fetchAllCaspioPages('/tables/Sanmar_Style_Performance_10yr_26/records', {
                    'q.where': `style IN (${inClause})`,
                    'q.select': 'style,total_units_10yr,decade_rank,avg_our_cost,category_name',
                    'q.limit': 100,
                });
                const histByStyle = new Map();
                for (const r of (histRows || [])) {
                    if (r.style) histByStyle.set(String(r.style).toUpperCase(), r);
                }
                for (const t of trimmed) {
                    const hist = histByStyle.get(String(t.styleNumber).toUpperCase());
                    if (hist) {
                        t.nwca_units_10yr = Number(hist.total_units_10yr) || 0;
                        t.nwca_decade_rank = Number(hist.decade_rank) || null;
                    }
                }
                // Sort: proven sellers first (units DESC), unsold styles last.
                trimmed.sort((a, b) => {
                    const aU = a.nwca_units_10yr || 0;
                    const bU = b.nwca_units_10yr || 0;
                    return bU - aU;
                });

                // Phase G follow-up #2 (2026-05-25): also compute target customer
                // price at qty 25 for EVERY result so the bot can quote without
                // needing extra lookup_style_performance calls per pick.
                //
                // Cost basis:
                //   - WITH history → use avg_our_cost from Sanmar_Style_Performance (most accurate)
                //   - WITHOUT history → fall back to piecePrice from SanMar catalog (proxy)
                // Then apply standard formula: (cost + embroideryCost@qty25) / 0.57
                try {
                    await embPricingCache.ensureFresh();
                    const denom = embPricingCache.getMarginDenominator();
                    if (denom && denom > 0) {
                        for (const t of trimmed) {
                            const hist = histByStyle.get(String(t.styleNumber).toUpperCase());
                            const costFromHistory = hist ? Number(hist.avg_our_cost) : 0;
                            // Use history cost if available, else fall back to piecePrice
                            const garmentCost = costFromHistory > 0 ? costFromHistory : (Number(t.piecePrice) || 0);
                            if (garmentCost > 0) {
                                const itemType = embPricingCache.classifyItemType(t.category || (hist && hist.category_name) || '');
                                const embCost = embPricingCache.getEmbroideryCost({ itemType, qty: 25 });
                                if (embCost != null) {
                                    const allIn = garmentCost + embCost;
                                    t.target_customer_price_at_qty_25 = Math.round((allIn / denom) * 100) / 100;
                                    t.target_price_basis = costFromHistory > 0
                                        ? 'NWCA avg cost from 10yr history'
                                        : 'SanMar catalog piece price (no NWCA history available)';
                                }
                            }
                        }
                    }
                } catch (priceErr) {
                    console.warn('[emb-quote-ai] target price enrichment failed:', priceErr.message);
                    // Non-fatal — bot still gets history-sorted results
                }
            }
        } catch (histErr) {
            console.warn('[emb-quote-ai] search history enrichment failed:', histErr.message);
            // Non-fatal — return results without history annotations
        }

        return {
            q,
            brand: brand || null,
            category: category || null,
            count: trimmed.length,
            totalMatches: (body?.data?.products?.length || body?.products?.length || 0),
            products: trimmed,
            _note: 'Results sorted by NWCA 10yr sales history (proven sellers first). nwca_units_10yr=null means SanMar catalog only — we have never sold this style.',
        };
    } catch (err) {
        console.error('[emb-quote-ai] search_products_by_keyword error:', err.message);
        return { error: 'tool_exception', message: err.message, q };
    }
}

// === EMB Smart A1: lookup_customer_history ================================
async function lookupCustomerHistory(input) {
    const idCustomer = Number(input?.idCustomer);
    if (!Number.isInteger(idCustomer) || idCustomer <= 0) {
        return { error: 'bad_input', message: 'idCustomer must be a positive integer' };
    }
    const windowDays = Number.isFinite(Number(input?.windowDays))
        ? Math.max(30, Math.min(730, Number(input.windowDays)))
        : 365;
    try {
        const url = `${INTERNAL_API_BASE}/api/customer-history/${idCustomer}?windowDays=${windowDays}`;
        const r = await fetch(url);
        if (!r.ok) {
            return { error: 'http_' + r.status, message: 'customer-history endpoint failed' };
        }
        const data = await r.json();
        // Slim down the response — drop fields the bot doesn't need (contactBackfill is
        // a UI-only field; lastShipTo + dates are useful; behavioral aggregations are the gold).
        return {
            idCustomer: data.idCustomer,
            hasHistory: data.hasHistory,
            orderCount: data.orderCount || 0,
            windowDays,
            firstOrderDate: data.firstOrderDate || null,
            lastOrderDate: data.lastOrderDate || null,
            lastOrderDaysAgo: data.lastOrderDaysAgo || null,
            topItems: data.topItems || [],         // [{partNumber, color, units}]
            topBrands: data.topBrands || [],       // [{brand, units}]
            topCategories: data.topCategories || [], // [{category, units}]
            topTerms: data.topTerms || null,       // e.g. 'Net 30'
            topShipMethod: data.topShipMethod || null,
            totalRevenue: data.totalRevenue || 0,
            avgOrderSize: data.avgOrderSize || 0,
            lastDesignName: data.lastDesignName || null,
            lastShipTo: data.lastShipTo || null,
        };
    } catch (err) {
        console.error('[emb-quote-ai] lookup_customer_history error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

// === EMB Smart A2: lookup_lookalike_customers =============================
async function lookupLookalikeCustomers(input) {
    const industry = String(input?.industry || '').trim();
    if (!industry) {
        return { error: 'bad_input', message: 'industry parameter is required' };
    }
    const limit = Number.isFinite(Number(input?.limit))
        ? Math.max(1, Math.min(25, Number(input.limit)))
        : 10;
    try {
        const url = `${INTERNAL_API_BASE}/api/industry-lookalikes/${encodeURIComponent(industry)}?limit=${limit}`;
        const r = await fetch(url, { headers: INTERNAL_AUTH_HEADERS });
        if (!r.ok) {
            return { error: 'http_' + r.status, message: 'industry-lookalikes endpoint failed' };
        }
        const data = await r.json();
        if (!data.found) {
            return {
                industry,
                found: false,
                message: data.message || `No lookalike data for industry "${industry}".`,
            };
        }
        return {
            industry: data.industry,
            found: true,
            customerCount: data.customerCount,
            totalUnits: data.totalUnits,
            totalRevenue: data.totalRevenue,
            sampleSizeNote: data.sampleSizeNote || null,
            topStyles: data.topStyles || [],   // [{style, style_rank, total_units, top_colors: [...]}]
            exemplars: (data.exemplars || []).slice(0, 5),
            _note: data._note,
        };
    } catch (err) {
        console.error('[emb-quote-ai] lookup_lookalike_customers error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

// === EMB Smart A3: classify_company_via_web ===============================
// Port of the classification flow from scripts/aggregate-industry-lookalikes-v2.js
// (phase4). Tries inferIndustry first (free) — only falls back to Tavily if the
// name itself isn't classifiable.
async function classifyCompanyViaWeb(input) {
    const companyName = String(input?.companyName || '').trim();
    if (companyName.length < 3) {
        return { error: 'bad_input', message: 'companyName must be 3+ characters' };
    }
    // First — try name-pattern inference (free, instant). Most customers
    // classify here without any Tavily call.
    const nameInf = inferIndustry(companyName);
    if (nameInf.industry !== 'Unknown') {
        return {
            companyName,
            industry: nameInf.industry,
            confidence: nameInf.confidence,
            signal: nameInf.signal,
            source: 'name_pattern',
        };
    }
    // Fall back to web search
    try {
        const result = await webSearch({
            query: `"${companyName}" company business industry`,
            purpose: 'EMB chat bot — classify customer industry',
            maxResults: 3,
            searchDepth: 'basic',
        });
        if (result?.error) {
            return {
                companyName,
                industry: 'Unknown',
                error: result.error,
                message: result.message || 'Web search unavailable',
            };
        }
        // Prefer Tavily's curated `answer` field over scraped snippets — same
        // strategy as the aggregator. Falls back to snippets if no answer.
        let inf = { industry: 'Unknown', confidence: 'unknown', signal: null };
        if (result?.answer) {
            inf = inferIndustry(String(result.answer).slice(0, 1000));
        }
        if (inf.industry === 'Unknown' && Array.isArray(result?.results)) {
            const blob = result.results.map(x => `${x.title || ''} ${x.snippet || x.content || ''}`).join(' ');
            if (blob) inf = inferIndustry(blob.slice(0, 1500));
        }
        return {
            companyName,
            industry: inf.industry,
            confidence: inf.industry === 'Unknown' ? 'unknown' : 'web-classified',
            signal: inf.signal,
            source: 'web_search',
            snippet: result?.answer
                ? String(result.answer).slice(0, 250)
                : ((result?.results || [])[0]?.snippet || '').slice(0, 250),
        };
    } catch (err) {
        console.error('[emb-quote-ai] classify_company_via_web error:', err.message);
        return {
            companyName,
            industry: 'Unknown',
            error: 'tool_exception',
            message: err.message,
        };
    }
}

// === EMB Smart E2: lookup_customer_master_profile =========================
async function lookupCustomerMasterProfile(input) {
    const id = Number(input?.idCustomer);
    const name = String(input?.companyName || '').trim();
    if (!Number.isInteger(id) && !name) {
        return { error: 'bad_input', message: 'Pass either idCustomer (preferred) or companyName' };
    }
    try {
        const url = Number.isInteger(id) && id > 0
            ? `${INTERNAL_API_BASE}/api/customer-profile/${id}`
            : `${INTERNAL_API_BASE}/api/customer-profile/by-company/${encodeURIComponent(name)}`;
        const r = await fetch(url, { headers: INTERNAL_AUTH_HEADERS });
        if (!r.ok) return { error: 'http_' + r.status, message: 'customer-profile endpoint failed' };
        const data = await r.json();
        if (!data.found) {
            return {
                found: false,
                lookup_kind: id ? 'idCustomer' : 'companyName',
                lookup_value: id || name,
                message: data.message || `No 10-year profile found. Customer may not have any SanMar purchases on record.`,
            };
        }
        // Single-profile (by id) vs multi-match (by name)
        const profile = data.profile || (data.profiles || [])[0];
        return {
            found: true,
            profile,
            other_matches: data.profiles && data.profiles.length > 1
                ? data.profiles.slice(1).map(p => ({ id_Customer: p.id_Customer, name: p.CustomerCompanyName, revenue: p.Total_Revenue_10yr }))
                : [],
        };
    } catch (err) {
        console.error('[emb-quote-ai] lookup_customer_master_profile error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

// === EMB Smart G: imputed TARGET deal margin (uses Caspio Pricing_Tiers + Embroidery_Costs)
//
// What this computes: for a style at its typical order qty, what's the
// customer-facing per-unit price + per-unit profit at NWCA's standard formula:
//     SellPrice = (GarmentCost + EmbroideryCost) / MarginDenominator (0.57)
// → Target margin: 43% all-in
//
// Fields added per style:
//   avg_qty_per_order                          int (units / orders)
//   imputed_embroidery_cost_per_unit            $ NWCA internal cost for 8K stitch
//   imputed_all_in_cost_per_unit                $ garment wholesale + embroidery
//   imputed_target_customer_price_per_unit      $ what we'd charge at 43% target margin
//   imputed_target_profit_per_unit              $ what we'd net at target
//   margin_assumptions                          text noting "8K stitch, qty tier X-Y"
//
// IMPORTANT — we do NOT compute "historical actual deal margin." Caspio's
// avg_sell_price is the line price from ShopWorks line items, which in many
// historical orders is the garment-only line (embroidery was on a separate
// line that doesn't roll up into this aggregation). Adding our internal
// embroidery cost to that garment-only sell price produces misleading
// "deal margin below cost" numbers. So we expose:
//   - Garment-side actual margin (existing: avg_margin_pct + avg_unit_profit_dollars)
//   - Target all-in customer price + profit (new fields above)
// The bot uses garment-side for ranking; target-side for "what would we quote."
//
// Graceful degrade: if cache unavailable or required source fields missing,
// these fields are omitted entirely.
function enrichWithImputedMargin(s) {
    if (!s) return s;
    const denom = embPricingCache.getMarginDenominator();
    if (!denom || denom <= 0) return s; // cache not ready — graceful degrade

    const sanmarCost = Number(s.avg_our_cost) || 0;
    const units = Number(s.total_units_10yr) || 0;
    const orders = Number(s.total_orders_10yr) || 0;
    if (sanmarCost <= 0 || orders <= 0) return s;

    const avgQtyPerOrder = Math.max(1, Math.round(units / orders));
    const itemType = embPricingCache.classifyItemType(s.category_name);
    const embroideryCost = embPricingCache.getEmbroideryCost({ itemType, qty: avgQtyPerOrder });
    if (embroideryCost == null) return s;

    const allInCost = sanmarCost + embroideryCost;
    const targetPrice = Math.round((allInCost / denom) * 100) / 100;
    const targetProfit = Math.round((targetPrice - allInCost) * 100) / 100;
    const tier = embPricingCache.pickTier(avgQtyPerOrder);

    return {
        ...s,
        avg_qty_per_order: avgQtyPerOrder,
        imputed_embroidery_cost_per_unit: embroideryCost,
        imputed_all_in_cost_per_unit: Math.round(allInCost * 100) / 100,
        imputed_target_customer_price_per_unit: targetPrice,
        imputed_target_profit_per_unit: targetProfit,
        margin_assumptions: `8K stitch ${itemType.toLowerCase()}, single logo, qty tier ${tier}, today's Caspio pricing — TARGET margin 43%`,
    };
}

// === EMB Smart E2: lookup_style_performance ===============================
async function lookupStylePerformance(input) {
    const style = String(input?.style || '').trim().toUpperCase();
    if (!style) return { error: 'bad_input', message: 'style parameter required' };
    try {
        const url = `${INTERNAL_API_BASE}/api/style-performance/${encodeURIComponent(style)}`;
        const r = await fetch(url);
        if (!r.ok) return { error: 'http_' + r.status, message: 'style-performance endpoint failed' };
        const data = await r.json();
        if (!data.found) {
            return { found: false, style, message: data.message };
        }
        // Bot is REP-ONLY (chat panel internal to NWCA). Strip raw SanMar
        // case price (avg_our_cost / current_case_price) — those are what we
        // PAY SanMar, sensitive vendor data we never echo. Keep margin %,
        // unit profit $, and total lifetime $ — those are computed metrics
        // the rep needs to make smart upsell/quote decisions.
        const sRaw = data.style;
        // Phase G: enrich with all-in deal margin from Caspio Pricing_Tiers + Embroidery_Costs.
        // ensureFresh awaited so cold-cache responses don't skip imputation on first hit.
        try { await embPricingCache.ensureFresh(); } catch (_) { /* graceful degrade */ }
        const s = enrichWithImputedMargin(sRaw);
        const avgUnitProfit = (sRaw.avg_sell_price > 0 && sRaw.avg_our_cost > 0)
            ? Math.round((sRaw.avg_sell_price - sRaw.avg_our_cost) * 100) / 100
            : 0;
        const totalLifetimeProfit = (sRaw.total_units_10yr > 0 && avgUnitProfit > 0)
            ? Math.round(sRaw.total_units_10yr * avgUnitProfit)
            : 0;
        return {
            found: true,
            style: s.style,
            product_title: s.product_title,
            brand_name: s.brand_name,
            category_name: s.category_name,
            subcategory_name: s.subcategory_name,
            decade_rank: s.decade_rank,
            total_units_10yr: s.total_units_10yr,
            total_revenue_10yr: s.total_revenue_10yr,
            total_orders_10yr: s.total_orders_10yr,
            avg_qty_per_order: s.avg_qty_per_order,  // Phase G — derived
            // GARMENT-SIDE margin (SanMar wholesale spread only — useful for
            // garment-vs-garment ranking, NOT for "is this deal profitable")
            avg_margin_pct: s.avg_margin_pct,
            avg_unit_profit_dollars: avgUnitProfit,
            total_lifetime_profit_dollars: totalLifetimeProfit,
            // PHASE G — TARGET all-in pricing (garment + embroidery cost).
            // Bot's quote builder formula: SellPrice = (GarmentCost + EmbroideryCost) / 0.57.
            // → Target margin always 43%. These are what we WOULD quote at standard
            // pricing today, not historical actuals. Use to answer "what would I quote
            // PC54 for at 25 units?" or "how much do we make per unit at target."
            imputed_embroidery_cost_per_unit: s.imputed_embroidery_cost_per_unit,
            imputed_all_in_cost_per_unit: s.imputed_all_in_cost_per_unit,
            imputed_target_customer_price_per_unit: s.imputed_target_customer_price_per_unit,
            imputed_target_profit_per_unit: s.imputed_target_profit_per_unit,
            margin_assumptions: s.margin_assumptions,
            // PRICE FIELDS DELIBERATELY STRIPPED: avg_sell_price, avg_our_cost,
            // msrp, current_case_price (don't expose SanMar's vendor pricing).
            product_status: s.product_status,
            top_colors: s.top_colors,
            customer_types_that_buy: s.customer_types_that_buy,
            frequently_paired_with: s.frequently_paired_with,
            companion_styles: s.companion_styles,
            keywords: s.keywords,
        };
    } catch (err) {
        console.error('[emb-quote-ai] lookup_style_performance error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

// === EMB Smart E2: recommend_high_margin_alternative ======================
async function recommendHighMarginAlternative(input) {
    const style = String(input?.style || '').trim().toUpperCase();
    if (!style) return { error: 'bad_input', message: 'style parameter required' };
    try {
        const url = `${INTERNAL_API_BASE}/api/style-performance/high-margin-alternatives/${encodeURIComponent(style)}`;
        const r = await fetch(url);
        if (!r.ok) return { error: 'http_' + r.status, message: 'high-margin-alternatives endpoint failed' };
        const data = await r.json();
        if (!data.found) return { found: false, style, message: data.message };
        // Strip SanMar vendor pricing (cost, sell price) from base + alternatives.
        // KEEP margin % AND avg_unit_profit_dollars so the bot can reason about
        // both efficiency (%) and absolute dollars per unit. CTJ162 lesson:
        // 14.6% margin still makes $14+/unit — better than a 76% tee at $7.
        // Phase G: also enrich with all-in deal margin (garment + embroidery).
        try { await embPricingCache.ensureFresh(); } catch (_) { /* graceful degrade */ }
        const shape = (sRaw) => {
            const s = enrichWithImputedMargin(sRaw);
            const avgUnitProfit = (sRaw.avg_sell_price > 0 && sRaw.avg_our_cost > 0)
                ? Math.round((sRaw.avg_sell_price - sRaw.avg_our_cost) * 100) / 100
                : 0;
            return {
                style: s.style, product_title: s.product_title, brand_name: s.brand_name,
                category_name: s.category_name, subcategory_name: s.subcategory_name,
                // Garment-side (existing)
                avg_margin_pct: s.avg_margin_pct,
                avg_unit_profit_dollars: avgUnitProfit,
                decade_rank: s.decade_rank,
                total_units_10yr: s.total_units_10yr,
                avg_qty_per_order: s.avg_qty_per_order,
                // Phase G — target all-in pricing (43% margin formula)
                imputed_embroidery_cost_per_unit: s.imputed_embroidery_cost_per_unit,
                imputed_all_in_cost_per_unit: s.imputed_all_in_cost_per_unit,
                imputed_target_customer_price_per_unit: s.imputed_target_customer_price_per_unit,
                imputed_target_profit_per_unit: s.imputed_target_profit_per_unit,
                margin_assumptions: s.margin_assumptions,
            };
        };
        const stripPrice = shape; // backwards-compat alias if anyone calls it
        return {
            found: true,
            base: shape(data.base),
            alternatives: (data.alternatives || []).map(shape),
            count: data.count,
            _note: data._note,
        };
    } catch (err) {
        console.error('[emb-quote-ai] recommend_high_margin_alternative error:', err.message);
        return { error: 'tool_exception', message: err.message };
    }
}

async function executeTool(name, input) {
    if (name === 'lookup_customer') {
        try {
            return await lookupCustomerSmart(input?.query);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_customer error:', err.message);
            return { matches: [], error: err.message };
        }
    }
    if (name === 'recommend_top_sellers_emb') {
        try {
            return await recommendTopSellersEmb(input);
        } catch (err) {
            console.error('[emb-quote-ai] recommend_top_sellers_emb error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'lookup_product_details') {
        try {
            return await lookupProductDetails(input);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_product_details error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'search_products_by_keyword') {
        try {
            return await searchProductsByKeyword(input);
        } catch (err) {
            console.error('[emb-quote-ai] search_products_by_keyword error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'rank_styles_by_price') {
        try {
            return await rankStylesByPrice(input);
        } catch (err) {
            console.error('[emb-quote-ai] rank_styles_by_price error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'find_styles_by_color' || name === 'find_styles_by_pms_color') {
        // Accept the old name for backwards compat in case the model
        // remembers it from cached prompts during the rollover.
        try {
            return await findStylesByColor(input);
        } catch (err) {
            console.error('[emb-quote-ai] find_styles_by_color error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    // === EMB Smart A1/A2/A3 ====================================================
    if (name === 'lookup_customer_history') {
        try {
            return await lookupCustomerHistory(input);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_customer_history error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'lookup_lookalike_customers') {
        try {
            return await lookupLookalikeCustomers(input);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_lookalike_customers error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'classify_company_via_web') {
        try {
            return await classifyCompanyViaWeb(input);
        } catch (err) {
            console.error('[emb-quote-ai] classify_company_via_web error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    // === EMB Smart E2: new tools ============================================
    if (name === 'lookup_customer_master_profile') {
        try {
            return await lookupCustomerMasterProfile(input);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_customer_master_profile error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'lookup_style_performance') {
        try {
            return await lookupStylePerformance(input);
        } catch (err) {
            console.error('[emb-quote-ai] lookup_style_performance error:', err.message);
            return { error: 'tool_exception', message: err.message };
        }
    }
    if (name === 'recommend_high_margin_alternative') {
        try {
            return await recommendHighMarginAlternative(input);
        } catch (err) {
            console.error('[emb-quote-ai] recommend_high_margin_alternative error:', err.message);
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
            throw new Error('ANTHROPIC_API_KEY env var is not set on caspio-pricing-proxy.');
        }
        anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return anthropicClient;
}

function buildCalcContextBlock(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const parts = [];
    if (typeof ctx.quoteID === 'string' && ctx.quoteID) {
        parts.push(`quoteID: ${ctx.quoteID}`);
    }
    return parts.length ? parts.join('\n') : null;
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

// Phase G — debug endpoint for verifying the embroidery pricing cache loaded
// at startup. Returns Pricing_Tiers row count, Embroidery_Costs row count,
// the universal marginDenominator (should be 0.57), and a 6-row sample of
// the loaded costs. Used for smoke-testing the cache post-deploy.
router.get('/emb-margin-cache-status', (req, res) => {
    res.json(embPricingCache.getCacheStatus());
});

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
        const MAX_TOOL_ITERATIONS = 8;
        let finalStopReason = 'end_turn';

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const stream = client.messages.stream({
                model: 'claude-sonnet-4-6',
                max_tokens: 1800,
                tools: TOOLS,
                system: [
                    {
                        type: 'text',
                        text: CONTRACT_EMB_QUOTE_AI_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
                messages: workingMessages,
            });

            stream.on('text', (delta) => {
                sendEvent('delta', { text: delta });
            });

            stream.on('error', (err) => {
                console.error('[emb-quote-ai] stream error:', err.message);
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

            // Run tools in parallel — Promise.all preserves order so tool_use_id alignment holds.
            const toolResults = await Promise.all(toolUseBlocks.map(async (tu) => {
                const t0 = Date.now();
                const result = await executeTool(tu.name, tu.input);
                const elapsed = Date.now() - t0;
                sendEvent('tool_result', { tool: tu.name, result });
                console.log(`[emb-quote-ai] tool ${tu.name} (${elapsed}ms) → ${JSON.stringify(result).slice(0, 120)}`);
                return {
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify(result),
                };
            }));
            workingMessages.push({ role: 'user', content: toolResults });
        }

        sendEvent('done', { stop_reason: finalStopReason, usage: totalUsage });
        res.end();

        console.log(`[emb-quote-ai] done — in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} cache_read=${totalUsage.cache_read_input_tokens} cache_write=${totalUsage.cache_creation_input_tokens}`);
    } catch (e) {
        console.error('[emb-quote-ai] error:', e.message);
        if (e instanceof APIError) {
            sendEvent('error', { message: `Claude API error ${e.status}: ${e.message}` });
        } else {
            sendEvent('error', { message: e.message });
        }
        res.end();
    }
});

module.exports = router;
