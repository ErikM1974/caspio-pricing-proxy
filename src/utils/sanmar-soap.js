// ==========================================
// SanMar SOAP Utility — Shared Client
// ==========================================
// Reusable SOAP client for all SanMar API calls:
// - PromoStandards: Order Status, Shipment Notification, Inventory, Pricing
// - Standard: Invoicing, Product Info
//
// Used by: sanmar-orders.js, sanmar-invoices.js, sanmar-product-data.js

const https = require('https');

// ── Endpoints ──

const ENDPOINTS = {
  // PromoStandards
  productData: 'https://ws.sanmar.com:8080/promostandards/ProductDataServiceV2.xml',
  inventory: 'https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final',
  orderStatus: 'https://ws.sanmar.com:8080/promostandards/OrderStatusServiceBindingV2',
  shipmentNotification: 'https://ws.sanmar.com:8080/promostandards/OrderShipmentNotificationServiceBinding',
  pricingConfig: 'https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding',
  invoicePS: 'https://ws.sanmar.com:8080/promostandards/InvoiceServiceBinding',
  // Standard SanMar
  productInfo: 'https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort',
  standardInventory: 'https://ws.sanmar.com:8080/SanMarWebService/SanMarWebServicePort',
  standardPricing: 'https://ws.sanmar.com:8080/SanMarWebService/SanMarPricingServicePort',
  standardInvoice: 'https://ws.sanmar.com:8080/SanMarWebService/InvoicePort'
};

// ── Namespaces ──

const NS = {
  orderStatus: 'http://www.promostandards.org/WSDL/OrderStatus/2.0.0/',
  orderStatusShared: 'http://www.promostandards.org/WSDL/OrderStatus/2.0.0/SharedObjects/',
  shipment: 'http://www.promostandards.org/WSDL/OrderShipmentNotificationService/1.0.0/',
  shipmentShared: 'http://www.promostandards.org/WSDL/OrderShipmentNotificationService/1.0.0/SharedObjects/',
  standardInvoice: 'http://webservice.integration.sanmar.com/'
};

// ── Auth ──

function getPromoStandardsAuth() {
  return {
    id: process.env.SANMAR_USERNAME || '',
    password: process.env.SANMAR_PASSWORD || ''
  };
}

function getStandardAuth() {
  return {
    customerNumber: process.env.SANMAR_CUSTOMER_NUMBER || '',
    username: process.env.SANMAR_USERNAME || '',
    password: process.env.SANMAR_PASSWORD || ''
  };
}

function validateAuth(auth) {
  if (auth.id !== undefined) {
    return !!(auth.id && auth.password);
  }
  return !!(auth.customerNumber && auth.username && auth.password);
}

// ── XML Security ──

function xmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── SOAP Request ──

function makeSoapRequest(endpoint, soapBody, { timeout = 30000, namespaces = {} } = {}) {
  return new Promise((resolve, reject) => {
    // Build namespace declarations
    const nsDecls = Object.entries(namespaces)
      .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
      .join(' ');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ${nsDecls}>
  <soapenv:Header/>
  <soapenv:Body>
    ${soapBody}
  </soapenv:Body>
</soapenv:Envelope>`;

    const url = new URL(endpoint);
    const options = {
      hostname: url.hostname,
      port: url.port || 8080,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`SanMar SOAP request timed out after ${timeout}ms`));
    });

    req.write(xml);
    req.end();
  });
}

// ── XML Parsing Helpers ──

// Extract all text values for a tag name (handles namespace prefixes)
function extractAll(xml, tagName) {
  const regex = new RegExp(`<(?:[\\w:]*:)?${tagName}>([^<]*)<\\/(?:[\\w:]*:)?${tagName}>`, 'g');
  const results = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

// Extract first text value for a tag name
function extractFirst(xml, tagName) {
  const values = extractAll(xml, tagName);
  return values.length > 0 ? values[0] : null;
}

// Extract blocks between opening/closing tags (handles namespace prefixes)
function extractBlocks(xml, tagName) {
  const regex = new RegExp(`<(?:[\\w:]*:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[\\w:]*:)?${tagName}>`, 'g');
  const results = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[0]);
  }
  return results;
}

// Check for SOAP error responses
function checkSoapError(xml) {
  if (xml.includes('Authentication Credentials failed') || xml.includes('<code>105</code>')) {
    return { error: true, code: 105, message: 'SanMar authentication failed' };
  }
  if (xml.includes('<code>104</code>')) {
    return { error: true, code: 104, message: 'Account unauthorized for this service' };
  }
  if (xml.includes('<code>160</code>')) {
    return { error: true, code: 160, message: 'No results found' };
  }
  // Standard API errors
  if (xml.includes('Data not found')) {
    return { error: true, code: 0, message: 'Data not found' };
  }
  if (xml.includes('Invalid request')) {
    return { error: true, code: 0, message: 'Invalid request' };
  }
  if (xml.includes('<faultstring>')) {
    const fault = extractFirst(xml, 'faultstring');
    return { error: true, code: 0, message: fault || 'Unknown SOAP fault' };
  }
  return null;
}

// ── PromoStandards Order Status Helpers ──

function buildOrderStatusRequest(queryType, { referenceNumber, statusTimeStamp, returnProductDetail = true, returnIssueDetailType = 'noIssues' } = {}) {
  const auth = getPromoStandardsAuth();
  let body = `
    <ns:GetOrderStatusRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
      <shar:queryType>${xmlEscape(queryType)}</shar:queryType>`;

  if (referenceNumber) {
    body += `\n      <shar:referenceNumber>${xmlEscape(referenceNumber)}</shar:referenceNumber>`;
  }
  if (statusTimeStamp) {
    body += `\n      <shar:statusTimeStamp>${xmlEscape(statusTimeStamp)}</shar:statusTimeStamp>`;
  }

  body += `
      <shar:returnIssueDetailType>${xmlEscape(returnIssueDetailType)}</shar:returnIssueDetailType>
      <shar:returnProductDetail>${returnProductDetail}</shar:returnProductDetail>
    </ns:GetOrderStatusRequest>`;

  return body;
}

// ── PromoStandards Shipment Notification Helpers ──

function buildShipmentRequest(queryType, { referenceNumber, shipmentDateTimeStamp } = {}) {
  const auth = getPromoStandardsAuth();
  let body = `
    <ns:GetOrderShipmentNotificationRequest>
      <shar:wsVersion>1.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
      <ns:queryType>${xmlEscape(String(queryType))}</ns:queryType>`;

  if (referenceNumber) {
    body += `\n      <ns:referenceNumber>${xmlEscape(referenceNumber)}</ns:referenceNumber>`;
  }
  if (shipmentDateTimeStamp) {
    body += `\n      <ns:shipmentDateTimeStamp>${xmlEscape(shipmentDateTimeStamp)}</ns:shipmentDateTimeStamp>`;
  }

  body += `
    </ns:GetOrderShipmentNotificationRequest>`;

  return body;
}

// ── Standard Invoice Helpers ──

function buildStandardInvoiceEnvelope(methodBody) {
  const auth = getStandardAuth();
  return `
    ${methodBody.replace('{{CustomerNo}}', xmlEscape(auth.customerNumber))
      .replace('{{UserName}}', xmlEscape(auth.username))
      .replace('{{Password}}', xmlEscape(auth.password))}`;
}

// ── Parse Order Status Response ──

function parseOrderStatusResponse(xml) {
  const orders = [];
  const orderBlocks = extractBlocks(xml, 'OrderStatus');

  for (const block of orderBlocks) {
    const po = extractFirst(block, 'purchaseOrderNumber');
    if (!po) continue;

    const details = extractBlocks(block, 'OrderStatusDetail');
    const orderDetails = [];

    for (const detail of details) {
      const products = [];
      const productBlocks = extractBlocks(detail, 'Product');

      for (const prod of productBlocks) {
        const qtyOrderedBlock = extractBlocks(prod, 'QuantityOrdered');
        const qtyShippedBlock = extractBlocks(prod, 'QuantityShipped');

        products.push({
          productId: extractFirst(prod, 'productId'),
          partId: extractFirst(prod, 'partId'),
          lineNumber: extractFirst(prod, 'salesOrderLineNumber'),
          qtyOrdered: qtyOrderedBlock.length > 0 ? extractFirst(qtyOrderedBlock[0], 'value') : null,
          qtyShipped: qtyShippedBlock.length > 0 ? extractFirst(qtyShippedBlock[0], 'value') : null,
          status: extractFirst(prod, 'status')
        });
      }

      orderDetails.push({
        salesOrderNumber: extractFirst(detail, 'salesOrderNumber'),
        status: extractFirst(detail, 'status'),
        validTimestamp: extractFirst(detail, 'validTimestamp'),
        products
      });
    }

    orders.push({
      purchaseOrderNumber: po,
      details: orderDetails
    });
  }

  return orders;
}

// ── Parse Shipment Notification Response ──

function parseShipmentResponse(xml) {
  const shipments = [];
  const notifBlocks = extractBlocks(xml, 'OrderShipmentNotification');

  for (const notif of notifBlocks) {
    const po = extractFirst(notif, 'purchaseOrderNumber');
    const complete = extractFirst(notif, 'complete');

    const salesOrders = [];
    const soBlocks = extractBlocks(notif, 'SalesOrder');

    for (const so of soBlocks) {
      const soNumber = extractFirst(so, 'salesOrderNumber');
      const soComplete = extractFirst(so, 'complete');

      const locations = [];
      const locBlocks = extractBlocks(so, 'ShipmentLocation');

      for (const loc of locBlocks) {
        const packages = [];
        const pkgBlocks = extractBlocks(loc, 'Package');

        for (const pkg of pkgBlocks) {
          const items = [];
          const itemBlocks = extractBlocks(pkg, 'Item');

          for (const item of itemBlocks) {
            items.push({
              supplierProductId: extractFirst(item, 'supplierProductId'),
              supplierPartId: extractFirst(item, 'supplierPartId'),
              quantity: extractFirst(item, 'quantity')
            });
          }

          packages.push({
            id: extractFirst(pkg, 'id'),
            trackingNumber: extractFirst(pkg, 'trackingNumber'),
            shipmentDate: extractFirst(pkg, 'shipmentDate'),
            carrier: extractFirst(pkg, 'carrier'),
            shipmentMethod: extractFirst(pkg, 'shipmentMethod'),
            items
          });
        }

        // Parse ship-from address
        const shipFromBlock = extractBlocks(loc, 'ShipFromAddress')[0] || extractBlocks(loc, 'shipFromAddress')[0] || '';
        const shipToBlock = extractBlocks(loc, 'ShipToAddress')[0] || extractBlocks(loc, 'shipToAddress')[0] || '';

        locations.push({
          shipFrom: {
            city: extractFirst(shipFromBlock, 'city'),
            region: extractFirst(shipFromBlock, 'region'),
            postalCode: extractFirst(shipFromBlock, 'postalCode'),
            country: extractFirst(shipFromBlock, 'country')
          },
          shipTo: {
            city: extractFirst(shipToBlock, 'city'),
            region: extractFirst(shipToBlock, 'region'),
            postalCode: extractFirst(shipToBlock, 'postalCode'),
            country: extractFirst(shipToBlock, 'country')
          },
          packages
        });
      }

      salesOrders.push({
        salesOrderNumber: soNumber,
        complete: soComplete === 'true',
        locations
      });
    }

    shipments.push({
      purchaseOrderNumber: po,
      complete: complete === 'true',
      salesOrders
    });
  }

  return shipments;
}

// ── Parse Standard Invoice Response ──

function parseInvoiceResponse(xml) {
  const invoices = [];
  const invoiceBlocks = extractBlocks(xml, 'Invoice');

  for (const inv of invoiceBlocks) {
    const headerBlock = extractBlocks(inv, 'Header')[0] || inv;

    // Parse line items
    const lineItems = [];
    const lineBlocks = extractBlocks(inv, 'LineItem');
    for (const line of lineBlocks) {
      lineItems.push({
        styleNo: extractFirst(line, 'StyleNo'),
        color: extractFirst(line, 'StyleColor'),
        description: extractFirst(line, 'StyleDescription'),
        size: extractFirst(line, 'StyleSize'),
        quantity: parseFloat(extractFirst(line, 'Quantity')) || 0,
        unitPrice: parseFloat(extractFirst(line, 'UnitPrice')) || 0,
        lineTotal: parseFloat(extractFirst(line, 'ExtAmount') || extractFirst(line, 'Amount')) || 0
      });
    }

    // Parse ship-to
    const shipToBlock = extractBlocks(headerBlock, 'ShipTo')[0] || '';

    invoices.push({
      invoiceNumber: extractFirst(headerBlock, 'InvoiceNo'),
      invoiceDate: extractFirst(headerBlock, 'InvoiceDate'),
      dueDate: extractFirst(headerBlock, 'DueDate'),
      purchaseOrderNo: extractFirst(headerBlock, 'PurchaseOrderNo'),
      orderDate: extractFirst(headerBlock, 'OrderDate'),
      shipVia: extractFirst(headerBlock, 'ShipVia'),
      fob: extractFirst(headerBlock, 'FOB'),
      terms: extractFirst(headerBlock, 'Terms'),
      subtotal: parseFloat(extractFirst(headerBlock, 'SubTotal')) || 0,
      salesTax: parseFloat(extractFirst(headerBlock, 'SalesTax')) || 0,
      shippingCharges: parseFloat(extractFirst(headerBlock, 'ShippingHandlingCharges')) || 0,
      freightSavings: parseFloat(extractFirst(headerBlock, 'FreightSavings')) || 0,
      totalAmount: parseFloat(extractFirst(headerBlock, 'TotalAmount')) || 0,
      shipTo: {
        name: extractFirst(shipToBlock, 'Name'),
        address: extractFirst(shipToBlock, 'Address1'),
        city: extractFirst(shipToBlock, 'City'),
        state: extractFirst(shipToBlock, 'State'),
        zip: extractFirst(shipToBlock, 'PostalCode'),
        country: extractFirst(shipToBlock, 'Country')
      },
      lineItems
    });
  }

  return invoices;
}

module.exports = {
  // Endpoints
  ENDPOINTS,
  NS,
  // Auth
  getPromoStandardsAuth,
  getStandardAuth,
  validateAuth,
  // XML
  xmlEscape,
  makeSoapRequest,
  // Parsing
  extractAll,
  extractFirst,
  extractBlocks,
  checkSoapError,
  // Request builders
  buildOrderStatusRequest,
  buildShipmentRequest,
  buildStandardInvoiceEnvelope,
  // Response parsers
  parseOrderStatusResponse,
  parseShipmentResponse,
  parseInvoiceResponse
};
