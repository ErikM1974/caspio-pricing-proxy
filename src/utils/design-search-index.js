/**
 * Design Search Index — the engine behind /api/design-search (Design Vault).
 *
 * Builds one compact in-memory index of EVERY design group across all sources:
 *   base:    Design_Lookup_2026 (~155k rows, weekly rebuild by sync-design-lookup.js)
 *   live:    Designs2026 (4h bandit sync), Digitizing_Mockups (Ruth), Finished_Photos,
 *            plus since-lookupBuiltAt overlays of Shopworks_Thumbnail_Report + ArtRequests
 * so brand-new designs/mockups appear without waiting for the weekly rebuild.
 *
 * Grouping key is the INTEGER design number. Decimal ids (35439.03) are variants
 * of the integer parent — they merge into one group and never make a second card.
 * Rows with no resolvable design number are excluded and counted in
 * counts.excludedUnnumbered (order-scoped artifacts live in Art Hub, not here).
 *
 * Wire format (positional rows keep ~39k groups under ~1 MB gzipped):
 *   row = [dn, name, company, custId, repIdx, custTypeIdx, tierIdx, maxStitch,
 *          variantCount, srcBits, imgRef, orderCount, lastOrderYYMM]
 *   dicts = { reps, custTypes, tiers } (index 0 is always '')
 *   imgRef = 'f:<caspioFileKey>' | 'b:<boxFileId>' | 'u:<absoluteUrl>' | ''
 *
 * COMPLETENESS GATE (Rule 4): a partial index is a silent wrong answer at scale,
 * so a build only replaces the served index when the base stream completed
 * (strict:true truncation surfaces), the row count clears the floor, and every
 * overlay query succeeded. A failed build keeps the previous index serving.
 */

'use strict';

const { fetchAllCaspioPages } = require('./caspio');
const { normalizeCompanyName, normalizeDesignName } = require('./design-normalize');

// ---------------------------------------------------------------------------
// Source bits (client filter chips key off these — changing a value is a
// breaking client-contract change, jest-locked)
// ---------------------------------------------------------------------------
const SRC = {
    DIGITIZED: 1,     // stitch data present (Digitized_Designs_Master lineage)
    SHOPWORKS: 2,     // order history present (ShopWorks_Designs lineage)
    THUMB: 4,         // ShopWorks production thumbnail exists
    ART: 8,           // Steve / ArtRequests artwork or mockup
    RUTH: 16,         // Digitizing_Mockups
    PHOTO: 32,        // Finished_Photos
    DESIGNS2026: 64   // ShopWorks Des table row (2022+, 4h sync)
};

const BASE_TABLE = '/tables/Design_Lookup_2026/records';
const BASE_SELECT = [
    'Design_Number', 'Design_Name', 'Company', 'Customer_ID',
    'Stitch_Count', 'Stitch_Tier', 'Sales_Rep', 'Customer_Type',
    'Thumbnail_URL', 'DST_Preview_URL', 'Artwork_URL', 'Mockup_URL',
    'Last_Order_Date', 'Order_Count', 'Date_Updated'
].join(',');

const TTL_MS = 24 * 60 * 60 * 1000;
// Base floor: a build seeing dramatically fewer rows than the table really has
// is one that hit truncation or a filter we failed to detect, and must not
// replace a good index.
//
// ⚠️ Calibrate this against the TRUE dataset size, not whatever the table
// happens to contain. It was originally 100,000, set from a live count of
// 146,526 — but that number was ~4x duplication from a broken sync, not real
// data. When the table was rebuilt correctly to 38,785 rows on 2026-08-05, the
// gate refused every build ("below the completeness floor 100000") and took the
// Vault down until this was lowered. A floor tuned to corrupt data rejects the
// fix for that corruption.
//
// 25,000 still catches a catastrophic truncation (the real risk: a maxPages cap
// silently returning one page) while leaving room for the dataset to shrink
// legitimately. The relative check below — 90% of the previous successful
// build — is what guards against gradual drift.
const ABSOLUTE_ROW_FLOOR = 25000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for jest)
// ---------------------------------------------------------------------------

/** Integer design number for grouping, or null when unresolvable. */
function canonicalKey(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0 || n > 99999999) return null;
    return n;
}

/** Compact image reference. Mirrors the unified table's length>10 URL guard. */
function encodeImgRef(url) {
    if (!url || typeof url !== 'string' || url.length <= 10) return '';
    const file = url.match(/\/api\/files\/([A-Za-z0-9_-]{8,})/);
    if (file) return 'f:' + file[1];
    const box = url.match(/\/api\/box\/thumbnail\/(\d+)/);
    if (box) return 'b:' + box[1];
    return 'u:' + url;
}

/**
 * Image priority chain — production thumbnail first, stitch-render last.
 * Order is a client-visible contract (jest-locked).
 */
function pickImage(g) {
    const chain = [g.thumbnailUrl, g.ruthUrl, g.mockupUrl, g.artworkUrl, g.photoUrl, g.dstPreviewUrl];
    for (const url of chain) {
        const ref = encodeImgRef(url);
        if (ref) return ref;
    }
    return '';
}

function newGroup(dn) {
    return {
        dn,
        name: '',
        company: '',
        customerId: 0,
        salesRep: '',
        customerType: '',
        maxStitch: 0,
        tier: '',
        variantCount: 0,
        srcBits: 0,
        orderCount: 0,
        lastOrder: null,
        // image candidates (encoded lazily by pickImage)
        thumbnailUrl: '', ruthUrl: '', mockupUrl: '', artworkUrl: '', photoUrl: '', dstPreviewUrl: ''
    };
}

/** Fold one Design_Lookup_2026 row into the groups map. */
function foldBaseRow(groups, rec) {
    const dn = canonicalKey(rec.Design_Number);
    if (dn === null) return false;
    let g = groups.get(dn);
    if (!g) { g = newGroup(dn); groups.set(dn, g); }

    g.variantCount++;
    if (!g.name && rec.Design_Name) g.name = String(rec.Design_Name);
    if (!g.company && rec.Company) g.company = String(rec.Company);
    if (!g.customerId && rec.Customer_ID != null && rec.Customer_ID !== '') {
        g.customerId = canonicalKey(rec.Customer_ID) || 0;
    }
    if (!g.salesRep && rec.Sales_Rep) g.salesRep = String(rec.Sales_Rep);
    if (!g.customerType && rec.Customer_Type) g.customerType = String(rec.Customer_Type);

    const stitch = parseInt(rec.Stitch_Count, 10) || 0;
    if (stitch > g.maxStitch) {
        g.maxStitch = stitch;
        g.tier = rec.Stitch_Tier || g.tier;
    }
    if (!g.tier && rec.Stitch_Tier) g.tier = String(rec.Stitch_Tier);
    if (stitch > 0) g.srcBits |= SRC.DIGITIZED;

    const orders = parseInt(rec.Order_Count, 10) || 0;
    if (orders > g.orderCount) g.orderCount = orders;
    if (rec.Last_Order_Date && (!g.lastOrder || String(rec.Last_Order_Date) > String(g.lastOrder))) {
        g.lastOrder = rec.Last_Order_Date;
    }
    if (orders > 0 || rec.Last_Order_Date) g.srcBits |= SRC.SHOPWORKS;

    if (!g.thumbnailUrl && rec.Thumbnail_URL) g.thumbnailUrl = String(rec.Thumbnail_URL);
    if (g.thumbnailUrl && g.thumbnailUrl.length > 10) g.srcBits |= SRC.THUMB;
    if (!g.dstPreviewUrl && rec.DST_Preview_URL) g.dstPreviewUrl = String(rec.DST_Preview_URL);
    if (!g.artworkUrl && rec.Artwork_URL) g.artworkUrl = String(rec.Artwork_URL);
    if (!g.mockupUrl && rec.Mockup_URL) g.mockupUrl = String(rec.Mockup_URL);
    if ((g.artworkUrl && g.artworkUrl.length > 10) || (g.mockupUrl && g.mockupUrl.length > 10)) {
        g.srcBits |= SRC.ART;
    }
    return true;
}

/**
 * Fold one live-source row into the groups map. `source` picks the field
 * mapping. Existing group fields always win (the unified table carries the
 * enrichment work); live rows only fill gaps, add their source bit, and
 * contribute image candidates for slots still empty.
 * Returns true if folded, false if the row has no resolvable design number.
 */
function applyOverlayRow(groups, source, rec) {
    let dn, fill;
    switch (source) {
        case 'designs2026':
            dn = canonicalKey(rec.ID_Design);
            fill = { name: rec.DesignName, customerId: rec.ID_Customer, bit: SRC.DESIGNS2026 };
            break;
        case 'thumb':
            dn = canonicalKey(rec.Thumb_DesLocid_Design);
            fill = { name: rec.Thumb_DesLoc_DesDesignName, bit: SRC.THUMB };
            break;
        case 'art':
            dn = canonicalKey(rec.Design_Num_SW) !== null ? canonicalKey(rec.Design_Num_SW) : canonicalKey(rec.ID_Design);
            fill = {
                name: null, company: rec.CompanyName,
                customerId: rec.Shopwork_customer_number || rec.id_customer,
                bit: SRC.ART
            };
            break;
        case 'ruth':
            dn = canonicalKey(rec.Design_Number);
            fill = { company: rec.Company_Name, customerId: rec.Id_Customer, bit: SRC.RUTH };
            break;
        case 'photo':
            dn = canonicalKey(rec.Design_Number);
            fill = { name: rec.Design_Name, company: rec.Company_Name, customerId: rec.id_Customer, bit: SRC.PHOTO };
            break;
        default:
            throw new Error(`applyOverlayRow: unknown source '${source}'`);
    }
    if (dn === null) return false;

    let g = groups.get(dn);
    if (!g) { g = newGroup(dn); g.variantCount = 1; groups.set(dn, g); }
    g.srcBits |= fill.bit;

    if (!g.name && fill.name) g.name = String(fill.name);
    if (!g.company && fill.company) g.company = String(fill.company);
    if (!g.customerId && fill.customerId != null && fill.customerId !== '') {
        g.customerId = canonicalKey(fill.customerId) || 0;
    }

    if (source === 'thumb' && !g.thumbnailUrl) {
        // Consumer rule everywhere else in the codebase: ExternalKey ? Caspio file : FileUrl
        g.thumbnailUrl = rec.ExternalKey ? `/api/files/${rec.ExternalKey}` : String(rec.FileUrl || '');
    }
    if (source === 'art' && !g.artworkUrl) {
        g.artworkUrl = String(rec.Box_File_Mockup || rec.BoxFileLink || rec.Company_Mockup || '');
    }
    if (source === 'ruth' && !g.ruthUrl) g.ruthUrl = String(rec.Box_Mockup_1 || '');
    if (source === 'photo' && !g.photoUrl) g.photoUrl = String(rec.Image_URL || '');
    return true;
}

/** Last_Order_Date → YYMM int (e.g. 2506 for June 2025), 0 when absent/invalid. */
function toYYMM(value) {
    if (!value) return 0;
    const d = new Date(value);
    if (isNaN(d.getTime())) return 0;
    return (d.getFullYear() % 100) * 100 + (d.getMonth() + 1);
}

/** Dictionary encoder: index 0 is always '' so empty fields cost one digit. */
function makeDict() {
    const values = [''];
    const map = new Map([['', 0]]);
    return {
        idx(v) {
            const s = v ? String(v) : '';
            if (map.has(s)) return map.get(s);
            const i = values.length;
            values.push(s);
            map.set(s, i);
            return i;
        },
        values
    };
}

/** One group → one positional wire row. Position order is the client contract. */
function encodeRow(g, dicts) {
    return [
        g.dn,
        g.name || '',
        g.company || '',
        g.customerId || 0,
        dicts.reps.idx(g.salesRep),
        dicts.custTypes.idx(g.customerType),
        dicts.tiers.idx(g.tier),
        g.maxStitch || 0,
        g.variantCount || 0,
        g.srcBits || 0,
        pickImage(g),
        g.orderCount || 0,
        toYYMM(g.lastOrder)
    ];
}

/**
 * Exact-normalized company+name clusters across DIFFERENT design numbers —
 * the "possible duplicate" hint. Detection only; merging is a human decision.
 * Names under 4 normalized chars are too generic to cluster ("logo", "fb").
 */
function findDupClusters(groups) {
    const byKey = new Map();
    for (const g of groups.values()) {
        const company = normalizeCompanyName(g.company);
        const name = normalizeDesignName(g.name);
        if (!company || name.length < 4) continue;
        const key = company + '|' + name;
        let list = byKey.get(key);
        if (!list) { list = []; byKey.set(key, list); }
        list.push(g.dn);
    }
    const clusters = [];
    for (const list of byKey.values()) {
        if (list.length >= 2) clusters.push(list.sort((a, b) => a - b));
    }
    clusters.sort((a, b) => a[0] - b[0]);
    return clusters;
}

// ---------------------------------------------------------------------------
// Fetch layer
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' one day before the given epoch — the overlay margin. */
function sinceLiteral(epochMs) {
    const d = new Date(epochMs - 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
}

async function fetchBase(groups, counts) {
    let maxDateUpdated = 0;
    let baseRows = 0;
    await fetchAllCaspioPages(BASE_TABLE, {
        'q.where': "Is_Active='true'",
        'q.select': BASE_SELECT,
        'q.orderBy': 'PK_ID',
        'q.limit': 1000
    }, {
        maxPages: 200,
        totalTimeout: 300000,
        strict: true,
        discardResults: true,
        pageCallback: (rows) => {
            for (const rec of rows) {
                baseRows++;
                if (!foldBaseRow(groups, rec)) counts.excludedUnnumbered++;
                if (rec.Date_Updated) {
                    const t = new Date(rec.Date_Updated).getTime();
                    if (t > maxDateUpdated) maxDateUpdated = t;
                }
            }
        }
    });
    counts.baseRows = baseRows;
    return maxDateUpdated || Date.now();
}

// Sequential on purpose: parallel Caspio reads trip the per-second burst limit
// long before the monthly meter matters.
async function fetchOverlays(groups, counts, lookupBuiltAt) {
    const since = sinceLiteral(lookupBuiltAt);
    const jobs = [
        ['designs2026', '/tables/Designs2026/records', 'Active=1',
            'ID_Design,DesignName,ID_Customer', 12],
        ['ruth', '/tables/Digitizing_Mockups/records', '(Is_Deleted IS NULL OR Is_Deleted=0)',
            'Design_Number,Company_Name,Id_Customer,Box_Mockup_1', 20],
        ['photo', '/tables/Finished_Photos/records', null,
            'Design_Number,Design_Name,Company_Name,id_Customer,Image_URL', 8],
        ['thumb', '/tables/Shopworks_Thumbnail_Report/records', `timestamp_Uploaded > '${since}'`,
            'Thumb_DesLocid_Design,Thumb_DesLoc_DesDesignName,ExternalKey,FileUrl', 35],
        ['art', '/tables/ArtRequests/records', `Date_Created > '${since}'`,
            'Design_Num_SW,ID_Design,CompanyName,Shopwork_customer_number,id_customer,Box_File_Mockup,BoxFileLink,Company_Mockup', 6]
    ];
    for (const [source, table, where, select, maxPages] of jobs) {
        const params = { 'q.select': select, 'q.orderBy': 'PK_ID', 'q.limit': 1000 };
        if (where) params['q.where'] = where;
        const rows = await fetchAllCaspioPages(table, params, {
            maxPages, strict: true, totalTimeout: 120000
        });
        let folded = 0;
        for (const rec of rows) {
            if (applyOverlayRow(groups, source, rec)) folded++;
            else counts.excludedUnnumbered++;
        }
        counts.bySource[source] = folded;
    }
}

function finalize(groups, counts, lookupBuiltAt) {
    const dicts = { reps: makeDict(), custTypes: makeDict(), tiers: makeDict() };
    const rows = [];
    for (const g of groups.values()) rows.push(encodeRow(g, dicts));
    rows.sort((a, b) => a[0] - b[0]);

    counts.groups = rows.length;
    const builtAt = Date.now();
    const payload = {
        version: `dsi-${builtAt}-${rows.length}`,
        builtAt,
        lookupBuiltAt,
        srcBits: SRC,
        dicts: { reps: dicts.reps.values, custTypes: dicts.custTypes.values, tiers: dicts.tiers.values },
        rows,
        dupClusters: findDupClusters(groups),
        counts
    };
    return payload;
}

// ---------------------------------------------------------------------------
// State + public API
// ---------------------------------------------------------------------------

const state = {
    current: null,        // { payload, payloadString, version, builtAt, etag }
    building: null,       // in-flight build promise (dedup)
    lastError: null,
    prevBaseRows: 0
};

async function runBuild() {
    const groups = new Map();
    const counts = { baseRows: 0, groups: 0, excludedUnnumbered: 0, bySource: {} };

    const lookupBuiltAt = await fetchBase(groups, counts);

    const floor = Math.max(Math.floor(state.prevBaseRows * 0.9), ABSOLUTE_ROW_FLOOR);
    if (counts.baseRows < floor) {
        throw new Error(
            `Design index build refused: base stream returned ${counts.baseRows} rows, ` +
            `below the completeness floor ${floor} — refusing to replace a complete index with a partial one.`
        );
    }

    await fetchOverlays(groups, counts, lookupBuiltAt);

    const payload = finalize(groups, counts, lookupBuiltAt);
    const payloadString = JSON.stringify(payload);
    state.current = {
        payload,
        payloadString,
        version: payload.version,
        builtAt: payload.builtAt,
        etag: `"${payload.version}"`
    };
    state.prevBaseRows = counts.baseRows;
    state.lastError = null;
    console.log(`[DesignSearch] Index built: ${counts.groups} groups from ${counts.baseRows} base rows ` +
        `(+${Object.entries(counts.bySource).map(([k, v]) => `${k}:${v}`).join(' ')}), ` +
        `${payload.dupClusters.length} dup clusters, ${(payloadString.length / 1048576).toFixed(1)} MB raw`);
    return state.current;
}

/** Build (deduped). A failed build keeps the previous index serving. */
function buildIndex() {
    if (state.building) return state.building;
    state.building = runBuild()
        .catch(err => {
            state.lastError = err.message;
            console.error('[DesignSearch] Index build FAILED:', err.message);
            throw err;
        })
        .finally(() => { state.building = null; });
    return state.building;
}

/**
 * Current state for the routes. Kicks an async rebuild when the served index
 * has outlived its TTL — the old index keeps serving meanwhile, with builtAt
 * visible to clients (staleness is shown, never hidden; Rule 4 bans SILENT
 * staleness, and /meta + builtAt make it loud).
 */
function getIndexState() {
    if (state.current && Date.now() - state.current.builtAt > TTL_MS && !state.building) {
        buildIndex().catch(() => { /* logged in buildIndex; old index keeps serving */ });
    }
    return {
        current: state.current,
        building: !!state.building,
        lastError: state.lastError,
        ttlMs: TTL_MS
    };
}

/**
 * Boot warm: one build shortly after the dyno starts (Heroku's daily restart
 * makes this the de-facto daily rebuild — no Scheduler job to hand-manage).
 * Jitter avoids colliding with the 4-hourly bandit sync windows; one retry
 * after 60s absorbs a transient 429.
 */
function warmOnBoot() {
    if (process.env.JEST_WORKER_ID || process.env.DESIGN_SEARCH_WARM === 'off') return null;
    const delay = 45000 + Math.floor(Math.random() * 45000);
    const timer = setTimeout(() => {
        buildIndex().catch(() => {
            setTimeout(() => buildIndex().catch(() => { }), 60000).unref();
        });
    }, delay);
    timer.unref();
    console.log(`[DesignSearch] Boot warm scheduled in ${Math.round(delay / 1000)}s`);
    return timer;
}

/** Test hook — never call from route code. */
function _resetForTests() {
    state.current = null;
    state.building = null;
    state.lastError = null;
    state.prevBaseRows = 0;
}

module.exports = {
    SRC,
    TTL_MS,
    canonicalKey,
    encodeImgRef,
    pickImage,
    newGroup,
    foldBaseRow,
    applyOverlayRow,
    toYYMM,
    encodeRow,
    makeDict,
    findDupClusters,
    sinceLiteral,
    buildIndex,
    getIndexState,
    warmOnBoot,
    _resetForTests
};
