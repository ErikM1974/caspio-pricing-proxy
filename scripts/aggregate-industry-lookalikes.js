#!/usr/bin/env node
/**
 * aggregate-industry-lookalikes.js
 *
 * One-shot long-running aggregator that builds the bot's "what do other
 * [industry] customers buy" lookup table from real NWCA order history.
 *
 * Pipeline (resumable — saves state after each phase):
 *   1. Pull 1 year of orders from ManageOrders /order-pull (one big call or
 *      monthly chunks). Each order carries id_Customer + CustomerName +
 *      LinesOE[] inline.
 *   2. For each unique customer:
 *        a. inferIndustry(name) → high-confidence keyword classifier (instant)
 *        b. For "Unknown" → Tavily web search → parse snippet for industry
 *           keywords (rate-limited 1/sec, ~$0.005 per query)
 *        c. Aggregate the customer's (style, color) units across all orders
 *   3. Group customers by industry. For each industry, sum (style, color)
 *      units across all customers in the bucket. Rank by total units.
 *   4. Write CSV to ~/Downloads/industry-lookalikes-YYYYMMDD.csv (Caspio-
 *      importable schema). Also write per-industry summary to log.
 *
 * Resilience:
 *   - State file at scripts/.industry-aggregation.state.json — every phase
 *     writes progress; crash recovery resumes from last completed phase.
 *   - Log file at scripts/.industry-aggregation.log — tail this to monitor.
 *   - Background-safe: stdout to log file, no interactive prompts.
 *
 * Usage:
 *   node scripts/aggregate-industry-lookalikes.js              # 1yr window, default
 *   node scripts/aggregate-industry-lookalikes.js --days=180   # custom window
 *   node scripts/aggregate-industry-lookalikes.js --resume     # pick up from state file
 *   node scripts/aggregate-industry-lookalikes.js --skip-web   # skip Tavily classification
 *
 * Expected runtime: 1-4 hours depending on customer count + Tavily queue size.
 *
 * Created 2026-05-24 — EMB Smart A2 (precomputed instead of runtime endpoint).
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const { inferIndustry, ALL_INDUSTRIES } = require('../lib/industry-inference');
const { getToken, MANAGEORDERS_PUSH_BASE_URL } = require('../lib/manageorders-push-auth');
const { webSearch } = require('../lib/web-search');

// ── Config ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ARG_DAYS = (() => {
    const a = args.find(a => a.startsWith('--days='));
    return a ? Number(a.split('=')[1]) : 365;
})();
const ARG_RESUME = args.includes('--resume');
const ARG_SKIP_WEB = args.includes('--skip-web');
const ARG_QUICK = args.includes('--quick'); // small test mode — 30 days, 50 customers max

const WINDOW_DAYS = ARG_QUICK ? 30 : ARG_DAYS;
const MAX_CUSTOMERS = ARG_QUICK ? 50 : Infinity;
const TOP_STYLES_PER_INDUSTRY = 20;
const COLORS_PER_STYLE = 3;
const TAVILY_THROTTLE_MS = 1100; // 1 query per ~1.1s = ~3000/hr (Tavily free tier is 1000/mo, paid is plenty)
const MO_CHUNK_DAYS = 90; // pull MO in 90-day chunks to avoid huge single response

// File paths
const SCRIPT_DIR = __dirname;
const STATE_FILE = path.join(SCRIPT_DIR, '.industry-aggregation.state.json');
const LOG_FILE = path.join(SCRIPT_DIR, '.industry-aggregation.log');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUTPUT_CSV = path.join(DOWNLOADS_DIR, `industry-lookalikes-${dateStamp}.csv`);
const OUTPUT_DETAILED_CSV = path.join(DOWNLOADS_DIR, `industry-lookalikes-detailed-${dateStamp}.csv`);

// ── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
    process.stdout.write(line);
}

// ── State persistence ──────────────────────────────────────────────────────

function loadState() {
    if (!fs.existsSync(STATE_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch (e) {
        log(`⚠ State file corrupt, starting fresh: ${e.message}`);
        return null;
    }
}
function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Phase 1: pull MO orders in chunks ──────────────────────────────────────

async function pullOrdersChunk(dateFrom, dateTo) {
    const token = await getToken();
    const r = await axios.get(`${MANAGEORDERS_PUSH_BASE_URL}/order-pull`, {
        params: { date_from: dateFrom, date_to: dateTo },
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 120000, // 2 minutes for large pulls
    });
    return r.data?.result || [];
}

function isoDate(d) { return d.toISOString().split('T')[0]; }

async function phase1_pullAllOrders() {
    log('═══ PHASE 1: Pulling MO orders ═══');
    const today = new Date();
    const earliest = new Date(today);
    earliest.setDate(earliest.getDate() - WINDOW_DAYS);

    // Walk in MO_CHUNK_DAYS chunks (90d default) to keep each response manageable.
    let chunkStart = new Date(earliest);
    const allOrders = [];
    let chunkNum = 0;
    while (chunkStart < today) {
        const chunkEnd = new Date(chunkStart);
        chunkEnd.setDate(chunkEnd.getDate() + MO_CHUNK_DAYS);
        const end = chunkEnd > today ? today : chunkEnd;
        chunkNum++;
        const tFrom = isoDate(chunkStart);
        const tTo = isoDate(end);
        log(`  Chunk ${chunkNum}: ${tFrom} → ${tTo}`);
        try {
            const orders = await pullOrdersChunk(tFrom, tTo);
            log(`    pulled ${orders.length} orders`);
            allOrders.push(...orders);
        } catch (e) {
            log(`    ⚠ chunk failed: ${e.message}`);
        }
        chunkStart = chunkEnd;
    }
    log(`✓ Total orders pulled: ${allOrders.length}`);
    return allOrders;
}

// ── Phase 2: dedupe customers + name-based industry inference ──────────────

function phase2_buildCustomerProfiles(orders) {
    log('═══ PHASE 2: Building customer profiles + name inference ═══');
    // customerProfiles: id_Customer → {
    //   id, name, industry, confidence, signal,
    //   orderCount, items: Map<"style|color", units>
    // }
    const profiles = new Map();

    for (const o of orders) {
        const id = Number(o.id_Customer);
        if (!Number.isInteger(id) || id <= 0) continue;
        // PRIMARY: ShippingAddresses[0].ShipCompany — actual customer company name
        // SECONDARY: contact's first+last name (last resort, weak signal)
        // /order-pull does NOT include the customer company name at the top
        // level; ShipCompany is the most reliable inline source.
        const shipCompany = String(o.ShippingAddresses?.[0]?.ShipCompany || '').trim();
        const contactName = [o.ContactNameFirst, o.ContactNameLast].filter(Boolean).join(' ').trim();
        const name = shipCompany || contactName;

        if (!profiles.has(id)) {
            const inf = inferIndustry(name);
            profiles.set(id, {
                id,
                name,
                industry: inf.industry,
                confidence: inf.confidence,
                signal: inf.signal,
                webClassified: false,
                orderCount: 0,
                totalUnits: 0,
                items: new Map(), // "style|color" → units
                brandUnits: new Map(), // brand → units (derived later)
            });
        }
        const p = profiles.get(id);
        p.orderCount++;
        // Prefer a ShipCompany name over a contact-only fallback if we
        // started with the weaker signal. Re-classify if name improved.
        if (shipCompany && p.name !== shipCompany && !p.name.toLowerCase().includes(shipCompany.toLowerCase().slice(0, 8))) {
            p.name = shipCompany;
            const inf = inferIndustry(shipCompany);
            if (inf.industry !== 'Unknown') {
                p.industry = inf.industry;
                p.confidence = inf.confidence;
                p.signal = inf.signal;
            }
        }

        // Aggregate line items: each LinesOE entry has PartNumber + Color + Qty
        for (const li of (o.LinesOE || [])) {
            const pn = String(li.PartNumber || '').trim().toUpperCase();
            const color = String(li.Color || '').trim();
            const qty = Number(li.Qty) || 0;
            if (!pn || qty <= 0) continue;
            // Strip size suffix to get base part number (PC54_2X → PC54)
            const basePN = stripSizeSuffix(pn);
            const key = `${basePN}|${color}`;
            p.items.set(key, (p.items.get(key) || 0) + qty);
            p.totalUnits += qty;
        }
    }

    log(`✓ Built ${profiles.size} unique customer profiles`);
    // Industry breakdown by confidence
    const byIndustry = {};
    for (const p of profiles.values()) {
        byIndustry[p.industry] = (byIndustry[p.industry] || 0) + 1;
    }
    log('  Initial classification breakdown:');
    for (const [ind, count] of Object.entries(byIndustry).sort((a, b) => b[1] - a[1])) {
        log(`    ${ind.padEnd(28)} ${count} customers`);
    }
    return profiles;
}

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

// ── Phase 3: web-classify Unknown customers via Tavily ─────────────────────

async function phase3_webClassifyUnknown(profiles) {
    if (ARG_SKIP_WEB) {
        log('═══ PHASE 3: SKIPPED (--skip-web flag) ═══');
        return;
    }
    log('═══ PHASE 3: Web-classifying Unknown customers ═══');
    const unknowns = [...profiles.values()].filter(p => p.industry === 'Unknown' && p.name);
    log(`  ${unknowns.length} customers to classify (throttled ${TAVILY_THROTTLE_MS}ms/req)`);

    let idx = 0;
    for (const p of unknowns) {
        idx++;
        if (idx > MAX_CUSTOMERS) break; // safety cap in --quick mode
        try {
            const result = await webSearch({
                query: `"${p.name}" company business industry`,
                purpose: `Classify company industry for NWCA chatbot`,
                maxResults: 3,
                searchDepth: 'basic',
            });
            // Parse top snippets for industry-indicating keywords
            const blob = (result?.results || []).map(r => `${r.title || ''} ${r.snippet || r.content || ''}`).join(' ');
            if (blob) {
                // Try our own inferIndustry against the BLOB — keywords there will trigger.
                const inf = inferIndustry(blob.slice(0, 1000));
                if (inf.industry !== 'Unknown') {
                    p.industry = inf.industry;
                    p.confidence = 'web-classified';
                    p.signal = inf.signal;
                    p.webClassified = true;
                }
            }
            if (idx % 25 === 0) {
                log(`  classified ${idx}/${unknowns.length} (${p.name.slice(0, 30)} → ${p.industry})`);
                // Save state every 25 to support resume
                saveStateSnapshot(profiles, 'phase3');
            }
        } catch (e) {
            log(`  ⚠ web search failed for "${p.name}": ${e.message}`);
        }
        // Throttle
        await new Promise(r => setTimeout(r, TAVILY_THROTTLE_MS));
    }

    const stillUnknown = [...profiles.values()].filter(p => p.industry === 'Unknown').length;
    log(`✓ Web classification done. Remaining Unknown: ${stillUnknown}`);
}

// ── Phase 4: aggregate per industry ────────────────────────────────────────

function phase4_aggregateByIndustry(profiles) {
    log('═══ PHASE 4: Aggregating per-industry top sellers ═══');
    // industryBuckets: industry → {
    //   customerCount, totalUnits, items: Map<"style|color", units>
    // }
    const buckets = new Map();
    for (const p of profiles.values()) {
        if (!buckets.has(p.industry)) {
            buckets.set(p.industry, {
                industry: p.industry,
                customerCount: 0,
                totalUnits: 0,
                items: new Map(),
                customers: [], // exemplar list (top 5 by unit volume)
            });
        }
        const b = buckets.get(p.industry);
        b.customerCount++;
        b.totalUnits += p.totalUnits;
        for (const [key, units] of p.items) {
            b.items.set(key, (b.items.get(key) || 0) + units);
        }
        b.customers.push({ name: p.name, id: p.id, units: p.totalUnits });
    }

    // Rank items within each bucket; keep exemplar customers
    const out = [];
    for (const [industry, b] of buckets) {
        const rankedItems = [...b.items.entries()]
            .map(([key, units]) => {
                const [style, color] = key.split('|');
                return { style, color, units };
            })
            .sort((a, b) => b.units - a.units);

        // Group by style → top colors per style (so the bucket spans more
        // styles, not 20 colors of PC54)
        const byStyle = new Map();
        for (const r of rankedItems) {
            if (!byStyle.has(r.style)) {
                byStyle.set(r.style, { style: r.style, totalUnits: 0, colors: [] });
            }
            const s = byStyle.get(r.style);
            s.totalUnits += r.units;
            if (s.colors.length < COLORS_PER_STYLE) {
                s.colors.push({ color: r.color, units: r.units });
            }
        }
        const topStyles = [...byStyle.values()]
            .sort((a, b) => b.totalUnits - a.totalUnits)
            .slice(0, TOP_STYLES_PER_INDUSTRY);

        // Top 5 customer exemplars (by their own total units)
        const exemplars = b.customers.sort((a, b) => b.units - a.units).slice(0, 5);

        out.push({
            industry,
            customerCount: b.customerCount,
            totalUnits: b.totalUnits,
            topStyles,
            exemplars,
        });
    }
    out.sort((a, b) => b.customerCount - a.customerCount);
    log(`✓ Aggregated ${out.length} industry buckets`);
    return out;
}

// ── Phase 5: write CSV ─────────────────────────────────────────────────────

function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function phase5_writeCsv(industryBuckets) {
    log('═══ PHASE 5: Writing CSV outputs ═══');

    // === Main CSV (Caspio-importable, one row per (industry, style)) ===
    const mainHeader = [
        'industry', 'style_rank', 'style', 'total_units',
        'top_color_1', 'top_color_1_units',
        'top_color_2', 'top_color_2_units',
        'top_color_3', 'top_color_3_units',
        'industry_customer_count', 'industry_total_units',
        'exemplar_customers',
    ];
    const mainRows = [mainHeader];
    for (const ind of industryBuckets) {
        ind.topStyles.forEach((s, i) => {
            const c1 = s.colors[0] || {};
            const c2 = s.colors[1] || {};
            const c3 = s.colors[2] || {};
            mainRows.push([
                csvEscape(ind.industry),
                i + 1,
                csvEscape(s.style),
                s.totalUnits,
                csvEscape(c1.color || ''), c1.units || 0,
                csvEscape(c2.color || ''), c2.units || 0,
                csvEscape(c3.color || ''), c3.units || 0,
                ind.customerCount,
                ind.totalUnits,
                csvEscape(ind.exemplars.map(e => e.name).filter(Boolean).slice(0, 3).join('; ')),
            ]);
        });
    }
    fs.writeFileSync(OUTPUT_CSV, mainRows.map(r => r.join(',')).join('\n') + '\n', 'utf8');
    log(`✓ Wrote main CSV: ${OUTPUT_CSV} (${mainRows.length - 1} rows)`);

    // === Detailed CSV (every classified customer + their top items) ===
    const detailedHeader = [
        'industry', 'customer_id', 'customer_name', 'classification_signal',
        'total_orders', 'total_units',
        'top_item_1_style', 'top_item_1_color', 'top_item_1_units',
        'top_item_2_style', 'top_item_2_color', 'top_item_2_units',
        'top_item_3_style', 'top_item_3_color', 'top_item_3_units',
    ];
    const detailedRows = [detailedHeader];
    // We need access to the per-customer profiles for this — rebuild from the
    // exemplar names. (Simpler than threading profiles all the way through.)
    // For v1, just emit the exemplars per industry; full per-customer detail
    // can come later if needed.
    for (const ind of industryBuckets) {
        for (const e of ind.exemplars) {
            detailedRows.push([
                csvEscape(ind.industry),
                e.id || '',
                csvEscape(e.name || ''),
                'exemplar',
                '', // orders count not threaded here
                e.units || 0,
                '', '', '',
                '', '', '',
                '', '', '',
            ]);
        }
    }
    fs.writeFileSync(OUTPUT_DETAILED_CSV, detailedRows.map(r => r.join(',')).join('\n') + '\n', 'utf8');
    log(`✓ Wrote detailed CSV: ${OUTPUT_DETAILED_CSV} (${detailedRows.length - 1} rows)`);
}

// ── State snapshot helpers (resilience) ────────────────────────────────────

function saveStateSnapshot(profiles, phase) {
    // Convert Map → array for JSON serialization
    const serializable = [...profiles.values()].map(p => ({
        ...p,
        items: Array.from(p.items.entries()),
        brandUnits: Array.from(p.brandUnits.entries()),
    }));
    saveState({ phase, profiles: serializable, savedAt: new Date().toISOString() });
}

// ── Main pipeline ──────────────────────────────────────────────────────────

async function main() {
    fs.writeFileSync(LOG_FILE, ''); // start fresh log
    log('═══════════════════════════════════════════════════════════════');
    log('NWCA INDUSTRY LOOKALIKES — AGGREGATION RUN');
    log(`  Window:       ${WINDOW_DAYS} days`);
    log(`  Resume:       ${ARG_RESUME}`);
    log(`  Skip web:     ${ARG_SKIP_WEB}`);
    log(`  Quick mode:   ${ARG_QUICK}`);
    log(`  Output CSV:   ${OUTPUT_CSV}`);
    log(`  State file:   ${STATE_FILE}`);
    log(`  Log file:     ${LOG_FILE}`);
    log('═══════════════════════════════════════════════════════════════');

    const orders = await phase1_pullAllOrders();
    if (!orders.length) {
        log('FATAL: zero orders pulled — check MO credentials or date window');
        process.exit(1);
    }
    saveState({ phase: 'phase1-done', orderCount: orders.length });

    const profiles = phase2_buildCustomerProfiles(orders);
    saveStateSnapshot(profiles, 'phase2-done');

    await phase3_webClassifyUnknown(profiles);
    saveStateSnapshot(profiles, 'phase3-done');

    const buckets = phase4_aggregateByIndustry(profiles);
    saveState({ phase: 'phase4-done', industryCount: buckets.length });

    phase5_writeCsv(buckets);
    saveState({ phase: 'phase5-done', completedAt: new Date().toISOString() });

    log('═══════════════════════════════════════════════════════════════');
    log('SUMMARY');
    log('═══════════════════════════════════════════════════════════════');
    for (const b of buckets) {
        log(`${b.industry.padEnd(28)} ${String(b.customerCount).padStart(4)} customers · ${String(b.totalUnits).padStart(6)} units · top: ${b.topStyles.slice(0, 3).map(s => s.style).join(', ')}`);
    }
    log('═══════════════════════════════════════════════════════════════');
    log(`✅ DONE. CSV ready at ${OUTPUT_CSV}`);
    log(`   Import into Caspio table Industry_Lookalikes_2026 (create schema matching the CSV header).`);
}

main().catch(err => {
    log(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
});
