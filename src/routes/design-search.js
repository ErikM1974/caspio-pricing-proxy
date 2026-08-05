/**
 * Design Search routes — the Design Vault index API.
 *
 *   GET /api/design-search/index    full compact index (ETag/If-None-Match → 304;
 *                                   503 + Retry-After while the first build runs;
 *                                   ?refresh=true kicks a rebuild, cooldown-guarded)
 *   GET /api/design-search/meta     version/counts/staleness probe — zero Caspio calls
 *   GET /api/design-search/recent   delta-merge rows changed since the served index
 *                                   was built (client upserts them over its copy)
 *
 * Mounted in server.js behind designSearchLimiter +
 * guardReadsOnly(requireCrmSecretOrBrowserOrigin) — PII-bearing (companies,
 * customer ids, reps), same gate rationale as /api/ups-tracking. The staff-gated
 * gallery page is the real boundary.
 *
 * Builds are NEVER awaited inside /index: a full build streams ~156 Caspio pages
 * (1-3 min), which would H12 the Heroku router. Requests get the current index
 * or a 503; builds run in the background.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { createTtlCache, shouldBypass } = require('../utils/ttl-cache');
const idx = require('../utils/design-search-index');

const recentCache = createTtlCache({ name: 'design-search-recent', ttlMs: 15 * 60 * 1000, maxEntries: 4 });

// ?refresh=true triggers a full rebuild (~180 Caspio calls). The cooldown keeps
// a misbehaving client from turning that into a quota drain: at most one
// honored refresh per 10 minutes, and in-flight dedup absorbs concurrent ones.
const REBUILD_COOLDOWN_MS = 10 * 60 * 1000;

router.get('/index', (req, res) => {
    const s = idx.getIndexState();

    if (req.query.refresh === 'true') {
        const coolEnough = !s.current || (Date.now() - s.current.builtAt > REBUILD_COOLDOWN_MS);
        if (coolEnough && !s.building) {
            idx.buildIndex().catch(() => { /* surfaced via /meta lastError */ });
            return res.status(202).json({
                rebuilding: true,
                message: 'Index rebuild started — poll /api/design-search/meta, then re-fetch /index.'
            });
        }
        return res.status(202).json({
            rebuilding: s.building,
            cooldownMs: REBUILD_COOLDOWN_MS,
            message: s.building ? 'A rebuild is already running.' : 'Refresh ignored — index is younger than the cooldown.'
        });
    }

    if (!s.current) {
        res.set('Retry-After', '60');
        return res.status(503).json({
            building: s.building,
            error: s.lastError || null,
            message: s.building
                ? 'Design index is building — retry shortly.'
                : 'Design index unavailable' + (s.lastError ? `: ${s.lastError}` : ' — build has not run yet.')
        });
    }

    if (req.headers['if-none-match'] === s.current.etag) {
        return res.status(304).end();
    }

    res.set('ETag', s.current.etag);
    res.set('Cache-Control', 'private, max-age=0, must-revalidate');
    res.type('application/json');
    return res.send(s.current.payloadString);
});

router.get('/meta', (req, res) => {
    const s = idx.getIndexState();
    if (!s.current) {
        return res.json({
            success: true,
            ready: false,
            building: s.building,
            lastError: s.lastError || null
        });
    }
    const age = Date.now() - s.current.builtAt;
    return res.json({
        success: true,
        ready: true,
        version: s.current.version,
        builtAt: s.current.builtAt,
        lookupBuiltAt: s.current.payload.lookupBuiltAt,
        counts: s.current.payload.counts,
        dupClusterCount: s.current.payload.dupClusters.length,
        ageMs: age,
        stale: age > s.ttlMs,
        building: s.building,
        lastError: s.lastError || null
    });
});

/**
 * Rows changed since the served index was built, in the SAME positional row
 * format as /index — but with DELTA-MERGE semantics: the client ORs srcBits,
 * fills empty fields, and keeps its existing values otherwise (live sources
 * don't carry rep/type/tier/stitch, so those positions arrive as 0/'').
 * Cost: 5 Caspio calls per 15-min cache window, only while the page is in use.
 */
router.get('/recent', async (req, res) => {
    const s = idx.getIndexState();
    if (!s.current) {
        res.set('Retry-After', '60');
        return res.status(503).json({ error: 'Design index not built yet — /recent has no baseline.' });
    }

    const cacheKey = 'recent:' + s.current.version;
    if (!shouldBypass(req)) {
        const cached = recentCache.get(cacheKey);
        if (cached) return res.json(cached);
    }

    try {
        const since = idx.sinceLiteral(s.current.builtAt);
        const jobs = [
            ['designs2026', '/tables/Designs2026/records',
                `Active=1 AND DateCreated > '${since}'`,
                'ID_Design,DesignName,ID_Customer'],
            ['ruth', '/tables/Digitizing_Mockups/records',
                `(Is_Deleted IS NULL OR Is_Deleted=0) AND Submitted_Date > '${since}'`,
                'Design_Number,Company_Name,Id_Customer,Box_Mockup_1'],
            ['photo', '/tables/Finished_Photos/records',
                `Uploaded_Date > '${since}'`,
                'Design_Number,Design_Name,Company_Name,id_Customer,Image_URL'],
            ['thumb', '/tables/Shopworks_Thumbnail_Report/records',
                `timestamp_Uploaded > '${since}'`,
                'Thumb_DesLocid_Design,Thumb_DesLoc_DesDesignName,ExternalKey,FileUrl'],
            ['art', '/tables/ArtRequests/records',
                `Date_Created > '${since}'`,
                'Design_Num_SW,ID_Design,CompanyName,Shopwork_customer_number,id_customer,Box_File_Mockup,BoxFileLink,Company_Mockup']
        ];

        const groups = new Map();
        let excluded = 0;
        for (const [source, table, where, select] of jobs) {
            const rows = await fetchAllCaspioPages(table, {
                'q.where': where,
                'q.select': select,
                'q.orderBy': 'PK_ID',
                'q.limit': 1000
            }, { maxPages: 10, strict: true, totalTimeout: 60000 });
            for (const rec of rows) {
                if (!idx.applyOverlayRow(groups, source, rec)) excluded++;
            }
        }

        const dicts = { reps: idx.makeDict(), custTypes: idx.makeDict(), tiers: idx.makeDict() };
        const rows = [];
        for (const g of groups.values()) rows.push(idx.encodeRow(g, dicts));
        rows.sort((a, b) => a[0] - b[0]);

        const payload = {
            success: true,
            sinceBuiltAt: s.current.builtAt,
            baseVersion: s.current.version,
            count: rows.length,
            excludedUnnumbered: excluded,
            rows
        };
        recentCache.set(cacheKey, payload);
        return res.json(payload);
    } catch (err) {
        console.error('[DesignSearch] /recent failed:', err.message);
        return res.status(500).json({ error: `Recent-changes query failed: ${err.message}` });
    }
});

module.exports = router;
