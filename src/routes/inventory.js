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
    const whereClause = `STYLE='${styleNumber}' AND COLOR_NAME='${color}'`;
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'No inventory found for the specified style and color' });
    }

    // Define the size columns we're interested in
    const sizeColumns = [
      'XS_Qty', 'S_Qty', 'M_Qty', 'L_Qty', 'XL_Qty', 
      'XXL_Qty', 'XXXL_Qty', 'XXXXL_Qty', 'XXXXXL_Qty', 'XXXXXXL_Qty'
    ];
    
    // Extract unique sizes that have any inventory
    const sizesSet = new Set();
    const warehouses = [];
    
    records.forEach(record => {
      const warehouseData = {
        warehouse: record.WAREHOUSE || 'Unknown',
        inventory: {}
      };
      
      sizeColumns.forEach(sizeCol => {
        const size = sizeCol.replace('_Qty', '');
        const qty = parseInt(record[sizeCol] || 0);
        
        if (qty > 0) {
          sizesSet.add(size);
        }
        warehouseData.inventory[size] = qty;
      });
      
      warehouses.push(warehouseData);
    });
    
    const sizes = Array.from(sizesSet).sort((a, b) => {
      const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL', 'XXXXXXL'];
      return sizeOrder.indexOf(a) - sizeOrder.indexOf(b);
    });
    
    // Calculate totals
    const sizeTotals = {};
    let grandTotal = 0;
    
    sizes.forEach(size => {
      sizeTotals[size] = 0;
      warehouses.forEach(wh => {
        sizeTotals[size] += wh.inventory[size] || 0;
      });
      grandTotal += sizeTotals[size];
    });

    const response = {
      style: styleNumber,
      color: color,
      sizes: sizes,
      warehouses: warehouses,
      sizeTotals: sizeTotals,
      grandTotal: grandTotal
    };

    console.log(`Inventory table for ${styleNumber} ${color}: ${warehouses.length} warehouses, ${sizes.length} sizes`);
    res.json(response);
  } catch (error) {
    console.error('Error fetching inventory table:', error.message);
    res.status(500).json({ error: 'Failed to fetch inventory table', details: error.message });
  }
});

module.exports = router;