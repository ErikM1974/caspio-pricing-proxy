// aeo-push-transformer.js — pure transformer: AE Order Intake submission
// (Form_Submissions row + parsed payload) → manageorders-push-client orderData.
//
// Design rules (Erik 2026-07-11, "be honest and blunt" review):
//   - ONLY rows whose color was picked from the SanMar lookup (Catalog Color
//     captured) become real ShopWorks line items — hand-typed colors are
//     unverifiable and would poison the SanMar PO chain. Skipped rows ride in
//     Notes On Order so the rep finishes them by hand: order STARTED, nothing
//     silently guessed.
//   - One line per size (S–3XL), base part number + plain size (OnSite's Size
//     Translation Table appends _2X etc. — never pre-suffix).
//   - Tax is NEVER pushed (house rule: rep applies the ShopWorks tax dropdown;
//     the money summary incl. tax rides in the notes).
//   - orderNumber carries the submission id + YEAR (ExtOrderID uniqueness rule:
//     date-packed sequences without a year collide across years).
//
// Deliberately imports NOTHING (jest: api-tracker timer lesson, 2026-07-11).
'use strict';

var SIZE_LABELS = ['S', 'M', 'L', 'XL', '2XL', '3XL'];

function num(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function splitName(fullName) {
  var trimmed = String(fullName || '').trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  var i = trimmed.lastIndexOf(' ');
  if (i === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, i).trim(), lastName: trimmed.slice(i + 1).trim() };
}

function fieldMap(payload) {
  var map = {};
  (payload.fields || []).forEach(function (pair) {
    if (Array.isArray(pair) && pair.length >= 2) map[pair[0]] = String(pair[1] == null ? '' : pair[1]);
  });
  return map;
}

/**
 * @param {Object} submission — Form_Submissions row (Submission_ID, Company, …)
 * @param {Object} payload — parsed Payload_JSON (fields/checks/tables/notes)
 * @param {Object} [options] — { isTest }
 * @returns {{ orderData, verifiedLines, skippedRows, warnings }}
 */
function buildAeoOrderData(submission, payload, options) {
  options = options || {};
  var F = fieldMap(payload);
  var checks = payload.checks || [];
  var warnings = [];

  var lineItems = [];
  var verifiedLines = [];
  var skippedRows = [];

  if (Array.isArray(payload.lines) && payload.lines.length) {
    // ── machine block (2026-07-11 form v2): per-row {style, colorName,
    //    catalogColor, description, basePrice, sizes:[{size,qty,upcharge}],
    //    otherSizes} — dynamic size runs incl. 4XL/5XL/talls. Per-size price
    //    is recomputed HERE (base + Caspio upcharge) — never trusted from
    //    the client.
    payload.lines.forEach(function (line, idx) {
      var style = String(line.style || '').trim().toUpperCase();
      var catalogColor = String(line.catalogColor || '').trim();
      var basePrice = num(line.basePrice);
      var sizes = Array.isArray(line.sizes) ? line.sizes.filter(function (s) { return s && parseInt(s.qty, 10) > 0; }) : [];
      var otherSizes = String(line.otherSizes || '').trim();

      var reasons = [];
      if (!style) reasons.push('no style #');
      if (!catalogColor) reasons.push('color not picked from the SanMar list (no catalog color)');
      if (!sizes.length) reasons.push('no size quantities');
      if (basePrice === null) reasons.push('no base price');

      var raw = [line.style || '', line.colorName || '', line.description || '',
        sizes.map(function (s) { return s.size + 'x' + s.qty; }).join(' '), line.qty || '', line.basePrice || ''];

      if (reasons.length) {
        skippedRows.push({ rowNumber: idx + 1, style: style, color: line.colorName || '', otherSizes: otherSizes, reasons: reasons, raw: raw });
        return;
      }

      var rowQty = 0;
      sizes.forEach(function (s) {
        var qty = parseInt(s.qty, 10);
        var upcharge = parseFloat(s.upcharge) || 0;
        rowQty += qty;
        lineItems.push({
          partNumber: style,
          description: String(line.description || '').trim() || style,
          catalogColor: catalogColor,
          color: String(line.colorName || '').trim(),
          size: String(s.size || '').trim(),
          quantity: qty,
          price: Math.round((basePrice + upcharge) * 100) / 100,
        });
      });
      verifiedLines.push({ rowNumber: idx + 1, style: style, color: line.colorName || '', catalogColor: catalogColor, qty: rowQty, unitPrice: basePrice });
      if (otherSizes) warnings.push('Row ' + (idx + 1) + ' (' + style + '): "Other" sizes not pushed — add by hand: ' + otherSizes);
    });
  } else {
    // ── legacy table rows (form v1 submissions):
    //    [Style, Color, Catalog Color, Description, S,M,L,XL,2XL,3XL, Other, Qty, Unit Price, Line Total]
    var table = (payload.tables || []).filter(function (t) { return t && t.title === 'Order Lines'; })[0]
             || (payload.tables || [])[0] || { rows: [] };

    (table.rows || []).forEach(function (row, idx) {
      var style = String(row[0] || '').trim();
      var colorName = String(row[1] || '').trim();
      var catalogColor = String(row[2] || '').trim();
      var description = String(row[3] || '').trim();
      var sizes = row.slice(4, 10).map(function (v) { return parseInt(v, 10) || 0; });
      var otherSizes = String(row[10] || '').trim();
      var unitPrice = num(row[12]);
      var sizedQty = sizes.reduce(function (a, b) { return a + b; }, 0);

      var reasons = [];
      if (!style) reasons.push('no style #');
      if (!catalogColor) reasons.push('color not picked from the SanMar list (no catalog color)');
      if (sizedQty <= 0) reasons.push('no S–3XL size quantities');
      if (unitPrice === null) reasons.push('no unit price');

      if (reasons.length) {
        skippedRows.push({ rowNumber: idx + 1, style: style, color: colorName, otherSizes: otherSizes, reasons: reasons, raw: row });
        return;
      }

      sizes.forEach(function (qty, s) {
        if (qty <= 0) return;
        lineItems.push({
          partNumber: style,
          description: description || style,
          catalogColor: catalogColor,
          color: colorName,
          size: SIZE_LABELS[s],
          quantity: qty,
          price: unitPrice,
        });
      });
      verifiedLines.push({ rowNumber: idx + 1, style: style, color: colorName, catalogColor: catalogColor, qty: sizedQty, unitPrice: unitPrice });

      if (otherSizes) {
        warnings.push('Row ' + (idx + 1) + ' (' + style + '): "Other" sizes not pushed — add by hand: ' + otherSizes);
      }
    });
  }

  // ── notes ──
  var methodChecks = checks.filter(function (c) {
    return ['Proof required', 'No proof needed', 'Customer Pickup', 'Ship'].indexOf(c) === -1;
  });
  var pickup = checks.indexOf('Customer Pickup') !== -1;

  var noteLines = [
    'AE ORDER INTAKE — ' + submission.Submission_ID + ' (Forms Inbox)',
    'Decoration: ' + (methodChecks.join(', ') || '(not marked)'),
    'Location: ' + (F['Decoration Location'] || ''),
    'Logo/Artwork: ' + (F['Logo / Artwork Name'] || ''),
    'Thread/Print colors: ' + (F['Thread / Print Colors'] || ''),
    'Artwork instructions: ' + (F['Artwork Instructions'] || ''),
    'Proof: ' + (checks.indexOf('Proof required') !== -1 ? 'REQUIRED' : (checks.indexOf('No proof needed') !== -1 ? 'not needed' : '?')),
    'Fulfillment: ' + (pickup ? 'CUSTOMER PICKUP' : (checks.indexOf('Ship') !== -1 ? 'SHIP — ' + (F['Ship Method'] || '?') : '?')),
    'Ship-to / delivery: ' + (F['Ship-To / Delivery'] || ''),
    'Pickup/Ship date: ' + (F['Pickup / Ship Date'] || ''),
    '— MONEY (from intake sheet; TAX NOT PUSHED — apply the SW tax dropdown) —',
    'Subtotal: $' + (F['Subtotal'] || '?') + ' · Tax: $' + (F['Tax'] || '?') + ' · Order Total: $' + (F['Order Total'] || '?'),
    'Deposit: $' + (F['Deposit'] || '0') + ' · Balance Due: $' + (F['Balance Due'] || '?'),
    'Payment notes: ' + (F['Deposit / Payment Notes'] || ''),
  ];

  if (skippedRows.length) {
    noteLines.push('— ROWS NOT PUSHED (finish by hand; color not SanMar-verified or incomplete) —');
    skippedRows.forEach(function (r) {
      noteLines.push('Row ' + r.rowNumber + ': ' + r.raw.slice(0, 2).concat(r.raw.slice(3, 4)).join(' / ') +
        ' | sizes S-3XL: ' + r.raw.slice(4, 10).join('/') + (r.otherSizes ? ' other: ' + r.otherSizes : '') +
        ' | qty ' + (r.raw[11] || '?') + ' @ $' + (r.raw[12] || '?') + ' — ' + r.reasons.join('; '));
    });
  }
  warnings.forEach(function (w) { noteLines.push('NOTE: ' + w); });

  // ── design link (form v2 captures the digitized design # on pick) ──
  var DESIGN_TYPE_BY_METHOD = { 'Embroidery': 2, 'Screen Printing': 1, 'Transfers': 8, 'DTG': 45 };
  var designNumber = parseInt(payload.designNumber, 10);
  var designs;
  if (designNumber && designNumber > 0) {
    var firstMethod = methodChecks[0] || '';
    var productColors = [];
    lineItems.forEach(function (li) {
      if (li.catalogColor && productColors.indexOf(li.catalogColor) === -1) productColors.push(li.catalogColor);
    });
    designs = [{
      id_Design: designNumber,
      name: String(payload.designName || ('Design #' + designNumber)),
      designTypeId: DESIGN_TYPE_BY_METHOD[firstMethod] || undefined,
      productColor: productColors.join(', '),
    }];
    noteLines.push('Design #' + designNumber + ' linked by this push (' + (payload.designName || '') + ').');
  } else {
    noteLines.push('No design linked by this push — attach/link the design in ShopWorks.');
  }

  var notes = [{ type: 'Notes On Order', text: noteLines.filter(Boolean).join('\n') }];
  var prodNotes = ((payload.notes || []).filter(function (p) { return p[0] === 'Production Notes'; })[0] || [])[1];
  if (prodNotes) notes.push({ type: 'Notes To Production', text: prodNotes });

  // ── order header ──
  var name = splitName(submission.Contact_Name);
  var year = String(submission.Submitted_At || '').slice(0, 4) || String(new Date().getFullYear());
  var customerNumber = parseInt(submission.Customer_Number, 10);

  var orderData = {
    orderNumber: submission.Submission_ID + '-' + year,
    orderDate: String(submission.Submitted_At || '').slice(0, 10) || undefined,
    requestedShipDate: submission.Due_Date || undefined,
    customer: {
      firstName: name.firstName,
      lastName: name.lastName,
      email: submission.Email || '',
      phone: submission.Phone || '',
      companyId: customerNumber || '',
      company: submission.Company || '',
    },
    salesRep: submission.Sales_Rep || '',
    customerPurchaseOrder: F['PO # / Customer #'] || '',
    shipping: { method: pickup ? 'Customer Pickup' : (F['Ship Method'] || ''), company: submission.Company || '' },
    lineItems: lineItems,
    notes: notes,
    isTest: !!options.isTest,
    // taxTotal deliberately ABSENT — never push tax (rep applies SW dropdown)
  };
  if (designs) orderData.designs = designs;
  if (customerNumber) orderData.idCustomer = customerNumber;
  if (!customerNumber) warnings.push('No numeric Customer # — order lands on the catch-all customer; rep re-assigns in ShopWorks.');

  return { orderData: orderData, verifiedLines: verifiedLines, skippedRows: skippedRows, warnings: warnings };
}

module.exports = { buildAeoOrderData: buildAeoOrderData, SIZE_LABELS: SIZE_LABELS };
