// Tax Rate API
// CRUD operations for sales_tax_accounts_2026 Caspio table
// + Hybrid WA DOR API + Caspio lookup endpoint
//
// Lookup flow:
//   1. Non-WA state → return Out of State (account 2202, 0%)
//   2. Check in-memory cache (keyed by ZIP, 24h TTL)
//   3. Call WA DOR API → parse rate
//   4. Match rate to Caspio tax account
//   5. Fallback to default WA account 2200 (10.1%) if DOR fails

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

// --- Caches ---

// Caspio tax accounts cache (5-min TTL, cleared on CRUD mutations)
const accountsCache = new Map();
const ACCOUNTS_CACHE_TTL = 5 * 60 * 1000;

// DOR lookup results cache (keyed by ZIP, 24-hour TTL)
const dorCache = new Map();
const DOR_CACHE_TTL = 24 * 60 * 60 * 1000;

// --- Input Sanitization ---

function sanitizeAccountNumber(val) {
    if (!val || typeof val !== 'string') return null;
    const cleaned = val.trim();
    if (!/^[0-9.]+$/.test(cleaned)) return null;
    return cleaned;
}

function sanitizeAddress(val) {
    if (!val || typeof val !== 'string') return '';
    return val.replace(/['"\\;]/g, '').substring(0, 200).trim();
}

function sanitizeState(val) {
    if (!val || typeof val !== 'string') return null;
    const cleaned = val.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cleaned)) return null;
    return cleaned;
}

function sanitizeZip(val) {
    if (!val || typeof val !== 'string') return null;
    const cleaned = val.trim();
    if (!/^\d{5}(-\d{4})?$/.test(cleaned)) return null;
    return cleaned;
}

// --- Helpers ---

/**
 * Fetch all active tax accounts from Caspio with caching
 * @param {boolean} forceRefresh - Bypass cache if true
 * @returns {Promise<Array>} Array of tax account records
 */
async function fetchTaxAccounts(forceRefresh = false) {
    const cacheKey = 'all-tax-accounts';
    const cached = accountsCache.get(cacheKey);

    if (!forceRefresh && cached && Date.now() - cached.timestamp < ACCOUNTS_CACHE_TTL) {
        console.log('[CACHE HIT] tax-accounts');
        return cached.data;
    }

    console.log('[CACHE MISS] tax-accounts - fetching from Caspio');

    try {
        const records = await fetchAllCaspioPages('/tables/sales_tax_accounts_2026/records', {
            'q.where': "Active='Yes'"
        });

        // Sort by Account_Number
        records.sort((a, b) => {
            const numA = parseFloat(a.Account_Number) || 0;
            const numB = parseFloat(b.Account_Number) || 0;
            return numA - numB;
        });

        accountsCache.set(cacheKey, {
            data: records,
            timestamp: Date.now()
        });

        console.log(`[Tax Rates] Fetched ${records.length} active accounts from Caspio`);
        return records;
    } catch (error) {
        console.error('[Tax Rates] Error fetching from Caspio:', error.message);

        // Return cached data if available (even if stale)
        if (cached) {
            console.log('[Tax Rates] Using stale cache due to error');
            return cached.data;
        }

        throw error;
    }
}

/**
 * Find tax account matching a given rate
 * @param {number} rate - Tax rate as decimal (e.g., 0.081)
 * @param {Array} accounts - Array of tax account records
 * @returns {Object|null} Matching account or null
 */
function findAccountByRate(rate, accounts) {
    // Exact match first (within floating point tolerance)
    const exactMatch = accounts.find(a =>
        Math.abs(parseFloat(a.Tax_Rate) - rate) < 0.0001
    );
    if (exactMatch) return exactMatch;

    // Find nearest match (rare — new rate not yet in Caspio)
    let nearest = null;
    let minDiff = Infinity;
    for (const account of accounts) {
        const diff = Math.abs(parseFloat(account.Tax_Rate) - rate);
        if (diff < minDiff) {
            minDiff = diff;
            nearest = account;
        }
    }

    if (nearest && minDiff < 0.01) {
        console.warn(`[Tax Rates] No exact match for rate ${rate}, using nearest: ${nearest.Account_Number} (diff: ${minDiff})`);
        return nearest;
    }

    return null;
}

/**
 * Call WA DOR API to look up tax rate by address
 * @param {string} addr - Street address
 * @param {string} city - City name
 * @param {string} zip - ZIP code (5 digits)
 * @returns {Promise<Object>} { rate, locationCode, resultCode } or null on failure
 */
async function callDorApi(addr, city, zip) {
    const params = new URLSearchParams();
    params.set('output', 'text');
    if (addr) params.set('addr', addr);
    if (city) params.set('city', city);
    if (zip) params.set('zip', zip);

    const url = `https://webgis.dor.wa.gov/webapi/AddressRates.aspx?${params.toString()}`;
    console.log(`[Tax Rates] Calling DOR API: ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`DOR API returned HTTP ${response.status}`);
        }

        const text = await response.text();
        console.log(`[Tax Rates] DOR response: ${text.substring(0, 200)}`);

        // Parse response: "LocationCode=XXXX  Rate=0.081  ResultCode=0"
        // or multi-line format with key=value pairs
        const locationMatch = text.match(/LocationCode\s*=\s*(\d+)/i);
        const rateMatch = text.match(/Rate\s*=\s*([\d.]+)/i);
        const resultMatch = text.match(/ResultCode\s*=\s*(\d+)/i);

        if (!rateMatch) {
            console.error('[Tax Rates] Could not parse rate from DOR response:', text);
            return null;
        }

        const rate = parseFloat(rateMatch[1]);
        const locationCode = locationMatch ? locationMatch[1] : null;
        const resultCode = resultMatch ? parseInt(resultMatch[1]) : null;

        // ResultCode meanings: 0 = exact match, 1 = ZIP centroid, 2 = error
        if (resultCode === 2) {
            console.warn('[Tax Rates] DOR returned error result code 2');
            return null;
        }

        return { rate, locationCode, resultCode };
    } catch (error) {
        clearTimeout(timeout);
        console.error('[Tax Rates] DOR API call failed:', error.message);
        return null;
    }
}

// ============================================
// CRUD Endpoints
// ============================================

// GET /api/tax-rates — List all active tax accounts
router.get('/tax-rates', async (req, res) => {
    const forceRefresh = req.query.refresh === 'true';

    try {
        const accounts = await fetchTaxAccounts(forceRefresh);

        res.json({
            success: true,
            data: accounts,
            count: accounts.length,
            source: 'caspio'
        });
    } catch (error) {
        console.error('Error in GET /api/tax-rates:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch tax accounts',
            details: error.message
        });
    }
});

// GET /api/tax-rates/cache/clear — Clear all caches
router.get('/tax-rates/cache/clear', (req, res) => {
    accountsCache.clear();
    dorCache.clear();
    console.log('[Tax Rates] All caches cleared');
    res.json({
        success: true,
        message: 'Tax rate caches cleared (accounts + DOR)'
    });
});

// GET /api/tax-rates/:accountNumber — Get specific account by Account_Number
router.get('/tax-rates/:accountNumber', async (req, res) => {
    const { accountNumber } = req.params;

    // Skip if accountNumber matches other route segments
    if (['cache', 'lookup'].includes(accountNumber)) {
        return res.status(400).json({ success: false, error: 'Invalid account number' });
    }

    const sanitized = sanitizeAccountNumber(accountNumber);
    if (!sanitized) {
        return res.status(400).json({
            success: false,
            error: 'Invalid account number format. Must be numeric with optional decimal (e.g., 2200.81)'
        });
    }

    try {
        const records = await fetchAllCaspioPages('/tables/sales_tax_accounts_2026/records', {
            'q.where': `Account_Number='${sanitized}'`
        });

        if (records.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Tax account '${sanitized}' not found`
            });
        }

        res.json({
            success: true,
            data: records[0]
        });
    } catch (error) {
        console.error(`[Tax Rates] Get by account number failed for '${sanitized}':`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch tax account',
            details: error.message
        });
    }
});

// POST /api/tax-rates — Create new tax account
router.post('/tax-rates', async (req, res) => {
    // Guard against lookup endpoint collision
    // (Express should handle this, but being explicit)
    const record = req.body;

    if (!record.Account_Number) {
        return res.status(400).json({ success: false, error: 'Account_Number is required' });
    }
    if (!record.Account_Name) {
        return res.status(400).json({ success: false, error: 'Account_Name is required' });
    }
    if (record.Tax_Rate === undefined || record.Tax_Rate === null) {
        return res.status(400).json({ success: false, error: 'Tax_Rate is required' });
    }

    const sanitized = sanitizeAccountNumber(record.Account_Number);
    if (!sanitized) {
        return res.status(400).json({ success: false, error: 'Invalid Account_Number format' });
    }

    const newRecord = {
        Account_Number: sanitized,
        Account_Name: record.Account_Name,
        Tax_Rate: parseFloat(record.Tax_Rate),
        Active: record.Active || 'Yes',
        Account_Type: record.Account_Type || 'Liability',
        Parent_Account: record.Parent_Account || '2200'
    };

    try {
        console.log(`[Tax Rates] Creating new account: ${sanitized}`);
        const result = await makeCaspioRequest('post', '/tables/sales_tax_accounts_2026/records', {}, newRecord);

        accountsCache.clear();

        res.status(201).json({
            success: true,
            message: `Tax account '${sanitized}' created successfully`,
            data: { ...newRecord, ID_Account: result.PK_ID }
        });
    } catch (error) {
        console.error('[Tax Rates] Create failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create tax account',
            details: error.message
        });
    }
});

// PUT /api/tax-rates/:id — Update tax account by ID_Account
router.put('/tax-rates/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    if (!id) {
        return res.status(400).json({ success: false, error: 'ID_Account is required' });
    }

    delete updates.ID_Account;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    try {
        console.log(`[Tax Rates] Updating ID_Account='${id}':`, updates);
        await makeCaspioRequest('put', '/tables/sales_tax_accounts_2026/records',
            { 'q.where': `ID_Account='${id}'` }, updates);

        accountsCache.clear();

        res.json({
            success: true,
            message: `Tax account '${id}' updated successfully`,
            updatedFields: Object.keys(updates)
        });
    } catch (error) {
        console.error(`[Tax Rates] Update failed for ID_Account='${id}':`, error);

        if (error.message && error.message.includes('404')) {
            return res.status(404).json({ success: false, error: `Tax account '${id}' not found` });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to update tax account',
            details: error.message
        });
    }
});

// DELETE /api/tax-rates/:id — Soft delete (set Active='No')
router.delete('/tax-rates/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'ID_Account is required' });
    }

    try {
        console.log(`[Tax Rates] Soft delete (deactivate) ID_Account='${id}'`);
        await makeCaspioRequest('put', '/tables/sales_tax_accounts_2026/records',
            { 'q.where': `ID_Account='${id}'` }, { Active: 'No' });

        accountsCache.clear();

        res.json({
            success: true,
            message: `Tax account '${id}' deactivated (soft delete)`
        });
    } catch (error) {
        console.error(`[Tax Rates] Delete failed for ID_Account='${id}':`, error);

        if (error.message && error.message.includes('404')) {
            return res.status(404).json({ success: false, error: `Tax account '${id}' not found` });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to delete tax account',
            details: error.message
        });
    }
});

// ============================================
// Hybrid Lookup Endpoint
// ============================================

// POST /api/tax-rates/lookup — Hybrid DOR + Caspio lookup
router.post('/tax-rates/lookup', async (req, res) => {
    const { address, city, state, zip } = req.body;

    // Validate state
    const cleanState = sanitizeState(state);
    if (!cleanState) {
        return res.status(400).json({
            success: false,
            error: 'Valid 2-letter state code is required'
        });
    }

    // Step 1: Non-WA → Out of State
    if (cleanState !== 'WA') {
        return res.json({
            success: true,
            rate: 0,
            taxRate: 0,
            account: '2202',
            accountName: 'Out of State Sales',
            outOfState: true,
            source: 'static'
        });
    }

    // Validate ZIP for WA lookups
    const cleanZip = sanitizeZip(zip);
    if (!cleanZip) {
        return res.status(400).json({
            success: false,
            error: 'Valid 5-digit ZIP code is required for WA tax lookup'
        });
    }

    const cleanAddress = sanitizeAddress(address);
    const cleanCity = sanitizeAddress(city);
    const zip5 = cleanZip.substring(0, 5);

    // Step 2: Check DOR cache (keyed by ZIP)
    const cacheKey = zip5;
    const cached = dorCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < DOR_CACHE_TTL) {
        console.log(`[CACHE HIT] DOR tax rate for ZIP ${zip5}`);

        try {
            const accounts = await fetchTaxAccounts();
            const account = findAccountByRate(cached.rate, accounts);

            return res.json({
                success: true,
                rate: cached.rate,
                taxRate: parseFloat((cached.rate * 100).toFixed(1)),
                account: account ? account.Account_Number : '2200',
                accountName: account ? account.Account_Name : 'WA Sales Tax',
                locationCode: cached.locationCode,
                resultCode: cached.resultCode,
                source: 'cache'
            });
        } catch (error) {
            // If Caspio is down but we have cached DOR rate, still return it
            return res.json({
                success: true,
                rate: cached.rate,
                taxRate: parseFloat((cached.rate * 100).toFixed(1)),
                account: '2200',
                accountName: 'WA Sales Tax',
                locationCode: cached.locationCode,
                source: 'cache',
                accountMatchFailed: true
            });
        }
    }

    // Step 3: Call WA DOR API
    const dorResult = await callDorApi(cleanAddress, cleanCity, zip5);

    if (dorResult) {
        // Step 4a: Cache DOR result
        dorCache.set(cacheKey, {
            rate: dorResult.rate,
            locationCode: dorResult.locationCode,
            resultCode: dorResult.resultCode,
            timestamp: Date.now()
        });

        // Step 5: Match rate to Caspio account
        try {
            const accounts = await fetchTaxAccounts();
            const account = findAccountByRate(dorResult.rate, accounts);

            return res.json({
                success: true,
                rate: dorResult.rate,
                taxRate: parseFloat((dorResult.rate * 100).toFixed(1)),
                account: account ? account.Account_Number : '2200',
                accountName: account ? account.Account_Name : 'WA Sales Tax',
                locationCode: dorResult.locationCode,
                resultCode: dorResult.resultCode,
                source: 'dor',
                nearestMatch: account ? undefined : true
            });
        } catch (error) {
            // DOR succeeded but Caspio down — return DOR rate without account match
            return res.json({
                success: true,
                rate: dorResult.rate,
                taxRate: parseFloat((dorResult.rate * 100).toFixed(1)),
                account: '2200',
                accountName: 'WA Sales Tax',
                locationCode: dorResult.locationCode,
                source: 'dor',
                accountMatchFailed: true
            });
        }
    }

    // Step 4b: DOR failed → fallback to default WA rate
    console.warn('[Tax Rates] DOR API failed, using default WA rate 10.1%');

    try {
        const accounts = await fetchTaxAccounts();
        const defaultAccount = accounts.find(a => a.Account_Number === '2200');

        return res.json({
            success: true,
            rate: 0.101,
            taxRate: 10.1,
            account: '2200',
            accountName: defaultAccount ? defaultAccount.Account_Name : 'WA Sales Tax',
            fallback: true,
            error: 'DOR API unavailable — using default WA rate',
            source: 'fallback'
        });
    } catch (error) {
        // Everything is down — return hardcoded default
        return res.json({
            success: true,
            rate: 0.101,
            taxRate: 10.1,
            account: '2200',
            accountName: 'WA Sales Tax',
            fallback: true,
            error: 'DOR API and Caspio unavailable — using default WA rate',
            source: 'fallback'
        });
    }
});

module.exports = router;
