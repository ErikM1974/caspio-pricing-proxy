// Non-SanMar Products API
// CRUD operations for products from vendors other than SanMar
// (Brooks Brothers, Carhartt direct, specialty items, etc.)
//
// Data stored in Caspio Non_SanMar_Products table

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

// Cache (5 min TTL - products don't change frequently)
const productsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Fetch all non-SanMar products from Caspio with caching
 * @param {boolean} forceRefresh - Bypass cache if true
 * @returns {Promise<Array>} Array of product records
 */
async function fetchProducts(forceRefresh = false) {
    const cacheKey = 'all-non-sanmar-products';
    const cached = productsCache.get(cacheKey);

    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('[CACHE HIT] non-sanmar-products');
        return cached.data;
    }

    console.log('[CACHE MISS] non-sanmar-products - fetching from Caspio');

    try {
        const records = await fetchAllCaspioPages('/tables/Non_SanMar_Products/records', {});

        // Cache the results
        productsCache.set(cacheKey, {
            data: records,
            timestamp: Date.now()
        });

        console.log(`[Non-SanMar Products] Fetched ${records.length} records from Caspio`);
        return records;
    } catch (error) {
        console.error('[Non-SanMar Products] Error fetching from Caspio:', error.message);

        // Return cached data if available (even if stale)
        if (cached) {
            console.log('[Non-SanMar Products] Using stale cache due to error');
            return cached.data;
        }

        throw error;
    }
}

// GET /api/non-sanmar-products
// Returns all non-SanMar products or filtered by query params
// Query params:
//   - brand: Filter by Brand (e.g., "Brooks Brothers")
//   - category: Filter by Category (e.g., "Jackets")
//   - vendor: Filter by VendorCode (e.g., "BB", "CARH")
//   - active: Filter by IsActive (default: true)
//   - refresh: Set to "true" to bypass cache
router.get('/non-sanmar-products', async (req, res) => {
    const { brand, category, vendor, active = 'true', refresh } = req.query;
    const forceRefresh = refresh === 'true';

    try {
        let results = await fetchProducts(forceRefresh);

        // Filter by active status
        if (active === 'true') {
            results = results.filter(p => p.IsActive !== false);
        } else if (active === 'false') {
            results = results.filter(p => p.IsActive === false);
        }

        // Filter by brand
        if (brand) {
            results = results.filter(p =>
                p.Brand && p.Brand.toLowerCase().includes(brand.toLowerCase())
            );
        }

        // Filter by category
        if (category) {
            results = results.filter(p =>
                p.Category && p.Category.toLowerCase().includes(category.toLowerCase())
            );
        }

        // Filter by vendor code
        if (vendor) {
            results = results.filter(p =>
                p.VendorCode && p.VendorCode.toUpperCase() === vendor.toUpperCase()
            );
        }

        res.json({
            success: true,
            data: results,
            count: results.length,
            source: 'caspio'
        });
    } catch (error) {
        console.error('Error in GET /api/non-sanmar-products:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch non-SanMar products',
            details: error.message
        });
    }
});

// GET /api/non-sanmar-products/cache/clear
// Clears the products cache (for admin use)
router.get('/non-sanmar-products/cache/clear', (req, res) => {
    productsCache.clear();
    console.log('[Non-SanMar Products] Cache cleared');
    res.json({
        success: true,
        message: 'Non-SanMar products cache cleared'
    });
});

// GET /api/non-sanmar-products/style/:style
// Fetch a product by StyleNumber
router.get('/non-sanmar-products/style/:style', async (req, res) => {
    const { style } = req.params;

    if (!style) {
        return res.status(400).json({
            success: false,
            error: 'StyleNumber is required'
        });
    }

    try {
        const records = await fetchAllCaspioPages('/tables/Non_SanMar_Products/records', {
            'q.where': `StyleNumber='${style}'`
        });

        if (records.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Product with StyleNumber '${style}' not found`
            });
        }

        res.json({
            success: true,
            data: records[0]
        });
    } catch (error) {
        console.error(`[Non-SanMar Products] Get by style failed for '${style}':`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch product',
            details: error.message
        });
    }
});

// GET /api/non-sanmar-products/:id
// Fetch a product by ID_Product
router.get('/non-sanmar-products/:id', async (req, res) => {
    const { id } = req.params;

    // Skip if id matches other routes
    if (['cache', 'style', 'seed'].includes(id)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid ID format'
        });
    }

    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
            success: false,
            error: 'Valid numeric ID (ID_Product) is required'
        });
    }

    try {
        const records = await fetchAllCaspioPages('/tables/Non_SanMar_Products/records', {
            'q.where': `ID_Product=${id}`
        });

        if (records.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Product with ID_Product=${id} not found`
            });
        }

        res.json({
            success: true,
            data: records[0]
        });
    } catch (error) {
        console.error(`[Non-SanMar Products] Get by ID failed for ID_Product=${id}:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch product',
            details: error.message
        });
    }
});

// POST /api/non-sanmar-products
// Create a new non-SanMar product
router.post('/non-sanmar-products', async (req, res) => {
    const record = req.body;

    // Validate required fields
    if (!record.StyleNumber) {
        return res.status(400).json({
            success: false,
            error: 'StyleNumber is required'
        });
    }
    if (!record.Brand) {
        return res.status(400).json({
            success: false,
            error: 'Brand is required'
        });
    }
    if (!record.ProductName) {
        return res.status(400).json({
            success: false,
            error: 'ProductName is required'
        });
    }

    // Build record with defaults for optional fields
    const newRecord = {
        StyleNumber: record.StyleNumber,
        Brand: record.Brand,
        ProductName: record.ProductName,
        Category: record.Category || '',
        DefaultCost: record.DefaultCost || 0,
        DefaultSellPrice: record.DefaultSellPrice || 0,
        PricingMethod: record.PricingMethod || 'FIXED',
        MarginPercent: record.MarginPercent || 0,
        SizeUpchargeXL: record.SizeUpchargeXL || 0,
        SizeUpcharge2XL: record.SizeUpcharge2XL || 0,
        SizeUpcharge3XL: record.SizeUpcharge3XL || 0,
        AvailableSizes: record.AvailableSizes || '',
        DefaultColors: record.DefaultColors || '',
        VendorCode: record.VendorCode || '',
        VendorURL: record.VendorURL || '',
        ImageURL: record.ImageURL || '',
        Notes: record.Notes || '',
        IsActive: record.IsActive !== false // Default to true
    };

    try {
        console.log(`[Non-SanMar Products] Creating new product: ${newRecord.StyleNumber}`);
        const result = await makeCaspioRequest('post', '/tables/Non_SanMar_Products/records', {}, newRecord);

        // Clear cache after creating
        productsCache.clear();

        res.status(201).json({
            success: true,
            message: `Product '${newRecord.StyleNumber}' created successfully`,
            data: { ...newRecord, ID_Product: result.PK_ID }
        });
    } catch (error) {
        console.error('[Non-SanMar Products] Create failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create product',
            details: error.message
        });
    }
});

// PUT /api/non-sanmar-products/:id
// Update an existing product by ID_Product
router.put('/non-sanmar-products/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
            success: false,
            error: 'Valid numeric ID (ID_Product) is required'
        });
    }

    // Remove ID_Product from updates if present (can't update primary key)
    delete updates.ID_Product;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No fields to update'
        });
    }

    try {
        console.log(`[Non-SanMar Products] Updating record ID_Product=${id}:`, updates);
        await makeCaspioRequest('put', '/tables/Non_SanMar_Products/records', { 'q.where': `ID_Product=${id}` }, updates);

        // Clear cache after updating
        productsCache.clear();

        res.json({
            success: true,
            message: `Product ID_Product=${id} updated successfully`,
            updatedFields: Object.keys(updates)
        });
    } catch (error) {
        console.error(`[Non-SanMar Products] Update failed for ID_Product=${id}:`, error);

        if (error.message && error.message.includes('404')) {
            return res.status(404).json({
                success: false,
                error: `Product with ID_Product=${id} not found`
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to update product',
            details: error.message
        });
    }
});

// DELETE /api/non-sanmar-products/:id
// Soft delete by ID_Product (sets IsActive = false)
// Use ?hard=true for permanent deletion
router.delete('/non-sanmar-products/:id', async (req, res) => {
    const { id } = req.params;
    const { hard } = req.query;

    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
            success: false,
            error: 'Valid numeric ID (ID_Product) is required'
        });
    }

    try {
        if (hard === 'true') {
            // Hard delete - actually remove from database
            console.log(`[Non-SanMar Products] HARD DELETE record ID_Product=${id}`);
            await makeCaspioRequest('delete', '/tables/Non_SanMar_Products/records', { 'q.where': `ID_Product=${id}` });

            productsCache.clear();

            res.json({
                success: true,
                message: `Product ID_Product=${id} permanently deleted`
            });
        } else {
            // Soft delete - set IsActive = false
            console.log(`[Non-SanMar Products] Soft delete (deactivate) record ID_Product=${id}`);
            await makeCaspioRequest('put', '/tables/Non_SanMar_Products/records', { 'q.where': `ID_Product=${id}` }, { IsActive: false });

            productsCache.clear();

            res.json({
                success: true,
                message: `Product ID_Product=${id} deactivated (soft delete)`,
                note: 'Use ?hard=true to permanently delete'
            });
        }
    } catch (error) {
        console.error(`[Non-SanMar Products] Delete failed for ID_Product=${id}:`, error);

        if (error.message && error.message.includes('404')) {
            return res.status(404).json({
                success: false,
                error: `Product with ID_Product=${id} not found`
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to delete product',
            details: error.message
        });
    }
});

// ============================================
// SEED DATA - Initial database population
// ============================================
// Products from non-SanMar vendors (Brooks Brothers, Carhartt direct, specialty)
// Richardson removed - now in SanMar 2026
const PRODUCTS_SEED_DATA = [
    // Brooks Brothers
    {
        StyleNumber: 'BB18201',
        Brand: 'Brooks Brothers',
        ProductName: 'BB Mens Mid-Layer 1/2-Button',
        Category: 'Jackets',
        DefaultCost: 45.00,
        DefaultSellPrice: 95.00,
        PricingMethod: 'FIXED',
        VendorCode: 'BB',
        AvailableSizes: 'S,M,L,XL,2XL',
        SizeUpchargeXL: 0,
        SizeUpcharge2XL: 5,
        SizeUpcharge3XL: 5,
        IsActive: true
    },
    {
        StyleNumber: 'BB18203',
        Brand: 'Brooks Brothers',
        ProductName: 'BB Womens Mid-Layer 1/2-Button',
        Category: 'Jackets',
        DefaultCost: 45.00,
        DefaultSellPrice: 95.00,
        PricingMethod: 'FIXED',
        VendorCode: 'BB',
        AvailableSizes: 'XS,S,M,L,XL,2XL',
        SizeUpchargeXL: 0,
        SizeUpcharge2XL: 5,
        SizeUpcharge3XL: 5,
        IsActive: true
    },
    {
        StyleNumber: 'BB18200',
        Brand: 'Brooks Brothers',
        ProductName: 'BB Mens Mesh Pique Polo',
        Category: 'Polos',
        DefaultCost: 38.00,
        DefaultSellPrice: 80.00,
        PricingMethod: 'FIXED',
        VendorCode: 'BB',
        AvailableSizes: 'S,M,L,XL,2XL,3XL',
        SizeUpchargeXL: 0,
        SizeUpcharge2XL: 5,
        SizeUpcharge3XL: 5,
        IsActive: true
    },
    {
        StyleNumber: 'BB18202',
        Brand: 'Brooks Brothers',
        ProductName: 'BB Womens Mesh Pique Polo',
        Category: 'Polos',
        DefaultCost: 38.00,
        DefaultSellPrice: 80.00,
        PricingMethod: 'FIXED',
        VendorCode: 'BB',
        AvailableSizes: 'XS,S,M,L,XL,2XL',
        SizeUpchargeXL: 0,
        SizeUpcharge2XL: 5,
        SizeUpcharge3XL: 5,
        IsActive: true
    },
    // Carhartt (when ordered direct, not via SanMar)
    {
        StyleNumber: 'CTK87',
        Brand: 'Carhartt',
        ProductName: 'Workwear Pocket T-Shirt',
        Category: 'T-Shirts',
        DefaultCost: 18.00,
        DefaultSellPrice: 38.00,
        PricingMethod: 'FIXED',
        VendorCode: 'CARH',
        AvailableSizes: 'S,M,L,XL,2XL,3XL,4XL',
        SizeUpchargeXL: 0,
        SizeUpcharge2XL: 3,
        SizeUpcharge3XL: 5,
        IsActive: true
    },
    {
        StyleNumber: 'CTJ140',
        Brand: 'Carhartt',
        ProductName: 'Duck Active Jac',
        Category: 'Jackets',
        DefaultCost: 65.00,
        DefaultSellPrice: 130.00,
        PricingMethod: 'FIXED',
        VendorCode: 'CARH',
        AvailableSizes: 'S,M,L,XL,2XL,3XL,4XL',
        SizeUpchargeXL: 0,
        SizeUpcharge2XL: 5,
        SizeUpcharge3XL: 10,
        IsActive: true
    },
    // Safety/Specialty
    {
        StyleNumber: 'CSV400',
        Brand: 'CornerStone',
        ProductName: 'ANSI Class 2 Safety Vest',
        Category: 'Safety',
        DefaultCost: 12.00,
        DefaultSellPrice: 25.00,
        PricingMethod: 'FIXED',
        VendorCode: 'CS',
        AvailableSizes: 'S/M,L/XL,2XL/3XL,4XL/5XL',
        SizeUpchargeXL: 0,
        SizeUpcharge2XL: 0,
        SizeUpcharge3XL: 0,
        IsActive: true
    }
];

/**
 * Create a unique key for a product record (StyleNumber)
 */
function makeRecordKey(record) {
    return record.StyleNumber;
}

// POST /api/non-sanmar-products/seed
// Seeds the Caspio Non_SanMar_Products table with initial data
// Safe to run multiple times - only inserts records that don't exist
router.post('/non-sanmar-products/seed', async (req, res) => {
    console.log('[Non-SanMar Products] Starting seed operation...');

    const results = {
        inserted: 0,
        skipped: 0,
        failed: 0,
        errors: []
    };

    try {
        // First, fetch existing records to check what already exists
        console.log('[Non-SanMar Products] Fetching existing records...');
        const existingRecords = await fetchAllCaspioPages('/tables/Non_SanMar_Products/records', {});

        // Build set of existing keys (StyleNumber)
        const existingKeys = new Set();
        for (const record of existingRecords) {
            existingKeys.add(makeRecordKey(record));
        }
        console.log(`[Non-SanMar Products] Found ${existingRecords.length} existing records`);

        // Insert only records that don't exist
        for (const record of PRODUCTS_SEED_DATA) {
            const key = makeRecordKey(record);

            if (existingKeys.has(key)) {
                results.skipped++;
                console.log(`[Non-SanMar Products] Skipped (exists): ${record.StyleNumber}`);
                continue;
            }

            try {
                await makeCaspioRequest('post', '/tables/Non_SanMar_Products/records', {}, record);
                results.inserted++;
                console.log(`[Non-SanMar Products] Inserted: ${record.StyleNumber}`);
            } catch (err) {
                results.failed++;
                results.errors.push({
                    styleNumber: record.StyleNumber,
                    error: err.message
                });
                console.error(`[Non-SanMar Products] Failed to insert ${record.StyleNumber}:`, err.message);
            }
        }

        // Clear cache after seeding
        productsCache.clear();

        const totalExpected = PRODUCTS_SEED_DATA.length;
        const totalInDb = results.inserted + results.skipped;

        res.json({
            success: true,
            message: `Seed complete: ${results.inserted} inserted, ${results.skipped} skipped (already exist), ${results.failed} failed`,
            results,
            summary: {
                expected: totalExpected,
                nowInDatabase: totalInDb,
                missing: totalExpected - totalInDb
            }
        });
    } catch (error) {
        console.error('[Non-SanMar Products] Seed operation failed:', error);
        res.status(500).json({
            success: false,
            error: 'Seed operation failed',
            details: error.message,
            results
        });
    }
});

module.exports = router;
