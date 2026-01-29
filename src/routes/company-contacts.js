// Company Contacts routes - Search/CRUD for Company_Contacts_Merge_ODBC table
// Used for customer lookup/autocomplete in quote builders

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

/**
 * GET /api/company-contacts/search
 * Search for contacts by company name, contact name, or email
 * Query params:
 *   - q: Search term (required, min 2 chars)
 *   - limit: Max results to return (default 10, max 25)
 */
router.get('/company-contacts/search', async (req, res) => {
  const { q, limit } = req.query;

  console.log(`GET /api/company-contacts/search?q=${q}&limit=${limit}`);

  try {
    // Validate search query
    const searchTerm = sanitizeSearchQuery(q);
    if (!searchTerm) {
      return res.status(400).json({
        error: 'Invalid search query',
        hint: 'Query must be 2-100 characters, no special characters'
      });
    }

    // Parse and validate limit
    const maxResults = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);

    // Check cache
    const cacheKey = `search:${searchTerm.toLowerCase()}:${maxResults}`;
    const cached = contactsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CONTACTS_CACHE_TTL) {
      console.log(`Cache HIT for contacts search: ${cacheKey}`);
      return res.json({ contacts: cached.data, fromCache: true });
    }

    // Build Caspio WHERE clause - search multiple fields
    // Filter to active customers only (Customersts_Active = 1)
    const whereClause = `Customersts_Active=1 AND (CustomerCompanyName LIKE '%${searchTerm}%' OR ct_NameFull LIKE '%${searchTerm}%' OR ContactNumbersEmail LIKE '%${searchTerm}%')`;

    const params = {
      'q.where': whereClause,
      'q.sort': 'Customerdate_LastOrdered DESC', // Most recent customers first
      'q.limit': maxResults
    };

    console.log('Caspio query params:', JSON.stringify(params));

    const records = await fetchAllCaspioPages('/tables/Company_Contacts_Merge_ODBC/records', params, {
      maxPages: 1 // Only need first page for autocomplete
    });

    // Map to response format with only needed fields
    const contacts = records.map(r => ({
      ID_Contact: r.ID_Contact,
      id_Customer: r.id_Customer,
      CustomerCompanyName: r.CustomerCompanyName || '',
      ct_NameFull: r.ct_NameFull || '',
      ContactNumbersEmail: r.ContactNumbersEmail || '',
      CustomerCustomerServiceRep: r.CustomerCustomerServiceRep || '',
      Address: r.Address || '',
      City: r.City || '',
      State: r.State || '',
      Zip: r.Zip || '',
      Customerdate_LastOrdered: r.Customerdate_LastOrdered
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

    const records = await fetchAllCaspioPages('/tables/Company_Contacts_Merge_ODBC/records', {
      'q.where': `ID_Contact=${contactId}`
    }, { maxPages: 1 });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = records[0];
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

    // Build contact data
    const contactData = {
      ...req.body,
      // Auto-generate ct_NameFull if first/last provided
      ct_NameFull: req.body.ct_NameFull ||
        [NameFirst, NameLast].filter(Boolean).join(' ') || '',
      // Set as active by default
      Customersts_Active: req.body.Customersts_Active ?? 1,
      // Set last ordered date if not provided
      Customerdate_LastOrdered: req.body.Customerdate_LastOrdered || new Date().toISOString()
    };

    const result = await makeCaspioRequest('post', '/tables/Company_Contacts_Merge_ODBC/records', {}, contactData);

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
      const existing = await fetchAllCaspioPages('/tables/Company_Contacts_Merge_ODBC/records', {
        'q.where': `ID_Contact=${contactId}`
      }, { maxPages: 1 });

      if (existing.length > 0) {
        const firstName = updates.NameFirst ?? existing[0].NameFirst ?? '';
        const lastName = updates.NameLast ?? existing[0].NameLast ?? '';
        updates.ct_NameFull = [firstName, lastName].filter(Boolean).join(' ');
      }
    }

    const result = await makeCaspioRequest('put', '/tables/Company_Contacts_Merge_ODBC/records',
      { 'q.where': `ID_Contact=${contactId}` },
      updates
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

    const records = await fetchAllCaspioPages('/tables/Company_Contacts_Merge_ODBC/records', {
      'q.where': `id_Customer=${custId} AND Customersts_Active=1`,
      'q.sort': 'Customerdate_LastOrdered DESC'
    });

    console.log(`Found ${records.length} contacts for customer ${custId}`);

    res.json({ contacts: records });

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

    const records = await fetchAllCaspioPages('/tables/Company_Contacts_Merge_ODBC/records', {
      'q.where': `ContactNumbersEmail='${sanitizedEmail}'`
    }, { maxPages: 1 });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    console.log(`Found contact for email ${sanitizedEmail}: ${records[0].CustomerCompanyName}`);

    res.json({ contact: records[0] });

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

    // Process each order - extract unique contacts by id_Customer
    const contactsToSync = new Map();

    for (const order of orders) {
      stats.ordersProcessed++;

      // Skip if no customer ID
      if (!order.id_Customer) {
        stats.contactsSkipped++;
        continue;
      }

      // Build contact data from order
      const contactKey = `${order.id_Customer}_${order.ContactEmail || 'no-email'}`;

      // Only process if we haven't seen this contact yet, or if this order is newer
      if (!contactsToSync.has(contactKey)) {
        contactsToSync.set(contactKey, {
          id_Customer: order.id_Customer,
          CustomerCompanyName: order.CustomerName || '',
          NameFirst: order.ContactFirstName || '',
          NameLast: order.ContactLastName || '',
          ct_NameFull: [order.ContactFirstName, order.ContactLastName].filter(Boolean).join(' ') || '',
          ContactNumbersEmail: order.ContactEmail || '',
          CustomerCustomerServiceRep: order.CustomerServiceRepName || '',
          Address: order.ShipAddress || '',
          City: order.ShipCity || '',
          State: order.ShipState || '',
          Zip: order.ShipZip || '',
          Customerdate_LastOrdered: order.date_Invoiced || new Date().toISOString(),
          Customersts_Active: 1
        });
      }
    }

    console.log(`Processing ${contactsToSync.size} unique contacts`);

    // Upsert each contact to Caspio
    for (const [key, contactData] of contactsToSync) {
      try {
        // Check if contact exists by id_Customer
        const existingRecords = await fetchAllCaspioPages('/tables/Company_Contacts_Merge_ODBC/records', {
          'q.where': `id_Customer=${contactData.id_Customer}`
        }, { maxPages: 1 });

        if (existingRecords.length > 0) {
          // Update existing contact - only update last ordered date and rep if newer
          const existing = existingRecords[0];
          const updates = {
            Customerdate_LastOrdered: contactData.Customerdate_LastOrdered,
            Customersts_Active: 1
          };

          // Update other fields if they're empty in existing record
          if (!existing.CustomerCompanyName && contactData.CustomerCompanyName) {
            updates.CustomerCompanyName = contactData.CustomerCompanyName;
          }
          if (!existing.ct_NameFull && contactData.ct_NameFull) {
            updates.ct_NameFull = contactData.ct_NameFull;
            updates.NameFirst = contactData.NameFirst;
            updates.NameLast = contactData.NameLast;
          }
          if (!existing.ContactNumbersEmail && contactData.ContactNumbersEmail) {
            updates.ContactNumbersEmail = contactData.ContactNumbersEmail;
          }

          await makeCaspioRequest('put', '/tables/Company_Contacts_Merge_ODBC/records',
            { 'q.where': `ID_Contact=${existing.ID_Contact}` },
            updates
          );

          stats.contactsUpdated++;
          console.log(`Updated contact: ${contactData.CustomerCompanyName || contactData.ct_NameFull} (id_Customer: ${contactData.id_Customer})`);

        } else {
          // Create new contact
          await makeCaspioRequest('post', '/tables/Company_Contacts_Merge_ODBC/records', {}, contactData);
          stats.contactsCreated++;
          console.log(`Created contact: ${contactData.CustomerCompanyName || contactData.ct_NameFull} (id_Customer: ${contactData.id_Customer})`);
        }

      } catch (contactError) {
        stats.errors.push({
          contact: contactData.CustomerCompanyName || contactData.id_Customer,
          error: contactError.message
        });
        console.error(`Error syncing contact ${contactData.id_Customer}:`, contactError.message);
      }
    }

    // Clear contact search cache after sync
    contactsCache.clear();

    console.log('Sync complete:', JSON.stringify(stats));

    res.json({
      success: true,
      message: `Synced ${stats.contactsCreated + stats.contactsUpdated} contacts (${stats.contactsCreated} new, ${stats.contactsUpdated} updated)`,
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
