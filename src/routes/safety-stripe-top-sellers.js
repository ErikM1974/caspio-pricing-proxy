// Safety-Stripe Top Sellers Routes
//
// Backed by the Caspio table `Safety_Stripe_Top_Sellers_2026` — one row per
// (style, safety-color) pair, Erik-curated from 13 years of hi-vis sales. These
// are the garments that historically sell best WITH screen-printed safety
// stripes (SP-STRIPE, $2/location). Mirrors dtg-top-sellers.js / emb-top-sellers.js.
//
// Endpoints:
//   GET /api/safety-stripes/top-sellers           → all active rows, style_rank/color_rank ASC
//   GET /api/safety-stripes/top-sellers?style=PC55 → all safety colors for one style
//   GET /api/safety-stripes/top-sellers?limit=N    → top N styles (all their colors)
//   GET /api/safety-stripes/top-sellers/styles     → one row per style (aggregated, for cards)
//
// The table stores ONLY curated metadata (style, safety color, rank, note).
// Product image/title/colors hydrate from SanMar at request time (same
// hydrateMainImages path the DTG/EMB top-sellers use). On Caspio failure these
// return 502 (loud) — never a silent empty-200, so the recommendation UI can
// fall back visibly rather than show a wrong/empty list.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE_NAME = 'Safety_Stripe_Top_Sellers_2026';
const RESOURCE = `/tables/${TABLE_NAME}/records`;

// Per-dyno image cache: { [style]: { main_image_url, colors_by_catalog } }.
// Built lazily on first /styles request. colors_by_catalog maps
// CATALOG_COLOR → model-wearing-color image so each safety-color swatch can
// swap the card hero. Reuses the SanMar product-bundle path (method-agnostic).
let _imageCache = null;
let _imagePromise = null;
const INTERNAL_API = process.env.INTERNAL_API_BASE || 'http://localhost:' + (process.env.PORT || 3002);

async function hydrateMainImages(styles) {
  if (_imageCache) {
    const missing = styles.filter((s) => !(s in _imageCache));
    if (!missing.length) return _imageCache;
  }
  if (_imagePromise) return _imagePromise;
  _imagePromise = Promise.all(styles.map(async (style) => {
    try {
      const r = await fetch(`${INTERNAL_API}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(style)}`);
      if (!r.ok) return [style, { main_image_url: null, colors_by_catalog: {} }];
      const j = await r.json();
      const colors = (j && j.product && Array.isArray(j.product.colors)) ? j.product.colors : [];
      const first = colors.find((c) => c && c.MAIN_IMAGE_URL);
      const colorsByCatalog = {};
      for (const c of colors) {
        if (!c) continue;
        const cc = String(c.CATALOG_COLOR || '').trim();
        const url = c.MAIN_IMAGE_URL || c.FRONT_MODEL_IMAGE_URL || c.FRONT_FLAT_IMAGE_URL || '';
        if (cc && url) colorsByCatalog[cc] = url;
      }
      return [style, {
        main_image_url: first ? first.MAIN_IMAGE_URL : null,
        colors_by_catalog: colorsByCatalog,
      }];
    } catch {
      return [style, { main_image_url: null, colors_by_catalog: {} }];
    }
  })).then((entries) => {
    _imageCache = Object.assign({}, _imageCache || {}, Object.fromEntries(entries));
    _imagePromise = null;
    return _imageCache;
  });
  return _imagePromise;
}

// Strip single quotes from user-supplied filters (read-only Caspio WHERE).
function sanitize(v) {
  return String(v || '').replace(/'/g, '');
}

// is_active stored as Text 'Yes'/'No' (also tolerates 1/0/true/blank). Blank → active.
function isActiveRow(r) {
  const v = r.is_active;
  if (v === undefined || v === null || v === '') return true;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'y';
}

function shape(record) {
  return {
    style: record.style || '',
    style_rank: Number(record.style_rank) || 0,
    product_title: record.product_title || '',
    category: record.category || '',
    color_name: record.color_name || '',
    catalog_color: record.catalog_color || '',
    color_rank: Number(record.color_rank) || 0,
    units_sold: Number(record.units_sold) || 0,
    best_for: record.best_for || '',
  };
}

// GET /api/safety-stripes/top-sellers — all rows (filterable)
router.get('/safety-stripes/top-sellers', async (req, res) => {
  try {
    const params = {};
    const where = [];
    if (req.query.style) where.push(`style='${sanitize(req.query.style).toUpperCase()}'`);
    if (req.query.category) where.push(`category='${sanitize(req.query.category)}'`);
    if (req.query.color) where.push(`color_name='${sanitize(req.query.color)}'`);
    if (where.length) params['q.where'] = where.join(' AND ');
    params['q.orderBy'] = 'style_rank ASC, color_rank ASC';

    let records = (await fetchAllCaspioPages(RESOURCE, params)).filter(isActiveRow).map(shape);

    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0) {
      const keep = new Set();
      for (const r of records) if (keep.size < limit) keep.add(r.style_rank);
      records = records.filter((r) => keep.has(r.style_rank));
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      success: true,
      count: records.length,
      uniqueStyles: new Set(records.map((r) => r.style)).size,
      records,
    });
  } catch (err) {
    console.error('[safety-stripe-top-sellers] error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to fetch safety-stripe top sellers' });
  }
});

// GET /api/safety-stripes/top-sellers/styles — one aggregated row per style (cards)
router.get('/safety-stripes/top-sellers/styles', async (req, res) => {
  try {
    const params = {};
    if (req.query.category) params['q.where'] = `category='${sanitize(req.query.category)}'`;
    params['q.orderBy'] = 'style_rank ASC, color_rank ASC';

    const raw = (await fetchAllCaspioPages(RESOURCE, params)).filter(isActiveRow);

    // Aggregate per style; carry up to 3 safety colors inline so the card can
    // render swatches without a second round-trip.
    const byStyle = new Map();
    for (const r of raw) {
      const style = r.style;
      if (!byStyle.has(style)) {
        byStyle.set(style, {
          style,
          style_rank: Number(r.style_rank) || 0,
          product_title: r.product_title || '',
          category: r.category || '',
          best_for: r.best_for || '',
          top_color: r.color_name || '',
          top_color_catalog: r.catalog_color || '',
          color_count: 0,
          colors: [],
        });
      }
      const s = byStyle.get(style);
      s.color_count++;
      if (s.colors.length < 6) {
        s.colors.push({
          color_name: r.color_name || '',
          catalog_color: r.catalog_color || '',
          color_rank: Number(r.color_rank || 0),
          units_sold: Number(r.units_sold || 0),
        });
      }
    }

    const records = [...byStyle.values()].sort((a, b) => a.style_rank - b.style_rank);
    const limit = parseInt(req.query.limit, 10);
    const out = Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;

    // Hydrate hero image (prefers the top safety color's image) + per-color image.
    try {
      const imageMap = await hydrateMainImages(out.map((r) => r.style));
      for (const r of out) {
        const entry = imageMap[r.style] || {};
        const byColor = entry.colors_by_catalog || {};
        r.main_image_url = byColor[r.top_color_catalog] || entry.main_image_url || '';
        for (const c of r.colors) c.front_image_url = byColor[c.catalog_color] || '';
      }
    } catch (e) {
      console.warn('[safety-stripe-top-sellers/styles] image hydration skipped:', e.message);
      for (const r of out) {
        r.main_image_url = '';
        for (const c of r.colors) c.front_image_url = '';
      }
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, count: out.length, records: out });
  } catch (err) {
    console.error('[safety-stripe-top-sellers/styles] error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to fetch safety-stripe styles' });
  }
});

module.exports = router;
