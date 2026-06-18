// Inventory-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// The live SanMar product feed. This is the table that actually exists in Caspio and
// powers /api/inventory, /max-prices-by-style and /pricing-bundle.
const SANMAR_TABLE = '/tables/Sanmar_Bulk_251816_Feb2024/records';

// Strip anything that isn't a valid SanMar style character before interpolating into
// a Caspio WHERE clause (injection guard). Mirrors sanitizeStyleNumber in pricing.js.
function sanitizeStyleNumber(input) {
  if (!input || typeof input !== 'string') return null;
  const sanitized = input.replace(/[^a-zA-Z0-9\-\.]/g, '').trim();
  return (sanitized.length > 0 && sanitized.length <= 30) ? sanitized : null;
}

/**
 * Derive the real size run for a style from the live SanMar bulk table, sorted by the
 * canonical Size_Display_Order table (the same source /api/pricing-bundle uses).
 *
 * The run is style-level (color-independent) on purpose: SanMar carries the same size
 * range across a style's colors, and color *names* are unreliable to filter on — e.g.
 * PC61 has "Jet Black", not "Black", and "Drk Hthr Grey" vs "Dark Heather Grey" — so a
 * COLOR_NAME match would spuriously return zero sizes. Returns [] when the style has no
 * rows (e.g. unknown/discontinued style).
 */
async function getStyleSizeRun(styleNumber) {
  const safeStyle = sanitizeStyleNumber(styleNumber) || styleNumber;

  const [rows, sizeOrder] = await Promise.all([
    fetchAllCaspioPages(SANMAR_TABLE, {
      'q.where': `STYLE='${safeStyle}'`,
      'q.select': 'SIZE',
      'q.limit': 1000
    }),
    fetchAllCaspioPages('/tables/Size_Display_Order/records', {
      'q.select': 'size,sort_order',
      'q.limit': 200
    }).catch(err => {
      // Sort table is a nice-to-have; without it we still return the sizes (unsorted).
      console.error('Failed to fetch size display order:', err.message);
      return [];
    })
  ]);

  const sortMap = {};
  sizeOrder.forEach(o => {
    if (o.size != null) sortMap[String(o.size).trim().toUpperCase()] = o.sort_order;
  });

  return [...new Set(
    rows.map(r => (r.SIZE == null ? '' : String(r.SIZE).trim().toUpperCase())).filter(Boolean)
  )].sort((a, b) => (sortMap[a] ?? 999) - (sortMap[b] ?? 999));
}

// GET /api/inventory
router.get('/inventory', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/inventory requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    let whereClause = `STYLE='${styleNumber}'`;
    if (color) {
      whereClause += ` AND COLOR_NAME='${color}'`;
    }

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause
    });

    console.log(`Inventory for ${styleNumber}: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching inventory:', error.message);
    res.status(500).json({ error: 'Failed to fetch inventory', details: error.message });
  }
});

// GET /api/sizes-by-style-color
router.get('/sizes-by-style-color', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/sizes-by-style-color requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber || !color) {
    return res.status(400).json({ error: 'Both styleNumber and color are required' });
  }

  // PRIMARY SOURCE: the dedicated Caspio "Inventory" table. When present it returns a
  // full warehouse-by-size availability matrix. As of 2026-06-18 this table 404s from
  // Caspio (removed/renamed), which surfaced to callers as a 500 on every style/color.
  // We try it first (so the rich matrix returns automatically if the table comes back),
  // then fall back to the SanMar bulk size run below.
  try {
    console.log(`Fetching inventory table for style: ${styleNumber}, color: ${color}`);
    const resource = '/tables/Inventory/records';
    const params = {
      'q.where': `catalog_no='${styleNumber}' AND catalog_color='${color}'`,
      'q.select': 'catalog_no, catalog_color, size, SizeSortOrder, WarehouseName, quantity, WarehouseSort',
      'q.orderby': 'WarehouseSort ASC, SizeSortOrder ASC',
      'q.limit': 1000
    };

    const result = await fetchAllCaspioPages(resource, params);

    if (result.length === 0) {
      // Table reachable but no rows for this combo — fall through to the bulk size run
      // so callers still receive the style's real size run rather than a 404.
      console.warn(`No rows in Inventory table for style: ${styleNumber}, color: ${color}; falling back to SanMar bulk size run.`);
      throw new Error('Inventory table returned no rows');
    }

    // Extract unique sizes and warehouses
    const sizesSet = new Set();
    const warehousesSet = new Set();
    
    result.forEach(item => {
      if (item.size) sizesSet.add(item.size);
      if (item.WarehouseName) warehousesSet.add(item.WarehouseName);
    });
    
    // Get size sort order mapping
    const sizeSortMap = {};
    result.forEach(item => {
      if (item.size && item.SizeSortOrder) {
        sizeSortMap[item.size] = item.SizeSortOrder;
      }
    });
    
    // Sort sizes by SizeSortOrder
    const sizes = Array.from(sizesSet).sort((a, b) => {
      return (sizeSortMap[a] || 0) - (sizeSortMap[b] || 0);
    });
    
    // Get warehouse sort order mapping
    const warehouseSortMap = {};
    result.forEach(item => {
      if (item.WarehouseName && item.WarehouseSort) {
        warehouseSortMap[item.WarehouseName] = item.WarehouseSort;
      }
    });
    
    // Sort warehouses by WarehouseSort
    const warehouses = Array.from(warehousesSet).sort((a, b) => {
      return (warehouseSortMap[a] || 0) - (warehouseSortMap[b] || 0);
    });
    
    // Create inventory matrix
    const inventoryMatrix = {};
    const sizeTotals = {};
    
    // Initialize the matrix with zeros and size totals
    warehouses.forEach(warehouse => {
      inventoryMatrix[warehouse] = {};
      sizes.forEach(size => {
        inventoryMatrix[warehouse][size] = 0;
        if (!sizeTotals[size]) sizeTotals[size] = 0;
      });
    });
    
    // Fill in the inventory quantities
    result.forEach(item => {
      if (item.WarehouseName && item.size && item.quantity !== null) {
        inventoryMatrix[item.WarehouseName][item.size] = item.quantity;
        sizeTotals[item.size] += item.quantity;
      }
    });
    
    // Calculate warehouse totals
    const warehouseTotals = {};
    warehouses.forEach(warehouse => {
      warehouseTotals[warehouse] = sizes.reduce((total, size) => {
        return total + (inventoryMatrix[warehouse][size] || 0);
      }, 0);
    });
    
    // Calculate grand total
    const grandTotal = sizes.reduce((total, size) => {
      return total + (sizeTotals[size] || 0);
    }, 0);
    
    // Format the response for a tabular display
    const response = {
      style: styleNumber,
      color: color,
      sizes: sizes,
      warehouses: warehouses.map(warehouse => ({
        name: warehouse,
        inventory: sizes.map(size => inventoryMatrix[warehouse][size]),
        total: warehouseTotals[warehouse]
      })),
      sizeTotals: sizes.map(size => sizeTotals[size]),
      grandTotal: grandTotal,
      source: 'inventory'
    };

    console.log(`Returning inventory table with ${warehouses.length} warehouses and ${sizes.length} sizes for style: ${styleNumber}, color: ${color}`);
    return res.json(response);
  } catch (error) {
    // Inventory table unavailable (404 since 2026-06-18), errored, or had no rows.
    // Don't fail — fall back to the real size run from the live SanMar bulk table so
    // quote builders' getAvailableSizes() always get e.g. PC61 → S–6XL instead of a
    // hardcoded S–4XL guess. Warehouse-level quantities aren't available from this
    // source, so warehouses/totals come back empty.
    console.warn(`Inventory table lookup failed for style: ${styleNumber}, color: ${color} (${error.message}); deriving size run from SanMar bulk.`);
  }

  try {
    const sizes = await getStyleSizeRun(styleNumber);

    if (sizes.length === 0) {
      console.warn(`No sizes found for style: ${styleNumber} (color: ${color}) in SanMar bulk.`);
      return res.status(404).json({ error: `No sizes found for style: ${styleNumber} and color: ${color}` });
    }

    console.log(`Returning ${sizes.length} sizes for style: ${styleNumber}, color: ${color} (source: sanmar-bulk)`);
    return res.json({
      style: styleNumber,
      color: color,
      sizes: sizes,
      warehouses: [],
      sizeTotals: sizes.map(() => 0),
      grandTotal: 0,
      source: 'sanmar-bulk'
    });
  } catch (error) {
    console.error('Error fetching sizes for the specified style and color:', error.message);
    return res.status(500).json({ error: 'Failed to fetch sizes for the specified style and color', details: error.message });
  }
});

module.exports = router;
module.exports.getStyleSizeRun = getStyleSizeRun;
module.exports.sanitizeStyleNumber = sanitizeStyleNumber;