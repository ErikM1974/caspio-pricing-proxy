#!/usr/bin/env node
/**
 * check-zero-billing.js
 *
 * Compares SanMar purchase costs vs customer billing.
 * Alerts sales reps (+ CC Erik) when we bought from SanMar but charged $0.
 *
 * Usage:
 *   npm run check-zero-billing                # Normal daily check
 *   npm run check-zero-billing -- --dry-run   # Show what would be sent without emailing
 *   npm run check-zero-billing -- --test      # Send a test email to Erik only
 *
 * Heroku Scheduler: npm run check-zero-billing (daily at 1:30 PM UTC / 6:30 AM Pacific)
 */

const axios = require('axios');

// ── Config ──────────────────────────────────────────────────────────────
const CASPIO_BASE = 'https://c3eku948.caspio.com/rest/v2';
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = 'template_zero_billing';
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

// Sales rep name → email mapping
const REP_EMAILS = {
  'Taneisha Clark': 'taneisha@nwcustomapparel.com',
  'Ruthie Nhoung': 'ruth@nwcustomapparel.com',
  'Nika Lao': 'nika@nwcustomapparel.com',
  'Erik Mickelson': 'erik@nwcustomapparel.com',
  'Jim Mickelson': 'erik@nwcustomapparel.com',
  'House': 'erik@nwcustomapparel.com',
  '': 'erik@nwcustomapparel.com'
};

const ERIK_EMAIL = 'erik@nwcustomapparel.com';

// ── Caspio Auth & CRUD ──────────────────────────────────────────────────
let caspioToken = null;
let tokenExpiresAt = 0;

async function getCaspioToken() {
  const now = Math.floor(Date.now() / 1000);
  if (caspioToken && now < tokenExpiresAt - 60) return caspioToken; // 60s buffer
  const resp = await axios.post('https://c3eku948.caspio.com/oauth/token',
    `grant_type=client_credentials&client_id=${CASPIO_CLIENT_ID}&client_secret=${CASPIO_CLIENT_SECRET}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  caspioToken = resp.data.access_token;
  tokenExpiresAt = now + (resp.data.expires_in || 3600);
  return caspioToken;
}

async function caspioGet(endpoint) {
  const token = await getCaspioToken();
  const resp = await axios.get(`${CASPIO_BASE}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return resp.data;
}

async function caspioPut(endpoint, body) {
  const token = await getCaspioToken();
  const resp = await axios.put(`${CASPIO_BASE}${endpoint}`, body, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  return resp.data;
}

async function caspioReadAll(table, where) {
  const records = [];
  let page = 1;
  while (true) {
    const w = where ? `&q.where=${encodeURIComponent(where)}` : '';
    const data = await caspioGet(`/tables/${table}/records?q.pageSize=1000&q.pageNumber=${page}${w}`);
    const rows = data.Result || [];
    records.push(...rows);
    if (rows.length < 1000) break;
    page++;
  }
  return records;
}

// ── EmailJS ─────────────────────────────────────────────────────────────
async function sendEmail(templateParams) {
  const payload = {
    service_id: EMAILJS_SERVICE_ID,
    template_id: EMAILJS_TEMPLATE_ID,
    user_id: EMAILJS_PUBLIC_KEY,
    accessToken: EMAILJS_PRIVATE_KEY,
    template_params: templateParams
  };

  const resp = await axios.post('https://api.emailjs.com/api/v1.0/email/send', payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  return resp.status === 200;
}

// ── Helpers ─────────────────────────────────────────────────────────────
function normalizePartNumber(pn) {
  if (!pn) return '';
  return pn.trim().toUpperCase();
}

function normalizeColor(color) {
  if (!color) return '';
  return color.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getRepEmail(repName) {
  if (!repName) return ERIK_EMAIL;
  const name = repName.trim();
  return REP_EMAILS[name] || ERIK_EMAIL;
}

// ── Main Logic ──────────────────────────────────────────────────────────
async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const isTest = process.argv.includes('--test');

  console.log(`\n[${new Date().toISOString()}] Zero-Billing Check`);
  console.log(`  Mode: ${isTest ? 'TEST' : isDryRun ? 'DRY RUN' : 'LIVE'}\n`);

  if (!CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
    console.error('ERROR: CASPIO_CLIENT_ID and CASPIO_CLIENT_SECRET required');
    process.exit(1);
  }
  if (!isDryRun && !isTest && (!EMAILJS_SERVICE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY)) {
    console.error('ERROR: EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY required');
    process.exit(1);
  }

  // Step 1: Get all matched SanMar orders (have an id_Order)
  console.log('Step 1: Reading matched SanMar orders...');
  const sanmarOrders = await caspioReadAll('SanMar_Orders', "id_Order<>''");
  console.log(`  Found ${sanmarOrders.length} matched SanMar orders`);

  // Filter to only those not yet alerted
  const unalerted = sanmarOrders.filter(o => !o.Zero_Billing_Alerted);
  console.log(`  Unalerted: ${unalerted.length}\n`);

  if (!unalerted.length && !isTest) {
    console.log('No new orders to check. Done.');
    return;
  }

  // Step 2: Get SanMar order items (our cost)
  console.log('Step 2: Reading SanMar order items...');
  const sanmarItems = await caspioReadAll('SanMar_Order_Items');
  const sanmarItemsByPO = new Map();
  for (const item of sanmarItems) {
    const po = item.SanMar_PO;
    if (!sanmarItemsByPO.has(po)) sanmarItemsByPO.set(po, []);
    sanmarItemsByPO.get(po).push(item);
  }
  console.log(`  Found ${sanmarItems.length} SanMar line items\n`);

  // Step 3: Get ManageOrders line items (customer price)
  console.log('Step 3: Reading ManageOrders line items...');
  const moLineItems = await caspioReadAll('ManageOrders_LineItems');
  const moItemsByOrder = new Map();
  for (const item of moLineItems) {
    const orderId = String(item.id_Order);
    if (!moItemsByOrder.has(orderId)) moItemsByOrder.set(orderId, []);
    moItemsByOrder.get(orderId).push(item);
  }
  console.log(`  Found ${moLineItems.length} ManageOrders line items\n`);

  // Step 4: Get ManageOrders orders (for customer name + rep)
  console.log('Step 4: Reading ManageOrders orders...');
  const moOrders = await caspioReadAll('ManageOrders_Orders');
  const moOrderMap = new Map();
  for (const o of moOrders) {
    moOrderMap.set(String(o.id_Order), o);
  }
  console.log(`  Found ${moOrders.length} ManageOrders orders\n`);

  // Step 5: Compare costs
  console.log('Step 5: Checking for zero-billing items...');
  const alerts = []; // { sanmarPO, orderId, customerName, repName, repEmail, items[], totalCost }

  const ordersToCheck = isTest ? unalerted.slice(0, 3) : unalerted;

  for (const so of ordersToCheck) {
    const sanmarPO = so.SanMar_PO;
    const orderId = String(so.id_Order);
    const poItems = sanmarItemsByPO.get(sanmarPO) || [];
    const orderItems = moItemsByOrder.get(orderId) || [];
    const moOrder = moOrderMap.get(orderId);

    if (!poItems.length || !orderItems.length) continue;

    // Build lookup of customer prices by PartNumber + Color
    const customerPriceMap = new Map();
    for (const oi of orderItems) {
      const key = `${normalizePartNumber(oi.PartNumber)}|${normalizeColor(oi.PartColor)}`;
      customerPriceMap.set(key, parseFloat(oi.LineUnitPrice) || 0);
    }

    // Check each SanMar item
    const zeroItems = [];
    for (const si of poItems) {
      const ourCost = parseFloat(si.Unit_Price) || 0;
      if (ourCost <= 0) continue; // We didn't pay for it either — skip

      // Try exact match first (Style + Color), fall back to Style-only if Color is empty
      const key = `${normalizePartNumber(si.Style)}|${normalizeColor(si.Color)}`;
      let customerPrice = customerPriceMap.get(key);

      // If no match and Color is empty/missing, try matching by Style only
      if (customerPrice === undefined && !si.Color) {
        for (const [k, v] of customerPriceMap) {
          if (k.startsWith(normalizePartNumber(si.Style) + '|')) {
            customerPrice = v;
            break;
          }
        }
      }

      // customerPrice is 0 or not found (item not on the order = not billed)
      if (customerPrice === 0 || customerPrice === undefined) {
        zeroItems.push({
          partNumber: si.Style,
          color: si.Color,
          size: si.Size || '',
          qty: parseInt(si.Qty_Ordered) || 0,
          ourCost: ourCost,
          customerPrice: customerPrice === undefined ? 'Not on order' : '$0.00'
        });
      }
    }

    if (zeroItems.length > 0) {
      const repName = moOrder ? moOrder.CustomerServiceRep || '' : so.Sales_Rep || '';
      const customerName = moOrder ? moOrder.CustomerName || '' : so.Company_Name || '';
      const totalCost = zeroItems.reduce((sum, i) => sum + (i.ourCost * i.qty), 0);

      alerts.push({
        sanmarPO: sanmarPO,
        orderId: orderId,
        customerName: customerName,
        repName: repName,
        repEmail: getRepEmail(repName),
        items: zeroItems,
        totalCost: totalCost.toFixed(2),
        pk_id: so.PK_ID
      });
    }
  }

  console.log(`  Found ${alerts.length} orders with zero-billing items\n`);

  if (!alerts.length) {
    console.log('No zero-billing issues found. Done.');
    // Mark all checked orders as alerted (no issues found)
    if (!isDryRun && !isTest) {
      for (const so of ordersToCheck) {
        await caspioPut(
          `/tables/SanMar_Orders/records?q.where=${encodeURIComponent(`PK_ID=${so.PK_ID}`)}`,
          { Zero_Billing_Alerted: 'checked' }
        );
      }
      console.log(`  Marked ${ordersToCheck.length} orders as checked`);
    }
    return;
  }

  // Step 6: Send alerts
  console.log('Step 6: Sending alerts...');
  let sentCount = 0;

  for (const alert of alerts) {
    // Build HTML table rows for the email
    const itemsHtml = alert.items.map(i =>
      `<tr>
        <td>${i.partNumber}</td>
        <td>${i.color}</td>
        <td>${i.qty}</td>
        <td>$${i.ourCost.toFixed(2)}</td>
        <td>${typeof i.customerPrice === 'string' ? i.customerPrice : '$' + i.customerPrice.toFixed(2)}</td>
      </tr>`
    ).join('\n');

    const templateParams = {
      to_email: isTest ? ERIK_EMAIL : alert.repEmail,
      rep_name: alert.repName || 'Team',
      order_number: alert.orderId,
      customer_name: alert.customerName,
      sanmar_po: alert.sanmarPO,
      items_html: itemsHtml,
      total_cost: alert.totalCost
    };

    console.log(`  Order #${alert.orderId} (${alert.customerName})`);
    console.log(`    Rep: ${alert.repName} → ${isTest ? ERIK_EMAIL : alert.repEmail}`);
    console.log(`    Items: ${alert.items.length}, Cost absorbed: $${alert.totalCost}`);

    if (isDryRun) {
      console.log('    [DRY RUN] Would send email');
      alert.items.forEach(i => console.log(`      ${i.partNumber} ${i.color} x${i.qty} — Our: $${i.ourCost.toFixed(2)}, Cust: ${i.customerPrice}`));
    } else {
      // Send email first
      let emailSent = false;
      try {
        await sendEmail(templateParams);
        console.log('    Email sent');
        sentCount++;
        emailSent = true;
      } catch (err) {
        console.error(`    EMAIL FAILED: ${err.message}`);
      }

      // Only mark as alerted if email actually sent
      try {
        await caspioPut(
          `/tables/SanMar_Orders/records?q.where=${encodeURIComponent(`PK_ID=${alert.pk_id}`)}`,
          { Zero_Billing_Alerted: emailSent ? 'alerted' : 'email_failed' }
        );
      } catch (flagErr) {
        console.error(`    FLAG UPDATE FAILED: ${flagErr.message}`);
      }
    }
  }

  // Mark non-alert orders as checked too
  if (!isDryRun && !isTest) {
    const alertPKs = new Set(alerts.map(a => a.pk_id));
    for (const so of ordersToCheck) {
      if (!alertPKs.has(so.PK_ID)) {
        await caspioPut(
          `/tables/SanMar_Orders/records?q.where=${encodeURIComponent(`PK_ID=${so.PK_ID}`)}`,
          { Zero_Billing_Alerted: 'checked' }
        );
      }
    }
  }

  // Summary
  console.log(`\n=== ZERO-BILLING CHECK COMPLETE ===`);
  console.log(`  Orders checked: ${ordersToCheck.length}`);
  console.log(`  Alerts found:   ${alerts.length}`);
  console.log(`  Emails sent:    ${isDryRun ? '0 (dry run)' : sentCount}`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
