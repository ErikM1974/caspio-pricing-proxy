#!/usr/bin/env node
/**
 * aggregate-emb-top-sellers.js
 *
 * One-shot aggregation: turns ~10 years of raw EMB order line items
 * (ShopWorks export CSV) into a Caspio-importable top-sellers CSV that
 * matches the EMB_Top_Sellers_2026 schema.
 *
 * Pipeline:
 *   1. Read the raw CSV (id_Order, PartNumber, PartColor, Size01..06, etc.)
 *   2. Strip size suffixes (_2X, _3X, _OSFA, _S/M, etc.) → base PartNumber
 *   3. Aggregate per (base_part, color):
 *        - total_units_sold (sum across all rows)
 *        - total_orders (count of distinct id_Order)
 *        - per-size totals (sum each Size column across)
 *   4. For each unique base_part, hit /api/product-details to look up:
 *        - CATEGORY_NAME, SUBCATEGORY_NAME (SanMar's own taxonomy)
 *        - CATALOG_COLOR per color (canonical color code)
 *        - swatch image URL (COLOR_SQUARE_IMAGE)
 *        - product title
 *   5. Group by CATEGORY_NAME, rank styles by total volume WITHIN category
 *   6. Pick top N per category (PER_CATEGORY_LIMIT) — coverage > pure volume
 *      so the bot can recommend across the full SanMar product spectrum
 *   7. For each picked style, pick top M colors (COLORS_PER_STYLE)
 *   8. Emit Caspio-import CSV: one row per (style, color) combo
 *
 * Usage:
 *   node scripts/aggregate-emb-top-sellers.js <input.csv> [output.csv]
 *
 * Defaults: output to ./caspio-import-emb-top-sellers.csv
 *
 * Tunables (constants below):
 *   PER_CATEGORY_LIMIT      — how many top styles per category (default 4)
 *   COLORS_PER_STYLE        — how many top colors per style (default 6)
 *   MIN_UNITS_TO_QUALIFY    — filter floor; skip styles with < this many
 *                              lifetime units (default 30)
 *   CATEGORIES_TO_INCLUDE   — SanMar categories that make sense for EMB
 *
 * Author: Claude (2026-05-24) — EMB Chat Milestone A data prep.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --- Configuration ---------------------------------------------------------

const PER_CATEGORY_LIMIT = 4;       // top N styles per SanMar category
const COLORS_PER_STYLE   = 6;       // top M colors per style
const MIN_UNITS_TO_QUALIFY = 30;    // filter floor (lifetime units)

// Categories from SanMar's /api/all-categories that are relevant for embroidery.
// Skip: Personal Protection, Infant & Toddler, Tall (cross-cutting modifier),
// Juniors & Young Men (rarely embroidered), Youth (rare for EMB), Ladies
// (cross-cutting fit — Ladies polos still bucket as "Polos/Knits").
const CATEGORIES_TO_INCLUDE = new Set([
    'T-Shirts',
    'Polos/Knits',
    'Sweatshirts/Fleece',
    'Outerwear',
    'Caps',
    'Bags',
    'Workwear',
    'Woven Shirts',
    'Accessories',
    'Activewear',
]);

// Internal SanMar API base — read from env or hardcoded prod URL.
const API_BASE = process.env.PROXY_PUBLIC_URL ||
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Per-style fetch cache so we hit SanMar once per unique base part.
const _styleCache = new Map();

// --- CLI -------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node aggregate-emb-top-sellers.js <input.csv> [output.csv]');
    process.exit(1);
}

const INPUT_PATH = args[0];
const OUTPUT_PATH = args[1] || path.resolve(process.cwd(), 'caspio-import-emb-top-sellers.csv');

if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Input file not found: ${INPUT_PATH}`);
    process.exit(1);
}

// --- CSV parsing -----------------------------------------------------------

// Small CSV parser that handles quoted fields with embedded commas/newlines.
// Returns array of arrays. Skips the header.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += ch; i++; continue;
        }
        if (ch === '"') { inQuotes = true; i++; continue; }
        if (ch === ',') { row.push(field); field = ''; i++; continue; }
        if (ch === '\r') { i++; continue; }
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// --- Size-suffix stripping -------------------------------------------------

// Common SanMar size suffixes that get appended to a base PartNumber.
// Order matters — longer patterns first (so "_2XL" matches before "_2X").
const SIZE_SUFFIX_RE =
    /_(?:XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|2X|3X|4X|5X|6X|OSFA|S\/M|M\/L|L\/XL|X\/L|XLT|XXLT|2XLT|3XLT|4230|4060|0|1|2|3|4|5|6|7|8|9)$/i;

function baseOf(partNumber) {
    let pn = String(partNumber || '').trim();
    // Strip suffix iteratively to handle compound cases (rare but defensive).
    while (SIZE_SUFFIX_RE.test(pn)) {
        const stripped = pn.replace(SIZE_SUFFIX_RE, '');
        if (stripped === pn || stripped.length === 0) break;
        pn = stripped;
    }
    return pn.toUpperCase();
}

// --- Color normalization ---------------------------------------------------

// CSV color names sometimes have trailing whitespace, newlines, or weird
// punctuation ("Charcoal/ Charcoal\n"). Normalize for grouping.
function normColor(s) {
    return String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/\s*\/\s*/g, '/')
        .trim()
        .toLowerCase();
}
function displayColor(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim();
}

// --- SanMar lookup ---------------------------------------------------------

async function fetchProductDetails(styleNumber) {
    if (_styleCache.has(styleNumber)) return _styleCache.get(styleNumber);
    try {
        const r = await fetch(`${API_BASE}/api/product-details?styleNumber=${encodeURIComponent(styleNumber)}`);
        if (!r.ok) {
            _styleCache.set(styleNumber, null);
            return null;
        }
        const rows = await r.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            _styleCache.set(styleNumber, null);
            return null;
        }
        // Build the lookup object: meta + color map
        const meta = rows[0];
        const colorMap = {};
        for (const row of rows) {
            const key = normColor(row.COLOR_NAME);
            if (!key || colorMap[key]) continue;
            colorMap[key] = {
                colorName:  row.COLOR_NAME || '',
                catalogColor: row.CATALOG_COLOR || row.COLOR_NAME || '',
                swatchUrl:  row.COLOR_SQUARE_IMAGE || '',
                frontModel: row.FRONT_MODEL || '',
            };
        }
        const out = {
            style:         meta.STYLE || styleNumber,
            title:         meta.PRODUCT_TITLE || '',
            brand:         meta.BRAND_NAME || '',
            category:      meta.CATEGORY_NAME || '',
            subcategory:   meta.SUBCATEGORY_NAME || '',
            productImage:  meta.PRODUCT_IMAGE || '',
            productStatus: meta.PRODUCT_STATUS || '',     // Active / Discontinued / etc.
            colorMap,
        };
        _styleCache.set(styleNumber, out);
        return out;
    } catch (err) {
        console.warn(`[lookup] ${styleNumber} fetch failed: ${err.message}`);
        _styleCache.set(styleNumber, null);
        return null;
    }
}

// Hydrate SanMar details for a list of styles with light concurrency.
async function hydrateStyles(styles) {
    const concurrency = 4;
    const queue = styles.slice();
    const results = {};
    async function worker() {
        while (queue.length) {
            const st = queue.shift();
            results[st] = await fetchProductDetails(st);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
}

// --- Aggregation -----------------------------------------------------------

const HEADERS_OF_INTEREST = [
    'id_Order', 'PartNumber', 'PartColor', 'PartDescriptionUnits',
    'Size01_Act', 'Size02_Act', 'Size03_Act', 'Size04_Act', 'Size05_Act', 'Size06_Act',
];

// Map size column → size label. For most garments: 01=S, 02=M, 03=L, 04=XL,
// 05=2XL, 06=3XL+. For caps/bags/OSFA items the size column is unused for
// the small sizes — items land in 06 with _OSFA suffix on the PN. For
// XS-starting product lines, things shift. We'll record both "raw col"
// totals AND best-effort size labels — Caspio schema has units_S, units_M,
// etc. so we have to commit to ONE mapping. Use the common-case mapping;
// edge cases (caps/bags/youth) get bucketed into "OSFA-ish" land.
const SIZE_COL_TO_LABEL = {
    'Size01_Act': 'S',
    'Size02_Act': 'M',
    'Size03_Act': 'L',
    'Size04_Act': 'XL',
    'Size05_Act': '2XL',
    'Size06_Act': '3XL_OR_OSFA',
};

// Extract size from a part-number suffix (PC54_2X → '2X', NE1020_S/M → 'S/M').
function suffixOf(partNumber) {
    const m = String(partNumber || '').match(SIZE_SUFFIX_RE);
    return m ? m[0].slice(1).toUpperCase() : '';
}

// Map a suffix string to a size column for accumulation. Returns one of
// XS/S/M/L/XL/2XL/3XL/4XL/5XL/6XL or null if not bucketable.
function suffixToSizeLabel(suffix) {
    if (!suffix) return null;
    const s = suffix.toUpperCase();
    if (s === 'XS') return 'XS';
    if (s === '2X' || s === '2XL') return '2XL';
    if (s === '3X' || s === '3XL') return '3XL';
    if (s === '4X' || s === '4XL') return '4XL';
    if (s === '5X' || s === '5XL') return '5XL';
    if (s === '6X' || s === '6XL') return '6XL';
    if (s === 'XLT') return 'XL';     // tall → XL bucket
    if (s === 'XXLT' || s === '2XLT') return '2XL';
    if (s === '3XLT') return '3XL';
    if (s === 'OSFA') return 'OSFA';
    if (s === 'S/M' || s === 'M/L' || s === 'L/XL' || s === 'X/L') return 'OSFA'; // cap fitted
    return null;
}

async function main() {
    console.log(`📂 Reading ${INPUT_PATH}…`);
    const raw = fs.readFileSync(INPUT_PATH, 'utf8');
    const rows = parseCsv(raw);
    if (rows.length === 0) {
        console.error('Empty CSV.');
        process.exit(1);
    }
    const header = rows[0].map(h => h.trim());
    const idx = {};
    for (const h of HEADERS_OF_INTEREST) {
        idx[h] = header.indexOf(h);
        if (idx[h] === -1) {
            console.error(`Missing required column: ${h}`);
            console.error(`Header found: ${header.join(', ')}`);
            process.exit(1);
        }
    }
    console.log(`✓ Parsed ${rows.length - 1} order line rows`);

    // === Pass 1: aggregate per (base_part, color) =================
    /**
     * agg: Map<basePN, {
     *   total_units_sold: number,
     *   total_orders: Set<id_Order>,
     *   colors: Map<normColor, {
     *     displayName: string,
     *     units: number,
     *     orders: Set,
     *     sizes: { S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL, XS, OSFA }
     *   }>,
     *   sampleDescription: string,
     * }>
     */
    const agg = new Map();
    let skippedRows = 0;
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 2) { skippedRows++; continue; }
        const pn = r[idx['PartNumber']];
        if (!pn) { skippedRows++; continue; }

        const base = baseOf(pn);
        if (!base) { skippedRows++; continue; }
        const suffix = suffixOf(pn);
        const colorRaw = r[idx['PartColor']];
        if (!colorRaw) { skippedRows++; continue; }
        const colorKey = normColor(colorRaw);
        if (!colorKey) { skippedRows++; continue; }
        const orderID = r[idx['id_Order']] || '';

        // Row total = sum of Size01..06
        let rowUnits = 0;
        const sizeCols = ['Size01_Act','Size02_Act','Size03_Act','Size04_Act','Size05_Act','Size06_Act'];
        const sizeQty = {};
        for (const col of sizeCols) {
            const n = Number(r[idx[col]] || 0);
            if (n > 0) {
                rowUnits += n;
                sizeQty[col] = n;
            }
        }
        if (rowUnits === 0) { skippedRows++; continue; }

        // Bucket each size column into a size label. The suffix-based
        // mapping wins (e.g. PC54_2X means all 2XL even if it landed in
        // Size06). If no suffix, fall through to the col→label default.
        const suffixSize = suffixToSizeLabel(suffix);

        if (!agg.has(base)) {
            agg.set(base, {
                total_units_sold: 0,
                total_orders: new Set(),
                colors: new Map(),
                sampleDescription: r[idx['PartDescriptionUnits']] || '',
            });
        }
        const sa = agg.get(base);
        sa.total_units_sold += rowUnits;
        if (orderID) sa.total_orders.add(orderID);

        if (!sa.colors.has(colorKey)) {
            sa.colors.set(colorKey, {
                displayName: displayColor(colorRaw),
                units: 0,
                orders: new Set(),
                sizes: { XS:0, S:0, M:0, L:0, XL:0, '2XL':0, '3XL':0, '4XL':0, '5XL':0, '6XL':0, OSFA:0 },
            });
        }
        const cs = sa.colors.get(colorKey);
        cs.units += rowUnits;
        if (orderID) cs.orders.add(orderID);

        if (suffixSize) {
            // Suffix tells us the canonical size — entire row goes to that bucket.
            if (cs.sizes[suffixSize] != null) cs.sizes[suffixSize] += rowUnits;
        } else {
            // No suffix — use the col→label default mapping per size column.
            for (const [col, q] of Object.entries(sizeQty)) {
                const label = SIZE_COL_TO_LABEL[col];
                if (label === '3XL_OR_OSFA') {
                    // Default Size06 to OSFA if base part is clearly a cap/bag,
                    // else 3XL. Heuristic: cap/bag detection comes later via
                    // SanMar category. For now, just split: if no suffix, this
                    // is ambiguous — bucket as OSFA (more common case in EMB
                    // data given the cap volume).
                    cs.sizes.OSFA += q;
                } else if (cs.sizes[label] != null) {
                    cs.sizes[label] += q;
                }
            }
        }
    }
    console.log(`✓ Aggregated ${agg.size} unique base PartNumbers (${skippedRows} rows skipped)`);

    // === Pass 2: hydrate SanMar metadata for each base part ========
    const allStyles = [...agg.keys()];
    console.log(`🔎 Looking up ${allStyles.length} styles in SanMar catalog (4 parallel)…`);
    const styleMeta = await hydrateStyles(allStyles);
    const hydrated = Object.values(styleMeta).filter(Boolean).length;
    console.log(`✓ Hydrated ${hydrated} / ${allStyles.length} styles`);

    // === Pass 3: filter + categorize + rank ========================
    // Each entry → {style, total_units, total_orders, category, subcategory,
    //               title, brand, colors: [{name, units, ...}]}
    const candidates = [];
    let skippedDiscontinued = 0;
    for (const [basePN, sa] of agg) {
        if (sa.total_units_sold < MIN_UNITS_TO_QUALIFY) continue;
        const meta = styleMeta[basePN];
        if (!meta) continue; // skip if no SanMar match (retired or non-SanMar)
        if (!CATEGORIES_TO_INCLUDE.has(meta.category)) continue;
        // Phase 11.8 (Erik 2026-05-24): bot should only recommend live SKUs.
        // Drop anything not 'Active' (Discontinued, Coming Soon, etc.) so reps
        // don't pitch products customers can't actually buy.
        if (meta.productStatus && meta.productStatus !== 'Active') {
            skippedDiscontinued++;
            continue;
        }

        // Rank colors within this style
        const colorRows = [...sa.colors.entries()]
            .map(([key, cs]) => {
                const cmEntry = meta.colorMap[key];
                return {
                    normKey: key,
                    color_name:   cmEntry ? cmEntry.colorName : cs.displayName,
                    catalog_color: cmEntry ? cmEntry.catalogColor : cs.displayName,
                    swatch_image_url: cmEntry ? cmEntry.swatchUrl : '',
                    color_units_sold: cs.units,
                    color_orders: cs.orders.size,
                    sizes: cs.sizes,
                };
            })
            .filter(c => c.color_units_sold > 0)
            .sort((a, b) => b.color_units_sold - a.color_units_sold)
            .slice(0, COLORS_PER_STYLE)
            .map((c, i) => ({ ...c, color_rank: i + 1 }));

        if (colorRows.length === 0) continue;

        candidates.push({
            style: basePN,
            total_units_sold: sa.total_units_sold,
            total_orders: sa.total_orders.size,
            product_title: meta.title,
            brand: meta.brand,
            category: meta.category,
            subcategory: meta.subcategory,
            colors: colorRows,
        });
    }
    console.log(`✓ ${candidates.length} candidate styles passed filters`);

    // Group by category and rank within
    const byCategory = new Map();
    for (const c of candidates) {
        if (!byCategory.has(c.category)) byCategory.set(c.category, []);
        byCategory.get(c.category).push(c);
    }
    for (const [, list] of byCategory) {
        list.sort((a, b) => b.total_units_sold - a.total_units_sold);
    }

    // Pick top N per category
    const picked = [];
    let globalRank = 0;
    for (const [category, list] of byCategory) {
        const topN = list.slice(0, PER_CATEGORY_LIMIT);
        for (const c of topN) {
            globalRank++;
            picked.push({ ...c, style_rank: globalRank });
        }
    }
    console.log(`✓ Picked ${picked.length} styles total across ${byCategory.size} categories`);

    // === Pass 4: emit CSV with EMB_Top_Sellers_2026 schema ========
    const csvHeader = [
        'style', 'style_rank', 'product_title', 'category', 'subcategory',
        'total_units_sold', 'total_orders',
        'color_name', 'catalog_color', 'color_units_sold', 'color_orders', 'color_rank',
        'units_XS', 'units_S', 'units_M', 'units_L', 'units_XL',
        'units_2XL', 'units_3XL', 'units_4XL', 'units_5XL', 'units_6XL',
        'units_OSFA',
        'swatch_image_url',
    ];

    const csvRows = [csvHeader];
    for (const style of picked) {
        for (const color of style.colors) {
            const sz = color.sizes;
            csvRows.push([
                style.style,
                style.style_rank,
                csvEscape(style.product_title),
                csvEscape(style.category),
                csvEscape(style.subcategory),
                style.total_units_sold,
                style.total_orders,
                csvEscape(color.color_name),
                csvEscape(color.catalog_color),
                color.color_units_sold,
                color.color_orders,
                color.color_rank,
                sz.XS || 0, sz.S || 0, sz.M || 0, sz.L || 0, sz.XL || 0,
                sz['2XL'] || 0, sz['3XL'] || 0, sz['4XL'] || 0, sz['5XL'] || 0, sz['6XL'] || 0,
                sz.OSFA || 0,
                csvEscape(color.swatch_image_url),
            ]);
        }
    }
    const csvText = csvRows.map(r => r.join(',')).join('\n') + '\n';
    fs.writeFileSync(OUTPUT_PATH, csvText, 'utf8');
    console.log(`✓ Wrote ${csvRows.length - 1} rows to ${OUTPUT_PATH}`);

    // === Pass 4b: emit lib/emb-curated-products.js (the bot's data source)
    // Mirrors lib/dtg-curated-products.js shape so the AI prompt can embed
    // it verbatim. Bot reads from this module (NOT a Caspio table) — keeps
    // the EMB chat backend zero-dependency on Caspio for the v1 launch.
    // Erik refreshes by re-running this script + committing the file.
    const jsPath = path.resolve(path.dirname(OUTPUT_PATH), 'emb-curated-products.generated.js');
    const jsCategoriesObj = {};
    // Group picked styles by a JS-friendly bucket key derived from SanMar's
    // category name (snake-case-ish). Caps + sweatshirts/fleece + outerwear
    // are the high-volume EMB buckets; we keep SanMar's labels intact in the
    // `category` field of each entry, but bucket-key for the object root.
    const CAT_TO_BUCKET = {
        'T-Shirts':           'tshirts',
        'Polos/Knits':        'polos',
        'Sweatshirts/Fleece': 'sweatshirts',  // covers hoodies + crewnecks + 1/4-zips
        'Outerwear':          'outerwear',
        'Caps':               'caps',
        'Bags':               'bags',
        'Workwear':           'workwear',
        'Woven Shirts':       'wovenshirts',
        'Accessories':        'accessories',
        'Activewear':         'activewear',
    };
    for (const p of picked) {
        const bucket = CAT_TO_BUCKET[p.category] || 'other';
        if (!jsCategoriesObj[bucket]) jsCategoriesObj[bucket] = [];
        jsCategoriesObj[bucket].push({
            styleNumber: p.style,
            name:        stripStyleTrailingPN(p.product_title, p.style),
            brand:       p.brand,
            category:    p.category,
            subcategory: p.subcategory,
            salesData:   `${p.total_units_sold.toLocaleString()} units lifetime (${p.total_orders} orders)`,
            salesRank:   p.style_rank,
            quality:     'excellent',
            bestColors:  p.colors.slice(0, 4).map(c => ({
                name:         c.color_name,
                catalogColor: c.catalog_color,
                units:        c.color_units_sold.toLocaleString(),
                swatchUrl:    c.swatch_image_url || '',
            })),
            notes:    '',
            bestFor:  '',
        });
    }
    const jsText =
`// EMB Curated Top-Sellers — AUTO-GENERATED by scripts/aggregate-emb-top-sellers.js
//
// Source: ${path.basename(INPUT_PATH)} (Erik's 10yr embroidery sales export)
// Filters: PRODUCT_STATUS='Active', categories ${[...CATEGORIES_TO_INCLUDE].join('/')}
// Picked: top ${PER_CATEGORY_LIMIT} styles per category, ${COLORS_PER_STYLE} colors max each
// Min units to qualify: ${MIN_UNITS_TO_QUALIFY}
// Generated: ${new Date().toISOString()}
//
// 🚨 Do NOT hand-edit this file. Re-run the aggregation script to refresh
// rankings. Quarterly cadence recommended (same as DTG). Or — if Erik wants
// to override the data-driven picks with his own picks — copy the entries
// you want into a hand-curated lib/emb-curated-products.js (without
// .generated.) and the bot will prefer that one.

const EMB_CURATED_PRODUCTS = ${JSON.stringify(jsCategoriesObj, null, 4)};

module.exports = { EMB_CURATED_PRODUCTS };
`;
    fs.writeFileSync(jsPath, jsText, 'utf8');
    console.log(`✓ Wrote curated JS module to ${jsPath}`);

    // === Pass 5: print human-readable summary =====================
    console.log('\n📊 SUMMARY BY CATEGORY');
    console.log('═'.repeat(72));
    for (const [category, list] of byCategory) {
        const top = list.slice(0, PER_CATEGORY_LIMIT);
        console.log(`\n${category} — top ${top.length} (of ${list.length} candidates)`);
        for (const c of top) {
            const topColors = c.colors.slice(0, 3).map(co => `${co.color_name} (${co.color_units_sold})`).join(', ');
            console.log(`  ${c.style.padEnd(14)} ${String(c.total_units_sold).padStart(6)} units · ${c.subcategory ? `[${c.subcategory}] ` : ''}${c.product_title.slice(0, 55)}`);
            console.log(`    └─ top colors: ${topColors}`);
        }
    }
    console.log('\n' + '═'.repeat(72));
    console.log(`\n✅ Done. Import ${OUTPUT_PATH} into Caspio table EMB_Top_Sellers_2026.`);
}

function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// "Port & Co Core Cotton Tee. PC54" → "Port & Co Core Cotton Tee"
// Cleaner display for the bot's product name field.
function stripStyleTrailingPN(title, style) {
    const t = String(title || '').trim();
    const s = String(style || '').trim();
    if (!t || !s) return t;
    const re = new RegExp(`\\.?\\s*${s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'i');
    return t.replace(re, '').trim();
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
