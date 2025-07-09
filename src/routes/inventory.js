// Inventory-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

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
      console.warn(`No inventory found for style: ${styleNumber} and color: ${color}`);
      return res.status(404).json({ error: `No inventory found for style: ${styleNumber} and color: ${color}` });
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
      grandTotal: grandTotal
    };
    
    console.log(`Returning inventory table with ${warehouses.length} warehouses and ${sizes.length} sizes for style: ${styleNumber}, color: ${color}`);
    res.json(response);
  } catch (error) {
    console.error('Error fetching sizes:', error.message);
    res.status(500).json({ error: 'Failed to fetch sizes for the specified style and color', details: error.message });
  }
});

module.exports = router;