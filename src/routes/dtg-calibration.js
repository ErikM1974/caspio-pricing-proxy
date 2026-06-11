// DTG Print-Area Calibration API (Custom T-Shirts storefront, 2026-06-10)
//
// Stores per-style print-envelope placements laid out by staff in the
// internal tool (/tools/custom-tees-calibrate.html on the frontend). The
// storefront designer fetches these and anchors the drag/resize envelope to
// the saved rectangle — overriding the silhouette auto-fit for styles Erik
// has laid out by hand. Erik edits placements with NO deploy (Caspio rule).
//
// Caspio table: DTG_Calibration
//   StyleNumber  Text(255)   e.g. "PC61LS"
//   ViewName     Text(255)   "flatFront" | "flatBack"
//   CatalogColor Text(255)   "" = applies to all colors; else a CATALOG_COLOR
//   XFrac        Number      envelope left edge   (fraction of image width)
//   YFrac        Number      envelope top edge    (fraction of image height)
//   WFrac        Number      envelope width       (fraction of image width)
//   HFrac        Number      envelope height      (fraction of image height)
//   ImageURL     Text(255)   the photo the layout was made on (drift detection)
//   UpdatedBy    Text(255)
//   UpdatedAt    Text(255)   ISO string

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

const TABLE = 'DTG_Calibration';
const VIEWS = new Set(['flatFront', 'flatBack']);

// 5-min cache per style (the storefront fetches on every product open)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function sanitizeStyle(raw) {
    const s = String(raw || '').trim().toUpperCase();
    return /^[A-Z0-9_-]{2,20}$/.test(s) ? s : null;
}

function frac(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= -0.5 && n <= 1.5 ? n : null;
}

// GET /api/dtg-calibration?styleNumber=PC61LS   (or no param = all rows)
router.get('/dtg-calibration', async (req, res) => {
    try {
        const style = req.query.styleNumber ? sanitizeStyle(req.query.styleNumber) : null;
        if (req.query.styleNumber && !style) {
            return res.status(400).json({ success: false, error: 'Invalid styleNumber' });
        }
        const key = style || '__all__';
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL && !req.query.refresh) {
            return res.json({ success: true, data: hit.rows, cached: true });
        }
        const params = style ? { 'q.where': `StyleNumber='${style}'` } : {};
        const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, params);
        cache.set(key, { at: Date.now(), rows });
        res.json({ success: true, data: rows });
    } catch (error) {
        // Table not created yet → behave as "no overrides" so the storefront's
        // silhouette auto-fit keeps working; flag it for the calibration tool.
        const msg = String(error.message || '');
        if (/does ?n.t exist|not found|invalid.*table|404/i.test(msg)) {
            return res.json({ success: true, data: [], tableMissing: true });
        }
        console.error('[dtg-calibration] GET failed:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch calibration' });
    }
});

// POST /api/dtg-calibration — UPSERT keyed on (StyleNumber, ViewName, CatalogColor)
router.post('/dtg-calibration', express.json(), async (req, res) => {
    try {
        const style = sanitizeStyle(req.body.StyleNumber);
        const view = String(req.body.ViewName || '');
        const color = String(req.body.CatalogColor || '').trim().slice(0, 100);
        const x = frac(req.body.XFrac);
        const y = frac(req.body.YFrac);
        const w = frac(req.body.WFrac);
        const h = frac(req.body.HFrac);
        if (!style || !VIEWS.has(view) || x === null || y === null || w === null || h === null || !(w > 0.02) || !(h > 0.02)) {
            return res.status(400).json({ success: false, error: 'StyleNumber, ViewName (flatFront|flatBack) and sane XFrac/YFrac/WFrac/HFrac are required' });
        }
        const record = {
            StyleNumber: style,
            ViewName: view,
            CatalogColor: color,
            XFrac: x, YFrac: y, WFrac: w, HFrac: h,
            ImageURL: String(req.body.ImageURL || '').slice(0, 250),
            UpdatedBy: String(req.body.UpdatedBy || 'staff').slice(0, 100),
            UpdatedAt: new Date().toISOString(),
        };
        // Upsert: replace any existing row for the same key
        const colorEsc = color.replace(/'/g, "''");
        const where = `StyleNumber='${style}' AND ViewName='${view}' AND CatalogColor='${colorEsc}'`;
        const existing = await fetchAllCaspioPages(`/tables/${TABLE}/records`, { 'q.where': where });
        if (existing.length) {
            await makeCaspioRequest('put', `/tables/${TABLE}/records`, { 'q.where': `PK_ID=${parseInt(existing[0].PK_ID, 10)}` }, record);
        } else {
            await makeCaspioRequest('post', `/tables/${TABLE}/records`, {}, record);
        }
        cache.clear();
        res.json({ success: true, updated: existing.length > 0 });
    } catch (error) {
        const msg = String(error.message || '');
        if (/does ?n.t exist|not found|invalid.*table|404/i.test(msg)) {
            return res.status(409).json({ success: false, tableMissing: true, error: 'Caspio table DTG_Calibration does not exist yet — create it first (column spec in the route file header).' });
        }
        console.error('[dtg-calibration] POST failed:', error.message);
        res.status(500).json({ success: false, error: 'Failed to save calibration' });
    }
});

// DELETE /api/dtg-calibration/:pkId
router.delete('/dtg-calibration/:pkId', async (req, res) => {
    try {
        const pk = parseInt(req.params.pkId, 10);
        if (!Number.isInteger(pk) || pk <= 0 || String(pk) !== String(req.params.pkId)) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }
        await makeCaspioRequest('delete', `/tables/${TABLE}/records`, { 'q.where': `PK_ID=${pk}` });
        cache.clear();
        res.json({ success: true });
    } catch (error) {
        console.error('[dtg-calibration] DELETE failed:', error.message);
        res.status(500).json({ success: false, error: 'Failed to delete calibration' });
    }
});

module.exports = router;
