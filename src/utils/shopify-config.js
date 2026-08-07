// 253gear publisher config — loaded from the Erik-editable Caspio table
// `Shopify_Config_2026`, never from code.
//
// Erik's standing rule (CLAUDE.md, "Pricing = API, never hardcoded"): every price,
// fee, upcharge and config value comes from the backend so he changes a number in
// Caspio and the store reflects it with NO deploy.
//
// Rule 4 corollary — there is deliberately NO built-in default. If the table is
// missing a required key this throws NOT_CONFIGURED naming exactly what is absent,
// and the route returns 503. Publishing a product at a price nobody set would be
// worse than refusing to publish at all.
//
// Table shape (key/value, one row per setting):
//   Config_Key TEXT(255) | Config_Value TEXT(64000) | Value_Type TEXT(20)
//   Notes TEXT(255)      | Active TEXT(3) Yes/No     | Updated_At TIMESTAMP
//
// Key/value rather than wide columns because the shape keeps moving — a fourth
// garment, a new city, a new tag rule — and Erik edits it through a DataPage.
// Precedent: src/routes/product-upgrades.js.

'use strict';

const { fetchAllCaspioPages } = require('./caspio');
const { createTtlCache } = require('./ttl-cache');

const TABLE = 'Shopify_Config_2026';
const CACHE_KEY = 'config';

const configCache = createTtlCache({ name: 'shopify-config', ttlMs: 5 * 60 * 1000, maxEntries: 2 });

/**
 * Every key that must exist before a product can be built.
 * `styles` carries per-garment price, SanMar style, weight and filter tag together,
 * so a new garment is ONE row to edit rather than four.
 */
const REQUIRED_KEYS = ['styles', 'size_ladder', 'size_order', 'base_tags', 'vendor', 'product_type'];

// Written by POST /api/shopify/config/refresh-collections after reading the live
// smart-collection ruleSets. Absent until that has run at least once.
const COLLECTION_KEYS = ['tag_vocabulary', 'collection_rules'];

class ConfigError extends Error {
    constructor(message, code, detail) {
        super(message);
        this.name = 'ConfigError';
        this.code = code;
        this.detail = detail;
    }
}

function isYes(v) { return String(v || '').trim().toLowerCase() === 'yes'; }

function parseValue(raw, type) {
    const value = raw === null || raw === undefined ? '' : String(raw);
    switch (String(type || 'string').trim().toLowerCase()) {
        case 'json':
            try { return JSON.parse(value); } catch (e) {
                throw new ConfigError(`Config value is not valid JSON`, 'BAD_CONFIG_JSON', { raw: value.slice(0, 200) });
            }
        case 'number': {
            const n = Number(value);
            if (!Number.isFinite(n)) throw new ConfigError('Config value is not a number', 'BAD_CONFIG_NUMBER', { raw: value });
            return n;
        }
        case 'bool':
        case 'boolean':
            return /^(yes|true|1)$/i.test(value.trim());
        default:
            return value;
    }
}

/** Raw Caspio rows -> { key: parsedValue }, skipping Active=No. */
function rowsToMap(rows) {
    const out = {};
    for (const r of rows || []) {
        const key = String(r.Config_Key || '').trim();
        if (!key) continue;
        if (r.Active !== undefined && r.Active !== null && String(r.Active).trim() !== '' && !isYes(r.Active)) continue;
        try {
            out[key] = parseValue(r.Config_Value, r.Value_Type);
        } catch (e) {
            throw new ConfigError(`Config key "${key}": ${e.message}`, e.code || 'BAD_CONFIG', e.detail);
        }
    }
    return out;
}

/**
 * Shape the flat key/value map into what shopify-product-builder expects.
 * `prices` is DERIVED from styles[].price so a garment's price and its SanMar
 * mapping can never drift apart across two rows.
 */
function shapeConfig(map) {
    const missing = REQUIRED_KEYS.filter((k) => map[k] === undefined);
    if (missing.length) {
        throw new ConfigError(
            `${TABLE} is missing required keys: ${missing.join(', ')}`, 'NOT_CONFIGURED', { missing, table: TABLE }
        );
    }

    const styles = map.styles;
    if (!Array.isArray(styles) || !styles.length) {
        throw new ConfigError('Config key "styles" must be a non-empty JSON array', 'BAD_CONFIG', { got: typeof styles });
    }

    const prices = {};
    for (const s of styles) {
        if (!s || !s.option) {
            throw new ConfigError('Every entry in "styles" needs an `option`', 'BAD_CONFIG', { entry: s });
        }
        // ⚠️ Reject EMPTY before coercing. `Number(null)` and `Number('')` are both 0,
        // and 0 is finite — so a lone isFinite() guard turns "nobody set this price"
        // into the fact "this garment costs $0.00" and ships it to a live storefront.
        // Absent must never become zero.
        const raw = s.price;
        const empty = raw === null || raw === undefined || String(raw).trim() === '';
        if (empty || !Number.isFinite(Number(raw)) || Number(raw) <= 0) {
            throw new ConfigError(
                `Style "${s.option}" has no usable price — set it in ${TABLE}, key "styles"`,
                'NOT_CONFIGURED', { option: s.option, got: raw }
            );
        }
        if (!s.sanmarStyle) {
            throw new ConfigError(`Style "${s.option}" has no sanmarStyle (needed for SKU and weight)`, 'BAD_CONFIG', { option: s.option });
        }
        prices[s.option] = Number(s.price);
    }

    return {
        prices,
        styles,
        sizeLadder: map.size_ladder || {},
        sizeOrder: map.size_order || [],
        baseTags: map.base_tags || [],
        tagVocabulary: map.tag_vocabulary || [],
        collectionRules: map.collection_rules || [],
        vendor: map.vendor || '',
        productType: map.product_type || '',
        publicationId: map.publication_id || '',
        descriptionPrompt: map.description_prompt || '',
        // True only once refresh-collections has run. The classifier and the tag
        // check both degrade to "cannot verify" rather than guessing when false.
        collectionsKnown: COLLECTION_KEYS.every((k) => map[k] !== undefined)
    };
}

/**
 * Load and shape the config. Cached 5 minutes; `{ refresh: true }` bypasses.
 * Throws ConfigError('NOT_CONFIGURED') when the table is absent or incomplete —
 * callers turn that into a 503 naming the missing keys.
 */
async function loadConfig({ refresh = false } = {}) {
    if (!refresh) {
        const hit = configCache.get(CACHE_KEY);
        if (hit) return hit;
    }

    let rows;
    try {
        rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, { 'q.pageSize': 200 });
    } catch (e) {
        const status = e.response && e.response.status;
        if (status === 404) {
            throw new ConfigError(
                `Caspio table ${TABLE} does not exist yet — create it and seed the required keys`,
                'NOT_CONFIGURED', { table: TABLE, required: REQUIRED_KEYS }
            );
        }
        throw new ConfigError(`Could not read ${TABLE}: ${e.message}`, 'CONFIG_READ_FAILED');
    }

    if (!rows || !rows.length) {
        throw new ConfigError(
            `Caspio table ${TABLE} is empty — seed the required keys before publishing`,
            'NOT_CONFIGURED', { table: TABLE, required: REQUIRED_KEYS }
        );
    }

    const shaped = shapeConfig(rowsToMap(rows));
    // Only cache a verified-complete config (ttl-cache's stated rule for callers).
    configCache.set(CACHE_KEY, shaped);
    return shaped;
}

/** Drop the cached config — used after refresh-collections writes new rows. */
function invalidate() {
    // ttl-cache exposes clear(), not delete(); this cache holds one key anyway.
    configCache.clear();
}

module.exports = {
    loadConfig,
    invalidate,
    shapeConfig,
    rowsToMap,
    parseValue,
    ConfigError,
    TABLE,
    REQUIRED_KEYS,
    COLLECTION_KEYS
};
