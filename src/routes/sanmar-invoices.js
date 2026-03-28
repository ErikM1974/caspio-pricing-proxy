// ==========================================
// SanMar Invoice Routes
// ==========================================
// Provides invoice data from SanMar for cost tracking and margin analysis.
//
// Endpoints:
//   GET  /api/sanmar-invoices/by-po/:po       — Invoice for a specific PO
//   GET  /api/sanmar-invoices/by-date          — Invoices by date range
//   GET  /api/sanmar-invoices/unpaid           — All unpaid invoices
//   GET  /api/sanmar-invoices/incremental      — New invoices since last pull
//   POST /api/sanmar-invoices/sync             — Nightly invoice sync (Heroku Scheduler)

const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');
const {
  ENDPOINTS,
  getStandardAuth, validateAuth, xmlEscape,
  makeSoapRequest, checkSoapError,
  parseInvoiceResponse
} = require('../utils/sanmar-soap');
const { makeCaspioRequest } = require('../utils/caspio');

const invoiceCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 min cache

const TABLES = {
  invoices: 'SanMar_Invoices',
  invoiceItems: 'SanMar_Invoice_Items',
  orderItems: 'SanMar_Order_Items'
};

// Standard SanMar namespace
const STANDARD_NS = 'http://webservice.integration.sanmar.com/';

// ── Helper: Build standard invoice SOAP envelope ──
function buildInvoiceRequest(methodName, methodBody) {
  const auth = getStandardAuth();
  return `<web:${methodName} xmlns:web="${STANDARD_NS}">
      <web:CustomerNo>${xmlEscape(auth.customerNumber)}</web:CustomerNo>
      <web:UserName>${xmlEscape(auth.username)}</web:UserName>
      <web:Password>${xmlEscape(auth.password)}</web:Password>
      ${methodBody}
    </web:${methodName}>`;
}

// ── GET /by-po/:po — Invoice for a specific PO ──
router.get('/by-po/:po', async (req, res) => {
  const po = req.params.po;
  const cacheKey = `sanmar-invoice-po-${po}`;
  const cached = invoiceCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const auth = getStandardAuth();
    if (!auth.customerNumber) {
      return res.status(500).json({ error: 'SanMar customer number not configured (SANMAR_CUSTOMER_NUMBER env var)' });
    }

    const soapBody = buildInvoiceRequest('GetInvoiceByPurchaseOrderNo',
      `<web:PurchaseOrderNo>${xmlEscape(po)}</web:PurchaseOrderNo>`
    );

    const xml = await makeSoapRequest(ENDPOINTS.standardInvoice, soapBody, {
      timeout: 30000,
      namespaces: { web: STANDARD_NS }
    });

    const soapError = checkSoapError(xml);
    if (soapError) {
      if (soapError.message === 'Data not found') {
        return res.json({ invoices: [], message: 'No invoices found for this PO' });
      }
      return res.status(400).json({ error: soapError.message });
    }

    const invoices = parseInvoiceResponse(xml);
    const result = { purchaseOrder: po, invoices, fetchedAt: new Date().toISOString() };
    invoiceCache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error(`Error fetching SanMar invoice for PO ${po}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch invoice', details: error.message });
  }
});

// ── GET /by-date — Invoices by date range (max 3 months) ──
router.get('/by-date', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end date parameters required (YYYY-MM-DD)' });
  }

  const cacheKey = `sanmar-invoices-${start}-${end}`;
  const cached = invoiceCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const auth = getStandardAuth();
    if (!auth.customerNumber) {
      return res.status(500).json({ error: 'SanMar customer number not configured' });
    }

    const soapBody = buildInvoiceRequest('GetInvoicesByInvoiceDateRange',
      `<web:StartDate>${xmlEscape(start)}</web:StartDate>
       <web:EndDate>${xmlEscape(end)}</web:EndDate>`
    );

    const xml = await makeSoapRequest(ENDPOINTS.standardInvoice, soapBody, {
      timeout: 60000,
      namespaces: { web: STANDARD_NS }
    });

    const soapError = checkSoapError(xml);
    if (soapError) {
      if (soapError.message === 'Data not found') {
        return res.json({ invoices: [], message: 'No invoices in date range' });
      }
      return res.status(400).json({ error: soapError.message });
    }

    const invoices = parseInvoiceResponse(xml);
    const result = { dateRange: { start, end }, invoices, count: invoices.length, fetchedAt: new Date().toISOString() };
    invoiceCache.set(cacheKey, result, 3600); // 1 hour cache for date range

    res.json(result);
  } catch (error) {
    console.error('Error fetching SanMar invoices by date:', error.message);
    res.status(500).json({ error: 'Failed to fetch invoices', details: error.message });
  }
});

// ── GET /unpaid — All unpaid invoices ──
router.get('/unpaid', async (req, res) => {
  const cacheKey = 'sanmar-unpaid-invoices';
  const cached = invoiceCache.get(cacheKey);
  if (cached && !req.query.refresh) return res.json({ ...cached, cached: true });

  try {
    const auth = getStandardAuth();
    if (!auth.customerNumber) {
      return res.status(500).json({ error: 'SanMar customer number not configured' });
    }

    const soapBody = buildInvoiceRequest('GetUnpaidInvoices', '');

    const xml = await makeSoapRequest(ENDPOINTS.standardInvoice, soapBody, {
      timeout: 30000,
      namespaces: { web: STANDARD_NS }
    });

    const soapError = checkSoapError(xml);
    if (soapError) {
      if (soapError.message === 'Data not found') {
        return res.json({ invoices: [], message: 'No unpaid invoices', totalOwed: 0 });
      }
      return res.status(400).json({ error: soapError.message });
    }

    const invoices = parseInvoiceResponse(xml);
    const totalOwed = invoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const result = { invoices, count: invoices.length, totalOwed: Math.round(totalOwed * 100) / 100, fetchedAt: new Date().toISOString() };
    invoiceCache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('Error fetching unpaid invoices:', error.message);
    res.status(500).json({ error: 'Failed to fetch unpaid invoices', details: error.message });
  }
});

// ── GET /incremental — New invoices since last pull ──
router.get('/incremental', async (req, res) => {
  try {
    const auth = getStandardAuth();
    if (!auth.customerNumber) {
      return res.status(500).json({ error: 'SanMar customer number not configured' });
    }

    const soapBody = buildInvoiceRequest('GetInvoices', '');

    const xml = await makeSoapRequest(ENDPOINTS.standardInvoice, soapBody, {
      timeout: 60000,
      namespaces: { web: STANDARD_NS }
    });

    const soapError = checkSoapError(xml);
    if (soapError) {
      if (soapError.message === 'Data not found') {
        return res.json({ invoices: [], message: 'No new invoices since last pull' });
      }
      return res.status(400).json({ error: soapError.message });
    }

    const invoices = parseInvoiceResponse(xml);
    res.json({ invoices, count: invoices.length, fetchedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching incremental invoices:', error.message);
    res.status(500).json({ error: 'Failed to fetch invoices', details: error.message });
  }
});

// ── POST /sync — Nightly invoice sync (called by Heroku Scheduler) ──
router.post('/sync', async (req, res) => {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== process.env.CRM_API_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const syncLog = { started: new Date().toISOString() };

  try {
    const auth = getStandardAuth();
    if (!auth.customerNumber) {
      return res.status(500).json({ error: 'SanMar customer number not configured' });
    }

    // Pull incremental invoices (new since last call)
    const soapBody = buildInvoiceRequest('GetInvoices', '');
    const xml = await makeSoapRequest(ENDPOINTS.standardInvoice, soapBody, {
      timeout: 60000,
      namespaces: { web: STANDARD_NS }
    });

    const soapError = checkSoapError(xml);
    if (soapError && soapError.message !== 'Data not found') {
      return res.status(400).json({ error: soapError.message });
    }

    const invoices = soapError ? [] : parseInvoiceResponse(xml);
    syncLog.invoicesFound = invoices.length;

    let invoicesSaved = 0;
    let itemsSaved = 0;

    for (const invoice of invoices) {
      const invNo = invoice.invoiceNumber;
      if (!invNo) continue;

      try {
        // Check if invoice already exists
        const existing = await makeCaspioRequest('GET',
          `/tables/${TABLES.invoices}/records`,
          { 'q.where': `Invoice_Number='${xmlEscape(invNo)}'` }
        );

        const invoiceData = {
          SanMar_PO: invoice.purchaseOrderNo || '',
          Invoice_Number: invNo,
          Invoice_Date: invoice.invoiceDate || '',
          Due_Date: invoice.dueDate || '',
          Order_Date: invoice.orderDate || '',
          Ship_Via: invoice.shipVia || '',
          FOB_Location: invoice.fob || '',
          Terms: invoice.terms || '',
          Subtotal: invoice.subtotal,
          Sales_Tax: invoice.salesTax,
          Shipping_Charges: invoice.shippingCharges,
          Freight_Savings: invoice.freightSavings,
          Total_Amount: invoice.totalAmount,
          Is_Paid: 'No'
        };

        if (!existing || !existing.Result || existing.Result.length === 0) {
          await makeCaspioRequest('POST', `/tables/${TABLES.invoices}/records`, {}, invoiceData);
          invoicesSaved++;

          // Save line items
          for (const item of invoice.lineItems) {
            try {
              await makeCaspioRequest('POST', `/tables/${TABLES.invoiceItems}/records`, {}, {
                Invoice_Number: invNo,
                Style: item.styleNo || '',
                Color: item.color || '',
                Style_Description: item.description || '',
                Size: item.size || '',
                Quantity: item.quantity,
                Unit_Price: item.unitPrice,
                Line_Total: item.lineTotal || (item.quantity * item.unitPrice)
              });
              itemsSaved++;
            } catch (e) {
              console.error(`Failed to save invoice item for ${invNo}:`, e.message);
            }
          }

          // Update Unit_Price on SanMar_Order_Items if the order exists
          if (invoice.purchaseOrderNo) {
            for (const item of invoice.lineItems) {
              try {
                const where = `SanMar_PO='${xmlEscape(invoice.purchaseOrderNo)}' AND Style='${xmlEscape(item.styleNo || '')}'`;
                await makeCaspioRequest('PUT', `/tables/${TABLES.orderItems}/records`,
                  { 'q.where': where },
                  { Unit_Price: item.unitPrice, Line_Total: item.quantity * item.unitPrice }
                );
              } catch (e) { /* order item may not exist yet */ }
            }
          }
        }
      } catch (e) {
        console.error(`Failed to save invoice ${invNo}:`, e.message);
      }
    }

    syncLog.invoicesSaved = invoicesSaved;
    syncLog.itemsSaved = itemsSaved;
    syncLog.completed = new Date().toISOString();

    console.log('SanMar invoice sync completed:', JSON.stringify(syncLog));
    res.json(syncLog);
  } catch (error) {
    console.error('SanMar invoice sync failed:', error.message);
    res.status(500).json({ error: 'Invoice sync failed', details: error.message });
  }
});

module.exports = router;
