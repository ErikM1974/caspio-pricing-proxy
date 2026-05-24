#!/usr/bin/env node
/**
 * aggregate-industry-lookalikes-v2.js
 *
 * RICHER DATA SOURCE: Caspio ManageOrders_Orders + ManageOrders_LineItems
 * (the FileMaker sync at /tables/...) instead of /order-pull (PUSH API).
 *
 * V1 (aggregate-industry-lookalikes.js) used /order-pull which only returns
 * orders pushed through this app's PUSH API → only 183 orders/yr (way too
 * sparse). V2 uses the Caspio MO tables which have ~7.5x more data and the
 * real customer company names directly in CustomerName + ParentCompany.
 *
 * Pipeline:
 *   1. Pull all ManageOrders_Orders rows where date_Ordered >= today-365d
 *      (last year). Page through 1000 at a time. Output: ~1373 orders.
 *   2. Pull all ManageOrders_LineItems for those id_Order values. Output:
 *      ~3000 line items.
 *   3. Build customer profiles: dedupe by id_Customer, attach name from
 *      CustomerName / ParentCompany, attach line items.
 *   4. Classify each customer via inferIndustry(name) → Tavily fallback
 *      for Unknown.
 *   5. Aggregate per-industry top (style, color) units.
 *   6. Write CSV to ~/Downloads.
 *
 * Usage:
 *   node scripts/aggregate-industry-lookalikes-v2.js              # 1yr window
 *   node scripts/aggregate-industry-lookalikes-v2.js --days=180
 *   node scripts/aggregate-industry-lookalikes-v2.js --skip-web   # no Tavily
 *
 * Created 2026-05-24 — EMB Smart A2 v2 (Caspio data source).
 */

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const config = require('../src/config');

const { getCaspioAccessToken } = require('../src/utils/caspio');
const { inferIndustry } = require('../lib/industry-inference');
const { webSearch } = require('../lib/web-search');

// === SanMar style cache — authoritative "is this a real SanMar style?" lookup
// Built by scripts/build-sanmar-style-cache.js — walks the bulk table once
// and writes scripts/.sanmar-styles.cache.json (array of ~10K unique styles).
const SANMAR_CACHE_PATH = path.join(__dirname, '.sanmar-styles.cache.json');
let SANMAR_STYLES = null; // populated by loadSanmarStyles()

function loadSanmarStyles() {
    if (SANMAR_STYLES) return SANMAR_STYLES;
    if (!fs.existsSync(SANMAR_CACHE_PATH)) {
        throw new Error(
            `SanMar style cache not found at ${SANMAR_CACHE_PATH}. ` +
            `Run: node scripts/build-sanmar-style-cache.js (one-time setup, ~1-2 min).`
        );
    }
    const arr = JSON.parse(fs.readFileSync(SANMAR_CACHE_PATH, 'utf8'));
    SANMAR_STYLES = new Set(arr.map(s => String(s).toUpperCase()));
    return SANMAR_STYLES;
}

// ── Config ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ARG_DAYS = (() => {
    const a = args.find(a => a.startsWith('--days='));
    return a ? Number(a.split('=')[1]) : 3650; // default = 10 years (effectively "all")
})();
const ARG_SKIP_WEB = args.includes('--skip-web');
const ARG_ALL_DATES = args.includes('--all') || ARG_DAYS >= 3650;

const TOP_STYLES_PER_INDUSTRY = 25;
const COLORS_PER_STYLE = 3;
const TAVILY_THROTTLE_MS = 1100;
const PAGE_SIZE = 1000; // Caspio max

// File paths
const SCRIPT_DIR = __dirname;
const LOG_FILE = path.join(SCRIPT_DIR, '.industry-aggregation-v2.log');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUTPUT_CSV = path.join(DOWNLOADS_DIR, `industry-lookalikes-v2-${dateStamp}.csv`);
const OUTPUT_DETAILED_CSV = path.join(DOWNLOADS_DIR, `industry-lookalikes-v2-detailed-${dateStamp}.csv`);

function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
    process.stdout.write(line);
}

// ── Raw Caspio paginated fetch (BOUNDED — exits at empty page) ─────────────

async function rawGet(resourcePath, params = {}) {
    const token = await getCaspioAccessToken();
    return (await axios.get(`${config.caspio.apiBaseUrl}${resourcePath}`, {
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000,
    })).data;
}

async function fetchAll(table, where, select) {
    const all = [];
    let page = 1;
    while (true) {
        const params = {
            'q.where': where,
            'q.pageSize': PAGE_SIZE,
            'q.pageNumber': page,
        };
        if (select) params['q.select'] = select;
        const r = await rawGet(`/tables/${table}/records`, params);
        const got = r.Result || [];
        all.push(...got);
        if (got.length < PAGE_SIZE) break;
        page++;
        if (page % 5 === 0) log(`  [${table}] page ${page}, running total ${all.length}`);
        if (page > 200) {
            log(`  [${table}] hit bailout at 200 pages = 200K rows`);
            break;
        }
    }
    return all;
}

// ── Phase 1: pull MO orders from Caspio ────────────────────────────────────

async function phase1_pullOrders(cutoffDateISO) {
    log('═══ PHASE 1: Pulling MO orders from Caspio ManageOrders_Orders ═══');
    // When ARG_ALL_DATES is true (or --days >= 3650), skip date filter entirely.
    const where = ARG_ALL_DATES
        ? 'id_Order IS NOT NULL'
        : `date_Ordered>='${cutoffDateISO}'`;
    log(`  Filter: ${where}`);
    const orders = await fetchAll(
        'ManageOrders_Orders',
        where,
        'id_Order,id_Customer,CustomerName,ParentCompany,date_Ordered,cur_SubTotal,TotalProductQuantity'
    );
    log(`✓ Pulled ${orders.length} orders`);
    return orders;
}

// ── Phase 2: pull line items for those orders ──────────────────────────────

async function phase2_pullLineItems(orderIds) {
    log('═══ PHASE 2: Pulling MO line items from Caspio ManageOrders_LineItems ═══');
    // Caspio q.where doesn't easily handle IN() with thousands of values, so we
    // pull ALL line items and filter in-memory. With ~4663 rows total this is
    // trivial (one fetchAll call, ~5 pages).
    const all = await fetchAll(
        'ManageOrders_LineItems',
        'id_Order IS NOT NULL',
        'id_Order,PartNumber,PartColor,PartDescription,LineQuantity,Size01,Size02,Size03,Size04,Size05,Size06'
    );
    log(`✓ Pulled ${all.length} total line items`);
    // Filter to only the orders in our window
    const wanted = new Set(orderIds);
    const filtered = all.filter(li => wanted.has(li.id_Order));
    log(`✓ ${filtered.length} line items match the ${orderIds.length} in-window orders`);
    return filtered;
}

// ── Size suffix stripping ──────────────────────────────────────────────────

const SIZE_SUFFIX_RE = /_(?:XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|2X|3X|4X|5X|6X|OSFA|S\/M|M\/L|L\/XL|X\/L|XLT|XXLT|2XLT|3XLT)$/i;
function stripSizeSuffix(pn) {
    let p = String(pn || '').trim();
    while (SIZE_SUFFIX_RE.test(p)) {
        const next = p.replace(SIZE_SUFFIX_RE, '');
        if (next === p || !next) break;
        p = next;
    }
    return p.toUpperCase();
}

// Sum quantities — if LineQuantity is populated use it, else sum Size01..06
function lineUnits(li) {
    const lq = Number(li.LineQuantity) || 0;
    if (lq > 0) return lq;
    let sum = 0;
    for (let i = 1; i <= 6; i++) sum += Number(li[`Size0${i}`]) || 0;
    return sum;
}

// ── Authoritative SanMar style check ───────────────────────────────────────
// Returns true if the PN is a real SanMar catalog style (in Sanmar_Bulk).
// Replaces the previous blacklist-based isServiceCode() with a positive
// cross-check — anything not in SanMar's catalog is excluded automatically.
function isSanmarStyle(pn) {
    if (!pn) return false;
    const styles = loadSanmarStyles();
    return styles.has(String(pn).toUpperCase().trim());
}

// ── Phase 3: build customer profiles ───────────────────────────────────────

function phase3_buildCustomerProfiles(orders, lineItems) {
    log('═══ PHASE 3: Building customer profiles ═══');
    // First, group line items by id_Order
    const liByOrder = new Map();
    for (const li of lineItems) {
        if (!liByOrder.has(li.id_Order)) liByOrder.set(li.id_Order, []);
        liByOrder.get(li.id_Order).push(li);
    }

    // Then group orders by id_Customer
    const profiles = new Map();
    for (const o of orders) {
        const id = Number(o.id_Customer);
        if (!Number.isInteger(id) || id <= 0) continue;
        const name = String(o.CustomerName || o.ParentCompany || '').trim();
        if (!profiles.has(id)) {
            const inf = inferIndustry(name);
            profiles.set(id, {
                id,
                name,
                parentCompany: o.ParentCompany || '',
                industry: inf.industry,
                confidence: inf.confidence,
                signal: inf.signal,
                webClassified: false,
                orderCount: 0,
                totalUnits: 0,
                totalRevenue: 0,
                items: new Map(), // "BASE_PN|color" → units
            });
        }
        const p = profiles.get(id);
        p.orderCount++;
        p.totalRevenue += Number(o.cur_SubTotal) || 0;

        // Aggregate line items for this order — SANMAR CATALOG STYLES ONLY.
        // Cross-check against Sanmar_Bulk so we exclude ALL services, fees,
        // customer-supplied, promo items, drinkware, etc. — anything not in
        // the SanMar catalog is rejected automatically.
        const lis = liByOrder.get(o.id_Order) || [];
        for (const li of lis) {
            const pn = stripSizeSuffix(li.PartNumber);
            const color = String(li.PartColor || '').trim();
            const units = lineUnits(li);
            if (!pn || units <= 0) continue;
            if (!isSanmarStyle(pn)) continue; // ← STRICT: must be in SanMar catalog
            const key = `${pn}|${color}`;
            p.items.set(key, (p.items.get(key) || 0) + units);
            p.totalUnits += units;
        }
    }
    log(`✓ Built ${profiles.size} unique customer profiles`);

    const byIndustry = {};
    for (const p of profiles.values()) byIndustry[p.industry] = (byIndustry[p.industry] || 0) + 1;
    log('  Initial classification breakdown:');
    for (const [ind, count] of Object.entries(byIndustry).sort((a, b) => b[1] - a[1])) {
        log(`    ${ind.padEnd(28)} ${count} customers`);
    }
    return profiles;
}

// ── Phase 4: Tavily for Unknowns ───────────────────────────────────────────

async function phase4_webClassifyUnknown(profiles) {
    if (ARG_SKIP_WEB) {
        log('═══ PHASE 4: SKIPPED (--skip-web) ═══');
        return;
    }
    log('═══ PHASE 4: Web-classifying Unknown customers via Tavily ═══');
    const unknowns = [...profiles.values()].filter(p => p.industry === 'Unknown' && p.name);
    log(`  ${unknowns.length} customers to classify (throttled ${TAVILY_THROTTLE_MS}ms/req)`);

    let idx = 0, hits = 0, errs = 0;
    for (const p of unknowns) {
        idx++;
        try {
            const result = await webSearch({
                query: `"${p.name}" company business industry`,
                purpose: `Classify company industry for NWCA chatbot`,
                maxResults: 3,
                searchDepth: 'basic',
            });
            if (result?.error) {
                errs++;
                if (errs <= 3) log(`  ⚠ Tavily error for "${p.name}": ${result.error} (${result.message?.slice(0, 80)})`);
                continue;
            }
            // PRIORITY 1: Tavily's curated `answer` (a clean LLM-generated summary).
            // PRIORITY 2: scraped snippets (more noise but more coverage).
            let inf = { industry: 'Unknown' };
            if (result?.answer) {
                inf = inferIndustry(String(result.answer).slice(0, 1000));
            }
            if (inf.industry === 'Unknown' && Array.isArray(result?.results)) {
                const blob = result.results.map(r => `${r.title || ''} ${r.snippet || r.content || ''}`).join(' ');
                if (blob) inf = inferIndustry(blob.slice(0, 1500));
            }
            if (inf.industry !== 'Unknown') {
                p.industry = inf.industry;
                p.confidence = 'web-classified';
                p.signal = inf.signal;
                p.webClassified = true;
                hits++;
            }
            if (idx % 25 === 0) {
                log(`  ${idx}/${unknowns.length} classified (${hits} hits, ${errs} errs). Last: ${p.name.slice(0,30)} → ${p.industry}`);
            }
        } catch (e) {
            log(`  ⚠ web search failed for "${p.name}": ${e.message}`);
        }
        await new Promise(r => setTimeout(r, TAVILY_THROTTLE_MS));
    }
    const stillUnknown = [...profiles.values()].filter(p => p.industry === 'Unknown').length;
    log(`✓ Web classification done. ${hits} Unknowns reclassified, ${errs} errors. Remaining Unknown: ${stillUnknown}`);
}

// ── Phase 5: aggregate per industry ────────────────────────────────────────

function phase5_aggregateByIndustry(profiles) {
    log('═══ PHASE 5: Aggregating per-industry top sellers ═══');
    const buckets = new Map();
    for (const p of profiles.values()) {
        if (!buckets.has(p.industry)) {
            buckets.set(p.industry, {
                industry: p.industry,
                customerCount: 0,
                totalUnits: 0,
                totalRevenue: 0,
                items: new Map(),
                customers: [],
            });
        }
        const b = buckets.get(p.industry);
        b.customerCount++;
        b.totalUnits += p.totalUnits;
        b.totalRevenue += p.totalRevenue;
        for (const [key, units] of p.items) {
            b.items.set(key, (b.items.get(key) || 0) + units);
        }
        b.customers.push({
            name: p.name,
            id: p.id,
            units: p.totalUnits,
            revenue: p.totalRevenue,
            orderCount: p.orderCount,
        });
    }

    const out = [];
    for (const [industry, b] of buckets) {
        const ranked = [...b.items.entries()]
            .map(([k, units]) => { const [style, color] = k.split('|'); return { style, color, units }; })
            .sort((a, b) => b.units - a.units);

        // Group by style → top colors
        const byStyle = new Map();
        for (const r of ranked) {
            if (!byStyle.has(r.style)) byStyle.set(r.style, { style: r.style, totalUnits: 0, colors: [] });
            const s = byStyle.get(r.style);
            s.totalUnits += r.units;
            if (s.colors.length < COLORS_PER_STYLE) s.colors.push({ color: r.color, units: r.units });
        }
        const topStyles = [...byStyle.values()].sort((a, b) => b.totalUnits - a.totalUnits)
            .slice(0, TOP_STYLES_PER_INDUSTRY);

        const exemplars = b.customers.sort((a, b) => b.units - a.units).slice(0, 10);
        out.push({
            industry,
            customerCount: b.customerCount,
            totalUnits: b.totalUnits,
            totalRevenue: b.totalRevenue,
            topStyles,
            exemplars,
        });
    }
    out.sort((a, b) => b.customerCount - a.customerCount);
    log(`✓ Aggregated ${out.length} industry buckets`);
    return out;
}

// ── Phase 6: write CSV ─────────────────────────────────────────────────────

function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function phase6_writeCsv(industryBuckets, profiles) {
    log('═══ PHASE 6: Writing CSV outputs ═══');

    const mainHeader = [
        'industry', 'style_rank', 'style', 'total_units',
        'top_color_1', 'top_color_1_units',
        'top_color_2', 'top_color_2_units',
        'top_color_3', 'top_color_3_units',
        'industry_customer_count', 'industry_total_units', 'industry_total_revenue',
        'exemplar_customers',
    ];
    const mainRows = [mainHeader];
    for (const ind of industryBuckets) {
        ind.topStyles.forEach((s, i) => {
            const c1 = s.colors[0] || {}, c2 = s.colors[1] || {}, c3 = s.colors[2] || {};
            mainRows.push([
                csvEscape(ind.industry), i + 1, csvEscape(s.style), s.totalUnits,
                csvEscape(c1.color || ''), c1.units || 0,
                csvEscape(c2.color || ''), c2.units || 0,
                csvEscape(c3.color || ''), c3.units || 0,
                ind.customerCount, ind.totalUnits, Math.round(ind.totalRevenue),
                csvEscape(ind.exemplars.map(e => e.name).filter(Boolean).slice(0, 5).join('; ')),
            ]);
        });
    }
    fs.writeFileSync(OUTPUT_CSV, mainRows.map(r => r.join(',')).join('\n') + '\n', 'utf8');
    log(`✓ Wrote main CSV: ${OUTPUT_CSV} (${mainRows.length - 1} rows)`);

    // Detailed: every customer + their top 3 items
    const detailedHeader = [
        'industry', 'customer_id', 'customer_name', 'parent_company',
        'classification_signal', 'web_classified',
        'order_count', 'total_units', 'total_revenue',
        'top_item_1_style', 'top_item_1_color', 'top_item_1_units',
        'top_item_2_style', 'top_item_2_color', 'top_item_2_units',
        'top_item_3_style', 'top_item_3_color', 'top_item_3_units',
    ];
    const detailedRows = [detailedHeader];
    for (const p of profiles.values()) {
        const topItems = [...p.items.entries()]
            .map(([k, u]) => { const [s, c] = k.split('|'); return { style: s, color: c, units: u }; })
            .sort((a, b) => b.units - a.units)
            .slice(0, 3);
        const t1 = topItems[0] || {}, t2 = topItems[1] || {}, t3 = topItems[2] || {};
        detailedRows.push([
            csvEscape(p.industry), p.id, csvEscape(p.name), csvEscape(p.parentCompany),
            csvEscape(p.signal || ''), p.webClassified ? 'yes' : 'no',
            p.orderCount, p.totalUnits, Math.round(p.totalRevenue),
            csvEscape(t1.style || ''), csvEscape(t1.color || ''), t1.units || 0,
            csvEscape(t2.style || ''), csvEscape(t2.color || ''), t2.units || 0,
            csvEscape(t3.style || ''), csvEscape(t3.color || ''), t3.units || 0,
        ]);
    }
    fs.writeFileSync(OUTPUT_DETAILED_CSV, detailedRows.map(r => r.join(',')).join('\n') + '\n', 'utf8');
    log(`✓ Wrote detailed CSV: ${OUTPUT_DETAILED_CSV} (${detailedRows.length - 1} rows)`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    fs.writeFileSync(LOG_FILE, '');
    log('═══════════════════════════════════════════════════════════════');
    log('NWCA INDUSTRY LOOKALIKES — V2 (CASPIO DATA SOURCE)');
    log(`  Window:     ${ARG_ALL_DATES ? 'ALL TIME (no date filter)' : ARG_DAYS + ' days'}`);
    log(`  Skip web:   ${ARG_SKIP_WEB}`);
    log(`  Output CSV: ${OUTPUT_CSV}`);
    log('═══════════════════════════════════════════════════════════════');

    // Load SanMar style cache at startup — fail fast if missing.
    log(`Loading SanMar style cache from ${SANMAR_CACHE_PATH}...`);
    loadSanmarStyles();
    log(`✓ ${SANMAR_STYLES.size} unique SanMar styles loaded`);

    const cutoff = new Date(Date.now() - ARG_DAYS * 24 * 3600 * 1000)
        .toISOString().slice(0, 10);

    const orders = await phase1_pullOrders(cutoff);
    if (!orders.length) {
        log('FATAL: zero orders — bad date window or Caspio issue');
        process.exit(1);
    }
    const orderIds = orders.map(o => o.id_Order);
    const lineItems = await phase2_pullLineItems(orderIds);

    const profiles = phase3_buildCustomerProfiles(orders, lineItems);
    await phase4_webClassifyUnknown(profiles);
    const buckets = phase5_aggregateByIndustry(profiles);
    phase6_writeCsv(buckets, profiles);

    log('═══════════════════════════════════════════════════════════════');
    log('SUMMARY');
    log('═══════════════════════════════════════════════════════════════');
    for (const b of buckets) {
        log(`${b.industry.padEnd(28)} ${String(b.customerCount).padStart(4)} cust · ${String(b.totalUnits).padStart(6)} units · $${String(Math.round(b.totalRevenue)).padStart(7)} · top: ${b.topStyles.slice(0, 3).map(s => s.style).join(', ')}`);
    }
    log('═══════════════════════════════════════════════════════════════');
    log(`✅ DONE. CSV at ${OUTPUT_CSV}`);
    log(`   Import into Caspio table Industry_Lookalikes_2026 (header matches schema).`);
}

main().catch(err => {
    log(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
});
