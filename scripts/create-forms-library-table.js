#!/usr/bin/env node
/**
 * Create the `Forms_Library` Caspio table — the Erik-editable registry of printable /
 * fillable company forms surfaced on /dashboards/forms-library.html (Pricing Index repo).
 * Erik adds a row in Caspio (or via the gated POST /api/forms-library) → the form shows
 * up in the staff Forms Library with no deploy.
 *
 *   node scripts/create-forms-library-table.js          # dry-run
 *   node scripts/create-forms-library-table.js --apply  # create + seed
 *
 * Columns (all STRING per house convention):
 *   Form_ID (unique slug) · Form_Name · Description · Category · PDF_URL ·
 *   Fill_Online_URL (blank = no online version) · Sort_Order (numeric string) ·
 *   Is_Active ('Yes'/'No' — Text like Design_Lookup_2026, NOT boolean)
 *
 * PDF_URL / Fill_Online_URL are teamnwca.com-relative paths (e.g. /forms/x.pdf) or
 * absolute URLs (e.g. a proxy /api/files/:key link for Caspio-hosted files).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Forms_Library';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'Form_ID', Type: 'STRING', Unique: true },
    { Name: 'Form_Name', Type: 'STRING' },
    { Name: 'Description', Type: 'STRING' },
    { Name: 'Category', Type: 'STRING' },
    { Name: 'PDF_URL', Type: 'STRING' },
    { Name: 'Fill_Online_URL', Type: 'STRING' },
    { Name: 'Sort_Order', Type: 'STRING' },
    { Name: 'Is_Active', Type: 'STRING' },
  ],
};

// Seed = every PDF already in the Pricing Index /forms/ dir + the new drop-off form.
// Erik edits/deactivates rows in Caspio; sort within category by Sort_Order asc.
const SEED = [
  {
    Form_ID: 'garment-drop-off',
    Form_Name: 'Customer Garment Drop-Off Form',
    Description: 'Intake sheet for customer-supplied blank garments — decoration checklist, size grid, and liability waiver.',
    Category: 'Customer Intake',
    PDF_URL: '/forms/customer-garment-drop-off-form.pdf',
    Fill_Online_URL: '/pages/forms/garment-drop-off-form.html',
    Sort_Order: '10',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'artwork-request',
    Form_Name: 'Custom Artwork Request Form',
    Description: 'Customer-requested custom graphic design / decoration projects — project details, art direction, sketch area, art budget sign-off.',
    Category: 'Customer Intake',
    PDF_URL: '/forms/custom-artwork-request-form.pdf',
    Fill_Online_URL: '/pages/forms/artwork-request-form.html',
    Sort_Order: '12',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'name-personalization',
    Form_Name: 'Customer Name Personalization Form',
    Description: 'Name list for personalized garments — names produced exactly as written; customer verifies spelling and signs.',
    Category: 'Customer Intake',
    PDF_URL: '/forms/customer-name-personalization-form.pdf',
    Fill_Online_URL: '/pages/forms/name-personalization-form.html',
    Sort_Order: '14',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'sample-checkout',
    Form_Name: 'Sample Checkout & Return Agreement',
    Description: 'Customer sample checkout — items list, 14-day return terms, 75%-of-retail charge authorization (never write full card numbers on it).',
    Category: 'Customer Intake',
    PDF_URL: '/forms/sample-checkout-return-agreement.pdf',
    Fill_Online_URL: '/pages/forms/sample-checkout-form.html',
    Sort_Order: '16',
    Is_Active: 'Yes',
  },
  {
    // Erik 2026-07-11: moved to TOP of Customer Intake (was Sales / Order Entry)
    Form_ID: 'ae-order-intake',
    Form_Name: 'AE Customer Order Intake Form',
    Description: 'AE order sheet to complete before entering the order into ShopWorks. Fill online (customer + SanMar style lookup) or type into the PDF.',
    Category: 'Customer Intake',
    PDF_URL: '/forms/ae-customer-order-intake-form.pdf',
    Fill_Online_URL: '/pages/forms/ae-order-intake-form.html',
    Sort_Order: '5',
    Is_Active: 'Yes',
  },
  {
    // Erik 2026-07-11: REMOVED from the library (Is_Active No, row kept for
    // history) — the drop-off form already carries the same waiver text.
    Form_ID: 'customer-supplied-acknowledgment',
    Form_Name: 'Customer-Supplied Garments Acknowledgment',
    Description: 'Waiver the customer signs acknowledging NWCA is not liable for replacement of customer-supplied items.',
    Category: 'Customer Intake',
    PDF_URL: '/forms/Customer-Supplied-Garments-Acknowledgment.pdf',
    Fill_Online_URL: '',
    Sort_Order: '20',
    Is_Active: 'No',
  },
  {
    // 2026-07-12: 2015 PDF RETIRED from the library (it had full-PAN + CVV
    // blanks — storing CVV post-auth violates PCI DSS 3.2). The twin captures
    // identity only (last 4 / expiry); the number goes by phone / secure link.
    Form_ID: 'credit-card-authorization',
    Form_Name: 'Credit Card Authorization Form',
    Description: 'Card-on-file authorization — cardholder identity, last 4 + expiration only (never the full number or CVV), authorized users & ship-tos. Card number is taken by phone, secure payment link, or in person.',
    Category: 'Payments',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/credit-card-auth-form.html',
    Sort_Order: '30',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'meal-period-waiver',
    Form_Name: 'Meal Period Waiver',
    Description: 'Employee meal-period waiver (WA L&I requirement).',
    Category: 'Employee / HR',
    PDF_URL: '/forms/NWCA-Meal-Period-Waiver.pdf',
    Fill_Online_URL: '',
    Sort_Order: '40',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'employee-handbook',
    Form_Name: 'Employee Handbook (PDF)',
    Description: 'Latest full employee handbook — also readable online in the Policies Hub.',
    Category: 'Employee / HR',
    PDF_URL: '/forms/Employee-Handbook-Latest.pdf',
    Fill_Online_URL: '',
    Sort_Order: '50',
    Is_Active: 'Yes',
  },
  // ── Quality Control (ops batch, 2026-07-11) ──────────────────────────────
  {
    Form_ID: 'final-qc-checklist',
    Form_Name: 'Final QC Checklist',
    Description: 'Inspect a completed order before packing/shipping — 14-point OK/FAIL/N-A checklist, quantity verification, final disposition. Fillable PDF; fill-online saves to the Forms Inbox.',
    Category: 'Quality Control',
    PDF_URL: '/forms/final-qc-checklist.pdf',
    Fill_Online_URL: '/pages/forms/qc-checklist-form.html',
    Sort_Order: '10',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'spoilage-report',
    Form_Name: 'Spoilage, Damage & Reprint Report',
    Description: 'Document damaged/incorrect product — item rows with garment + decoration costs, error type, root cause, corrective action, supervisor resolution.',
    Category: 'Quality Control',
    PDF_URL: '/forms/spoilage-damage-reprint-report.pdf',
    Fill_Online_URL: '/pages/forms/spoilage-report-form.html',
    Sort_Order: '20',
    Is_Active: 'Yes',
  },
  // ── Equipment Maintenance (ops batch, 2026-07-11) ────────────────────────
  {
    Form_ID: 'embroidery-maintenance',
    Form_Name: 'Embroidery Machine Maintenance Log',
    Description: 'Cleaning, lubrication, inspections, repairs and scheduled service for embroidery machines — 14-task checklist, readings, downtime, sign-off.',
    Category: 'Equipment Maintenance',
    PDF_URL: '/forms/embroidery-maintenance-log.pdf',
    Fill_Online_URL: '/pages/forms/maintenance-log-form.html?type=embroidery',
    Sort_Order: '10',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'kornit-maintenance',
    Form_Name: 'Kornit DTG Maintenance Log',
    Description: 'Kornit DTG maintenance — nozzle tests, printhead/pretreatment care, temps & humidity, calibration prints, downtime, sign-off.',
    Category: 'Equipment Maintenance',
    PDF_URL: '/forms/kornit-dtg-maintenance-log.pdf',
    Fill_Online_URL: '/pages/forms/maintenance-log-form.html?type=kornit',
    Sort_Order: '20',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'heat-press-maintenance',
    Form_Name: 'Heat Press Maintenance & Calibration Log',
    Description: 'Heat press temperature/pressure/timer calibration, platen & pad condition, test presses, repairs, next calibration date.',
    Category: 'Equipment Maintenance',
    PDF_URL: '/forms/heat-press-maintenance-log.pdf',
    Fill_Online_URL: '/pages/forms/maintenance-log-form.html?type=heat-press',
    Sort_Order: '30',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'laser-maintenance',
    Form_Name: 'Laser Equipment Maintenance & Safety Log',
    Description: 'Laser engraver/cutter care — lens & mirror cleaning, exhaust, cooling, interlocks & e-stop safety checks, test engraves, downtime.',
    Category: 'Equipment Maintenance',
    PDF_URL: '/forms/laser-maintenance-log.pdf',
    Fill_Online_URL: '/pages/forms/maintenance-log-form.html?type=laser',
    Sort_Order: '40',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'roland-maintenance',
    Form_Name: 'Roland Printer Maintenance Log',
    Description: 'Roland printer care — nozzle checks, capping/wiper cleaning, media path, print-and-cut alignment, test prints, downtime.',
    Category: 'Equipment Maintenance',
    PDF_URL: '/forms/roland-maintenance-log.pdf',
    Fill_Online_URL: '/pages/forms/maintenance-log-form.html?type=roland',
    Sort_Order: '50',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'compressor-maintenance',
    Form_Name: 'Compressors & Support Equipment Maintenance Log',
    Description: 'Air compressors & support equipment — pressures, run hours, moisture drainage, filters/belts/hoses, safety valve tests, downtime.',
    Category: 'Equipment Maintenance',
    PDF_URL: '/forms/compressor-support-maintenance-log.pdf',
    Fill_Online_URL: '/pages/forms/maintenance-log-form.html?type=compressor',
    Sort_Order: '60',
    Is_Active: 'Yes',
  },
  // ── batch 2 (Erik-approved 2026-07-11): fill-online only, no source PDFs ──
  {
    Form_ID: 'customer-onboarding',
    Form_Name: 'New Customer Onboarding',
    Description: 'New-account intake — company, contacts, addresses, tax status, terms, decoration profile. One sheet sets up ShopWorks + CRM + portal.',
    Category: 'Customer Intake',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/customer-onboarding-form.html',
    Sort_Order: '6',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'team-roster',
    Form_Name: 'Team Roster — Names & Numbers',
    Description: 'Player roster for personalized team orders — name/number/size grid with live size tally; names produced exactly as written.',
    Category: 'Customer Intake',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/team-roster-form.html',
    Sort_Order: '7',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'webstore-request',
    Form_Name: 'Webstore / Company Store Request',
    Description: 'Company-store intake — window vs always-on, who pays, fulfillment, product lineup, logos & approver. One sheet per store build.',
    Category: 'Customer Intake',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/webstore-request-form.html',
    Sort_Order: '8',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'credit-application',
    Form_Name: 'Net-Terms Credit Application',
    Description: 'Net 15 / Net 30 application — business info, trade + bank references (contacts only, never account numbers), authorization signature.',
    Category: 'Payments',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/credit-application-form.html',
    Sort_Order: '32',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'tax-exempt-cert',
    Form_Name: 'Tax-Exempt / Resale Certificate on File',
    Description: 'Why a customer is sold tax-free — exemption type, permit #, expiration (Inbox flags it 7 days before the cert lapses).',
    Category: 'Payments',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/tax-exempt-cert-form.html',
    Sort_Order: '34',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'pto-request',
    Form_Name: 'PTO / Time-Off Request',
    Description: 'Employee time-off request — leave type per the Employee Handbook, dates, coverage. Saves as Pending; manager approves in the Forms Inbox.',
    Category: 'Employee / HR',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/pto-request-form.html',
    Sort_Order: '42',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'injury-report',
    Form_Name: 'Employee Injury / Incident Report',
    Description: 'Same-day incident documentation — injuries, near-misses, equipment damage; DOSH 8-hour notice + L&I claim reminders printed on the form.',
    Category: 'Employee / HR',
    PDF_URL: '',
    Fill_Online_URL: '/pages/forms/injury-report-form.html',
    Sort_Order: '44',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'box-label',
    Form_Name: 'Box Label (8.5×11)',
    Description: 'Big-print label taped to the front of a finished box — order type, work order, due + drop-dead dates, customer, design, size grid. Fill online (with customer lookup) or type into the PDF.',
    Category: 'Supplies & Production',
    PDF_URL: '/forms/box-label.pdf',
    Fill_Online_URL: '/pages/forms/box-label-form.html',
    Sort_Order: '55',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'lg540-ink-order',
    Form_Name: 'Roland LG-540 Ink Order Form',
    Description: 'Ink / supplies order sheet for the Roland LG-540 printer.',
    Category: 'Supplies & Production',
    PDF_URL: '/forms/NWCA_LG540_Order_Form_1page.pdf',
    Fill_Online_URL: '',
    Sort_Order: '60',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'dtg-ink-order',
    Form_Name: 'DTG Ink Order Form',
    Description: 'DTG department ink order sheet.',
    Category: 'Supplies & Production',
    PDF_URL: '/forms/policies/dtg-ink-order-form.pdf',
    Fill_Online_URL: '',
    Sort_Order: '70',
    Is_Active: 'Yes',
  },
];

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  let exists = false;
  try { await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } }); exists = true; } catch (_) {}
  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);
  if (!exists) {
    console.log(`  ${APPLY ? 'creating' : 'would create'}: ${TABLE_DEF.Fields.map(f => f.Name).join(', ')}`);
    if (APPLY) { await axios.post(`${BASE}/tables`, TABLE_DEF, H); console.log('  ✓ table created'); }
  }

  console.log('\nSeed rows:');
  for (const r of SEED) {
    if (!APPLY) { console.log(`  would add ${r.Form_ID} → ${r.Form_Name} [${r.Category}]`); continue; }
    try {
      try { await axios.post(`${BASE}/tables/${TABLE}/records`, r, H); console.log(`  ✓ inserted ${r.Form_ID}`); }
      catch (_) {
        const { Form_ID, ...rest } = r;
        await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Form_ID='${Form_ID}'`)}`, rest, H);
        console.log(`  ✓ updated ${r.Form_ID}`);
      }
    } catch (e) { console.log(`  ❌ ${r.Form_ID}: ${e.response ? JSON.stringify(e.response.data) : e.message}`); }
  }

  if (APPLY) {
    const back = (await axios.get(`${BASE}/tables/${TABLE}/records?q.select=Form_ID,Form_Name,Category,Is_Active&q.pageSize=100`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const rows = back.Result || [];
    console.log(`\nVerify — ${rows.length} rows:`);
    rows.forEach(x => console.log(`   ${x.Form_ID} → ${x.Form_Name} [${x.Category}] active=${x.Is_Active}`));
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
