// Company Contacts routes — Search/CRUD against CompanyContactsMerge2026.
// API path stays /api/company-contacts/* and response/request payloads use
// the legacy field names (CustomerCompanyName, ContactNumbersEmail, …) so
// existing callers keep working unchanged. See OLD_TO_NEW map below for
// the schema-rename translation done internally on every read/write.
// Used for customer lookup/autocomplete in quote builders + AE intake forms.

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// Input validation helpers
function sanitizeSearchQuery(query) {
  if (!query || typeof query !== 'string') return null;
  // Remove special characters that could cause issues in Caspio WHERE clause
  const sanitized = query.replace(/['"\\%_]/g, '').trim();
  return (sanitized.length >= 2 && sanitized.length <= 100) ? sanitized : null;
}

function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) ? email : null;
}

function sanitizeId(id) {
  if (!id) return null;
  const numId = parseInt(id, 10);
  return (!isNaN(numId) && numId > 0) ? numId : null;
}

// Cache for contact searches (2 minute TTL - shorter since contacts can change)
const contactsCache = new Map();
const CONTACTS_CACHE_TTL = 2 * 60 * 1000;

// ─── Schema migration helpers ──────────────────────────────────────────
// All endpoints in this file now query the modern CompanyContactsMerge2026
// table. The legacy Company_Contacts_Merge_ODBC table no longer has these
// columns: Customersts_Active, Customerdate_LastOrdered, CustomerCompanyName,
// ContactNumbersEmail, CustomerCustomerServiceRep. We keep the API response
// shape in the OLD field names so existing callers (CustomerLookupService
// + 4 quote builders + Sticker/Banner/JDS forms + customer detail pages)
// don't need any changes.
const TABLE = 'CompanyContactsMerge2026';
const OLD_TO_NEW = {
    Customersts_Active:         'Is_Active',
    Customerdate_LastOrdered:   'Last_Order_Date',
    CustomerCompanyName:        'Company_Name',
    ContactNumbersEmail:        'Email',
    CustomerCustomerServiceRep: 'Sales_Rep'
};
const NEW_TO_OLD = Object.fromEntries(Object.entries(OLD_TO_NEW).map(([o, n]) => [n, o]));

/**
 * Map a Caspio record from the new schema to the legacy response shape so
 * callers keep working. Preserves any unmapped fields verbatim.
 */
function mapRecordToLegacyShape(r) {
    if (!r) return r;
    const out = { ...r };
    // Add legacy-named aliases (don't delete the new names — defensive in case
    // a caller upgraded to read the new names already).
    out.CustomerCompanyName        = r.Company_Name        || '';
    out.ContactNumbersEmail        = r.Email               || '';
    out.CustomerCustomerServiceRep = r.Sales_Rep           || '';
    out.Customerdate_LastOrdered   = r.Last_Order_Date     ?? null;
    out.Customersts_Active         = r.Is_Active;
    return out;
}

/**
 * Translate request body keys from the legacy schema to the new schema so
 * POST/PUT writes succeed. Pass-through for unmapped keys. Skips fields
 * we don't write to the new table (Account_Owner, DateLastOrderEmail —
 * presence on the new table not yet verified; safe to omit).
 */
function translateBodyToNewSchema(body) {
    if (!body || typeof body !== 'object') return body;
    const out = {};
    for (const [key, val] of Object.entries(body)) {
        if (Object.prototype.hasOwnProperty.call(OLD_TO_NEW, key)) {
            out[OLD_TO_NEW[key]] = val;
        } else {
            out[key] = val;
        }
    }
    // Drop fields that may not exist on the new table (verify before re-adding).
    delete out.Account_Owner;
    delete out.DateLastOrderEmail;
    return out;
}

/**
 * GET /api/company-contacts/search
 * Search for contacts by company name, contact name, or email
 * Query params:
 *   - q: Search term (required, min 2 chars)
 *   - limit: Max results to return (default 10, max 25)
 */
router.get('/company-contacts/search', async (req, res) => {
  const { q, limit, includeInactive } = req.query;

  console.log(`GET /api/company-contacts/search?q=${q}&limit=${limit}&includeInactive=${includeInactive}`);

  try {
    // Validate search query
    const searchTerm = sanitizeSearchQuery(q);
    if (!searchTerm) {
      return res.status(400).json({
        error: 'Invalid search query',
        hint: 'Query must be 2-100 characters, no special characters'
      });
    }

    // Parse and validate limit. Caspio v3 rejects q.limit < 5 with
    // IncorrectQueryParameter — floor at 5 server-side, then slice client-
    // side to honor the caller's true limit.
    const requestedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
    const maxResults = Math.max(requestedLimit, 5);

    // Check cache
    const activeFlag = includeInactive === 'true' ? 'all' : 'active';
    const cacheKey = `search:${searchTerm.toLowerCase()}:${maxResults}:${activeFlag}`;
    const cached = contactsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CONTACTS_CACHE_TTL) {
      console.log(`Cache HIT for contacts search: ${cacheKey}`);
      return res.json({ contacts: cached.data, fromCache: true });
    }

    // Query the modern CompanyContactsMerge2026 table (the legacy
    // Company_Contacts_Merge_ODBC table is gone — its column names like
    // Customersts_Active and Customerdate_LastOrdered no longer exist on
    // the live schema, so the old query 400'd with "Invalid column name").
    // Field translation table:
    //   Customersts_Active        → Is_Active
    //   Customerdate_LastOrdered  → Last_Order_Date
    //   CustomerCompanyName       → Company_Name
    //   ContactNumbersEmail       → Email
    //   CustomerCustomerServiceRep→ Sales_Rep
    // Response shape stays in the OLD field names so existing callers
    // (CustomerLookupService used by 4 quote builders + Sticker/Banner +
    // JDS intake forms) keep working without a frontend change.
    const activeFilter = includeInactive === 'true' ? '' : 'Is_Active=1 AND ';
    const whereClause = `${activeFilter}(Company_Name LIKE '%${searchTerm}%' OR ct_NameFull LIKE '%${searchTerm}%' OR Email LIKE '%${searchTerm}%')`;

    const params = {
      'q.where': whereClause,
      'q.orderBy': 'Last_Order_Date DESC', // Most recent customers first
      'q.limit': maxResults
    };

    console.log('Caspio query params:', JSON.stringify(params));

    const records = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', params, {
      maxPages: 1 // Only need first page for autocomplete
    });

    // Slice to the caller's true limit (we may have requested 5 from Caspio
    // when the caller asked for 1-4 due to v3 q.limit floor).
    const sliced = records.slice(0, requestedLimit);

    // Map new schema → legacy response shape so frontend stays unchanged.
    const contacts = sliced.map(r => ({
      ID_Contact: r.ID_Contact,
      id_Customer: r.id_Customer,
      CustomerCompanyName: r.Company_Name || '',
      ct_NameFull: r.ct_NameFull || '',
      ContactNumbersEmail: r.Email || '',
      CustomerCustomerServiceRep: r.Sales_Rep || '',
      Address: r.Address || '',
      City: r.City || '',
      State: r.State || '',
      Zip: r.Zip || '',
      Customerdate_LastOrdered: r.Last_Order_Date
    }));

    console.log(`Contacts search: ${contacts.length} result(s) found for "${searchTerm}"`);

    // Store in cache
    contactsCache.set(cacheKey, {
      data: contacts,
      timestamp: Date.now()
    });

    // Limit cache size
    if (contactsCache.size > 200) {
      const firstKey = contactsCache.keys().next().value;
      contactsCache.delete(firstKey);
    }

    res.json({ contacts });

  } catch (error) {
    console.error('Error searching contacts:', error.message);
    res.status(500).json({
      error: 'Failed to search contacts',
      details: error.message
    });
  }
});

/**
 * GET /api/company-contacts/by-company
 * Get contacts by company name (exact match for mockup auto-populate +
 * Stage 2 of CompanyContactPicker on the AE intake forms).
 * Query params:
 *   - company: Company name (required)
 *   - limit: Max results (default 5, max 25)
 *
 * Cap raised from 10 → 25 on 2026-05-08 — CompanyContactPicker Stage 2
 * needs to show all contacts at companies like NWCA itself (13+ active
 * contacts). 10 was an arbitrary low cap, no good reason to keep it.
 */
router.get('/company-contacts/by-company', async (req, res) => {
  const { company, limit } = req.query;

  console.log(`GET /api/company-contacts/by-company?company=${company}`);

  try {
    if (!company || typeof company !== 'string' || company.trim().length < 2) {
      return res.status(400).json({
        error: 'Invalid company name',
        hint: 'Company name must be at least 2 characters'
      });
    }

    const sanitized = company.replace(/['"\\%_]/g, '').trim();
    if (!sanitized) {
      return res.status(400).json({ error: 'Invalid company name after sanitization' });
    }

    // Caspio v3 rejects q.limit < 5; floor server-side, slice client-side.
    const requestedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 25);
    const maxResults = Math.max(requestedLimit, 5);

    // Check cache (keyed on requestedLimit so caller-visible behavior matches)
    const cacheKey = `bycompany:${sanitized.toLowerCase()}:${requestedLimit}`;
    const cached = contactsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CONTACTS_CACHE_TTL) {
      console.log(`Cache HIT for by-company: ${cacheKey}`);
      return res.json({ contacts: cached.data, fromCache: true });
    }

    // CompanyContactsMerge2026 table (see search endpoint comment for
    // schema migration notes). Exact match on company name, active only.
    const whereClause = `Is_Active=1 AND Company_Name='${sanitized}'`;

    const records = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', {
      'q.where': whereClause,
      'q.orderBy': 'Last_Order_Date DESC',
      'q.limit': maxResults
    }, { maxPages: 1 });

    // Slice to the caller's true limit (Caspio may have returned up to 5).
    const sliced = records.slice(0, requestedLimit);

    // Map new schema → simplified shape (caller-facing fields unchanged).
    const contacts = sliced.map(r => ({
      name: r.ct_NameFull || '',
      email: r.Email || '',
      company: r.Company_Name || '',
      id_Customer: r.id_Customer
    })).filter(c => c.email); // Only return contacts with email

    console.log(`By-company lookup: ${contacts.length} contacts for "${sanitized}"`);

    // Cache
    contactsCache.set(cacheKey, { data: contacts, timestamp: Date.now() });
    if (contactsCache.size > 200) {
      const firstKey = contactsCache.keys().next().value;
      contactsCache.delete(firstKey);
    }

    res.json({ contacts });

  } catch (error) {
    console.error('Error fetching contacts by company:', error.message);
    res.status(500).json({
      error: 'Failed to fetch contacts by company',
      details: error.message
    });
  }
});

/**
 * GET /api/company-contacts/:id
 * Get a single contact by ID_Contact
 */
router.get('/company-contacts/:id', async (req, res) => {
  const { id } = req.params;

  console.log(`GET /api/company-contacts/${id}`);

  try {
    const contactId = sanitizeId(id);
    if (!contactId) {
      return res.status(400).json({
        error: 'Invalid contact ID',
        hint: 'ID must be a positive integer'
      });
    }

    const records = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `ID_Contact=${contactId}`,
      'q.limit': 5
    }, { maxPages: 1 });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = mapRecordToLegacyShape(records[0]);
    console.log(`Contact ${contactId} retrieved: ${contact.CustomerCompanyName}`);

    res.json({ contact });

  } catch (error) {
    console.error('Error fetching contact:', error.message);
    res.status(500).json({
      error: 'Failed to fetch contact',
      details: error.message
    });
  }
});

/**
 * POST /api/company-contacts
 * Create a new contact
 */
router.post('/company-contacts', express.json(), async (req, res) => {
  console.log('POST /api/company-contacts with body:', JSON.stringify(req.body));

  try {
    const {
      CustomerCompanyName,
      NameFirst,
      NameLast,
      ContactNumbersEmail,
      id_Customer
    } = req.body;

    // Validate required fields
    if (!CustomerCompanyName && !NameFirst && !NameLast) {
      return res.status(400).json({
        error: 'At least one of CustomerCompanyName, NameFirst, or NameLast is required'
      });
    }

    // Build contact data — accept legacy field names from callers, write
    // with new schema names. Translation map handles the rename internally.
    const legacyShaped = {
      ...req.body,
      // Auto-generate ct_NameFull if first/last provided
      ct_NameFull: req.body.ct_NameFull ||
        [NameFirst, NameLast].filter(Boolean).join(' ') || '',
      // Set as active by default
      Customersts_Active: req.body.Customersts_Active ?? 1,
      // Set last ordered date if not provided
      Customerdate_LastOrdered: req.body.Customerdate_LastOrdered || new Date().toISOString()
    };
    const contactData = translateBodyToNewSchema(legacyShaped);

    const result = await makeCaspioRequest('post', `/tables/${TABLE}/records`, {}, contactData);

    console.log('Contact created successfully');
    res.status(201).json({
      success: true,
      message: 'Contact created successfully',
      result
    });

  } catch (error) {
    console.error('Error creating contact:', error.message);
    res.status(500).json({
      error: 'Failed to create contact',
      details: error.message
    });
  }
});

/**
 * PUT /api/company-contacts/:id
 * Update an existing contact
 */
router.put('/company-contacts/:id', express.json(), async (req, res) => {
  const { id } = req.params;

  console.log(`PUT /api/company-contacts/${id} with body:`, JSON.stringify(req.body));

  try {
    const contactId = sanitizeId(id);
    if (!contactId) {
      return res.status(400).json({
        error: 'Invalid contact ID',
        hint: 'ID must be a positive integer'
      });
    }

    // Remove fields that shouldn't be updated
    const updates = { ...req.body };
    delete updates.ID_Contact;
    delete updates.PK_ID;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Auto-update ct_NameFull if names changed
    if ((updates.NameFirst !== undefined || updates.NameLast !== undefined) && !updates.ct_NameFull) {
      // Fetch current record to get existing name parts
      const existing = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
        'q.where': `ID_Contact=${contactId}`,
        'q.limit': 5
      }, { maxPages: 1 });

      if (existing.length > 0) {
        const firstName = updates.NameFirst ?? existing[0].NameFirst ?? '';
        const lastName = updates.NameLast ?? existing[0].NameLast ?? '';
        updates.ct_NameFull = [firstName, lastName].filter(Boolean).join(' ');
      }
    }

    // Translate legacy field names in the update payload to the new schema.
    const translatedUpdates = translateBodyToNewSchema(updates);

    const result = await makeCaspioRequest('put', `/tables/${TABLE}/records`,
      { 'q.where': `ID_Contact=${contactId}` },
      translatedUpdates
    );

    console.log(`Contact ${contactId} updated successfully`);

    // Clear cache for this contact
    for (const key of contactsCache.keys()) {
      contactsCache.delete(key);
    }

    res.json({
      success: true,
      message: 'Contact updated successfully',
      result
    });

  } catch (error) {
    console.error('Error updating contact:', error.message);
    res.status(500).json({
      error: 'Failed to update contact',
      details: error.message
    });
  }
});

/**
 * GET /api/company-contacts/by-customer/:customerId
 * Get contacts by customer ID (id_Customer)
 */
router.get('/company-contacts/by-customer/:customerId', async (req, res) => {
  const { customerId } = req.params;

  console.log(`GET /api/company-contacts/by-customer/${customerId}`);

  try {
    const custId = sanitizeId(customerId);
    if (!custId) {
      return res.status(400).json({
        error: 'Invalid customer ID',
        hint: 'ID must be a positive integer'
      });
    }

    const records = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `id_Customer=${custId} AND Is_Active=1`,
      'q.orderBy': 'Last_Order_Date DESC'
    });

    console.log(`Found ${records.length} contacts for customer ${custId}`);

    // Map to legacy response shape so callers see CustomerCompanyName etc.
    const contacts = records.map(mapRecordToLegacyShape);
    res.json({ contacts });

  } catch (error) {
    console.error('Error fetching contacts by customer:', error.message);
    res.status(500).json({
      error: 'Failed to fetch contacts',
      details: error.message
    });
  }
});

/**
 * GET /api/company-contacts/by-email/:email
 * Get contact by email address
 */
router.get('/company-contacts/by-email/:email', async (req, res) => {
  const { email } = req.params;

  console.log(`GET /api/company-contacts/by-email/${email}`);

  try {
    const sanitizedEmail = sanitizeEmail(email);
    if (!sanitizedEmail) {
      return res.status(400).json({
        error: 'Invalid email address'
      });
    }

    const records = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `Email='${sanitizedEmail}'`,
      'q.limit': 5
    }, { maxPages: 1 });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = mapRecordToLegacyShape(records[0]);
    console.log(`Found contact for email ${sanitizedEmail}: ${contact.CustomerCompanyName}`);

    res.json({ contact });

  } catch (error) {
    console.error('Error fetching contact by email:', error.message);
    res.status(500).json({
      error: 'Failed to fetch contact',
      details: error.message
    });
  }
});

/**
 * POST /api/company-contacts/sync
 * Sync contacts from recent ManageOrders orders to Caspio
 * Called by Heroku Scheduler job
 */
router.post('/company-contacts/sync', express.json(), async (req, res) => {
  console.log('POST /api/company-contacts/sync - Starting sync from ManageOrders');

  const stats = {
    ordersProcessed: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    contactsSkipped: 0,
    errors: []
  };

  try {
    // Get hours back from query param or default to 24
    const hoursBack = parseInt(req.query.hours) || 24;

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (hoursBack * 60 * 60 * 1000));

    const formatDate = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    console.log(`Syncing contacts from orders between ${formatDate(startDate)} and ${formatDate(endDate)}`);

    // Fetch recent orders from ManageOrders via internal API call
    const axios = require('axios');
    const baseUrl = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3002);

    const ordersResponse = await axios.get(`${baseUrl}/api/manageorders/orders`, {
      params: {
        date_Invoiced_start: formatDate(startDate),
        date_Invoiced_end: formatDate(endDate)
      },
      timeout: 120000 // 2 minute timeout
    });

    const orders = ordersResponse.data?.result || [];
    console.log(`Found ${orders.length} orders to process`);

    // Pre-fetch Sales_Reps_2026 (used for the Account_Owner overlay if/when
    // that column exists on CompanyContactsMerge2026). We collect the mapping
    // either way; translateBodyToNewSchema will drop Account_Owner from the
    // payload until we confirm the column is present on the new table.
    const salesReps2026 = await fetchAllCaspioPages('/tables/Sales_Reps_2026/records', {});
    const salesRepsMap = new Map();
    salesReps2026.forEach(r => {
      if (r.ID_Customer && r.CustomerServiceRep) {
        salesRepsMap.set(r.ID_Customer, r.CustomerServiceRep);
      }
    });
    console.log(`Loaded ${salesRepsMap.size} account owner mappings from Sales_Reps_2026`);

    // Process each order — extract unique contacts by id_Customer + email.
    // Build with NEW schema field names so writes to CompanyContactsMerge2026
    // succeed without per-call translation.
    const contactsToSync = new Map();

    for (const order of orders) {
      stats.ordersProcessed++;

      if (!order.id_Customer) {
        stats.contactsSkipped++;
        continue;
      }

      const contactKey = `${order.id_Customer}_${order.ContactEmail || 'no-email'}`;

      if (!contactsToSync.has(contactKey)) {
        contactsToSync.set(contactKey, {
          id_Customer: order.id_Customer,
          Company_Name: order.CustomerName || '',
          NameFirst: order.ContactFirstName || '',
          NameLast: order.ContactLastName || '',
          ct_NameFull: [order.ContactFirstName, order.ContactLastName].filter(Boolean).join(' ') || '',
          Email: order.ContactEmail || '',
          Sales_Rep: order.CustomerServiceRepName || '',
          // Account_Owner is captured here for diagnostic logging only — it's
          // stripped from the actual write payload by translateBodyToNewSchema
          // until we verify the column exists on CompanyContactsMerge2026.
          Account_Owner: salesRepsMap.get(order.id_Customer) || '',
          Address: order.ShipAddress || '',
          City: order.ShipCity || '',
          State: order.ShipState || '',
          Zip: order.ShipZip || '',
          Last_Order_Date: order.date_Invoiced || new Date().toISOString(),
          Is_Active: 1
        });
      }
    }

    console.log(`Processing ${contactsToSync.size} unique contacts`);

    // Track which companies need company-wide updates (rep or company name changed)
    const companyUpdates = new Map(); // id_Customer -> { Company_Name?, Sales_Rep?, Account_Owner? }

    // Upsert each contact to Caspio (using EMAIL as unique key)
    for (const [key, contactData] of contactsToSync) {
      try {
        if (!contactData.Email) {
          console.log(`Skipping contact without email for customer ${contactData.id_Customer}`);
          stats.contactsSkipped++;
          continue;
        }

        // Check if contact exists by EMAIL (unique key) on the new table.
        const existingRecords = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
          'q.where': `Email='${contactData.Email}'`,
          'q.limit': 5
        }, { maxPages: 1 });

        if (existingRecords.length > 0) {
          // Update existing contact — refresh last-ordered date + active flag.
          const existing = existingRecords[0];
          const updates = {
            Last_Order_Date: contactData.Last_Order_Date,
            Is_Active: 1
          };

          // Update name if empty in existing record
          if (!existing.ct_NameFull && contactData.ct_NameFull) {
            updates.ct_NameFull = contactData.ct_NameFull;
            updates.NameFirst = contactData.NameFirst;
            updates.NameLast = contactData.NameLast;
          }

          // Account_Owner overlay (kept on the diff so logs show the intent).
          // translateBodyToNewSchema will strip it before the network call.
          if (contactData.Account_Owner) {
            updates.Account_Owner = contactData.Account_Owner;
          }

          // Check if company-wide fields changed (rep or company name)
          if (contactData.Sales_Rep && existing.Sales_Rep !== contactData.Sales_Rep) {
            companyUpdates.set(existing.id_Customer, {
              ...(companyUpdates.get(existing.id_Customer) || {}),
              Sales_Rep: contactData.Sales_Rep
            });
          }
          if (contactData.Company_Name && existing.Company_Name !== contactData.Company_Name) {
            companyUpdates.set(existing.id_Customer, {
              ...(companyUpdates.get(existing.id_Customer) || {}),
              Company_Name: contactData.Company_Name
            });
          }
          if (contactData.Account_Owner && existing.Account_Owner !== contactData.Account_Owner) {
            companyUpdates.set(existing.id_Customer, {
              ...(companyUpdates.get(existing.id_Customer) || {}),
              Account_Owner: contactData.Account_Owner
            });
          }

          await makeCaspioRequest('put', `/tables/${TABLE}/records`,
            { 'q.where': `ID_Contact=${existing.ID_Contact}` },
            translateBodyToNewSchema(updates)
          );

          stats.contactsUpdated++;
          console.log(`Updated contact: ${contactData.Email} (${contactData.ct_NameFull})`);

        } else {
          // Create new contact (translate to drop unknown fields like Account_Owner).
          await makeCaspioRequest('post', `/tables/${TABLE}/records`, {}, translateBodyToNewSchema(contactData));
          stats.contactsCreated++;
          console.log(`Created contact: ${contactData.Email} (${contactData.ct_NameFull}) for customer ${contactData.id_Customer}`);
        }

      } catch (contactError) {
        stats.errors.push({
          contact: contactData.Email || contactData.id_Customer,
          error: contactError.message
        });
        console.error(`Error syncing contact ${contactData.Email}:`, contactError.message);
      }
    }

    // Apply company-wide updates (rep or company name changes affect ALL contacts for that company)
    stats.companyWideUpdates = 0;
    for (const [customerId, updates] of companyUpdates) {
      try {
        console.log(`Applying company-wide update for id_Customer ${customerId}:`, updates);
        await makeCaspioRequest('put', `/tables/${TABLE}/records`,
          { 'q.where': `id_Customer=${customerId}` },
          translateBodyToNewSchema(updates)
        );
        stats.companyWideUpdates++;
        console.log(`Updated all contacts for company ${customerId} with:`, updates);
      } catch (err) {
        stats.errors.push({
          contact: `Company ${customerId}`,
          error: `Company-wide update failed: ${err.message}`
        });
        console.error(`Error updating company ${customerId}:`, err.message);
      }
    }

    // Clear contact search cache after sync
    contactsCache.clear();

    console.log('Sync complete:', JSON.stringify(stats));

    res.json({
      success: true,
      message: `Synced ${stats.contactsCreated + stats.contactsUpdated} contacts (${stats.contactsCreated} new, ${stats.contactsUpdated} updated, ${stats.companyWideUpdates || 0} company-wide updates)`,
      stats
    });

  } catch (error) {
    console.error('Error in contacts sync:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to sync contacts',
      details: error.message,
      stats
    });
  }
});

module.exports = router;
