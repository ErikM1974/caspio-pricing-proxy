// Company Contacts 2026 routes - Search for CompanyContactsMerge2026 table
// Used by the Online Order Form for company-name autocomplete (auto-fills phone/name/email/address).
// Sibling to company-contacts.js (older Company_Contacts_Merge_ODBC table) — different field names.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

function sanitizeSearchQuery(query) {
  if (!query || typeof query !== 'string') return null;
  const sanitized = query.replace(/['"\\%_]/g, '').trim();
  return (sanitized.length >= 2 && sanitized.length <= 100) ? sanitized : null;
}

const contactsCache = new Map();
const CONTACTS_CACHE_TTL = 2 * 60 * 1000;

/**
 * GET /api/company-contacts-2026/search
 * Search CompanyContactsMerge2026 by company name, contact name, or email.
 * Query params:
 *   - q: Search term (required, 2-100 chars)
 *   - limit: Max results (default 10, clamped 1-25)
 *   - includeInactive: 'true' to disable Is_Active=1 filter (default off)
 */
router.get('/company-contacts-2026/search', async (req, res) => {
  const { q, limit, includeInactive } = req.query;

  console.log(`GET /api/company-contacts-2026/search?q=${q}&limit=${limit}&includeInactive=${includeInactive}`);

  try {
    const searchTerm = sanitizeSearchQuery(q);
    if (!searchTerm) {
      return res.status(400).json({
        error: 'Invalid search query',
        hint: 'Query must be 2-100 characters, no special characters'
      });
    }

    const maxResults = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);

    const activeFlag = includeInactive === 'true' ? 'all' : 'active';
    const cacheKey = `search:v2:${searchTerm.toLowerCase()}:${maxResults}:${activeFlag}`;
    const cached = contactsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CONTACTS_CACHE_TTL) {
      console.log(`Cache HIT for contacts-2026 search: ${cacheKey}`);
      return res.json({ companies: cached.data, fromCache: true });
    }

    const activeFilter = includeInactive === 'true' ? '' : 'Is_Active=1 AND ';
    const whereClause = `${activeFilter}(Company_Name LIKE '%${searchTerm}%' OR ct_NameFull LIKE '%${searchTerm}%' OR Email LIKE '%${searchTerm}%')`;

    // Pull up to 80 contact rows so we don't drop members of large companies (e.g. Arrow has 9+).
    // We then group client-side and slice to top maxResults companies.
    const params = {
      'q.where': whereClause,
      'q.sort': 'Last_Order_Date DESC',
      'q.limit': 80
    };

    console.log('Caspio query params:', JSON.stringify(params));

    const records = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', params, {
      maxPages: 1
    });

    // Group by id_Customer. Most-recent contact wins for company-level fields
    // (records arrive sorted by Last_Order_Date DESC, so first sighting per id_Customer is freshest).
    const byCompany = new Map();
    for (const r of records) {
      const key = r.id_Customer;
      if (key == null) continue;
      let bucket = byCompany.get(key);
      if (!bucket) {
        bucket = {
          id_Customer: r.id_Customer,
          Company_Name: r.Company_Name || '',
          Company_Phone: r.Company_Phone || '',
          Address: r.Address || '',
          City: r.City || '',
          State: r.State || '',
          Zip: r.Zip || '',
          Sales_Rep: r.Sales_Rep || '',
          Last_Order_Date: r.Last_Order_Date || null,
          contacts: []
        };
        byCompany.set(key, bucket);
      }
      // Only include emailable contacts in the picker — picking a contact you can't reach is pointless.
      if (r.Email) {
        bucket.contacts.push({
          ID_Contact: r.ID_Contact,
          NameFirst: r.NameFirst || '',
          NameLast: r.NameLast || '',
          ct_NameFull: r.ct_NameFull || '',
          Email: r.Email || '',
          Last_Order_Date: r.Last_Order_Date || null
        });
      }
    }

    // Companies sorted by their most-recent Last_Order_Date (matches the freshness sort users expect).
    const companies = Array.from(byCompany.values())
      .sort((a, b) => {
        const ad = a.Last_Order_Date ? Date.parse(a.Last_Order_Date) : 0;
        const bd = b.Last_Order_Date ? Date.parse(b.Last_Order_Date) : 0;
        return bd - ad;
      })
      .slice(0, maxResults);

    console.log(`contacts-2026 search: ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} for "${searchTerm}" (from ${records.length} contact rows)`);

    contactsCache.set(cacheKey, { data: companies, timestamp: Date.now() });
    if (contactsCache.size > 200) {
      const firstKey = contactsCache.keys().next().value;
      contactsCache.delete(firstKey);
    }

    res.json({ companies });

  } catch (error) {
    console.error('Error searching contacts-2026:', error.message);
    res.status(500).json({
      error: 'Failed to search contacts',
      details: error.message
    });
  }
});

module.exports = router;
