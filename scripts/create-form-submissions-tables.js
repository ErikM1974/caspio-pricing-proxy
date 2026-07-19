#!/usr/bin/env node
/**
 * Create the `Form_Submissions` + `Sample_Checkout_Items` Caspio tables — storage for
 * the fillable form twins' "Save to NWCA" feature (Pricing Index /pages/forms/*) and
 * the staff Forms Inbox dashboard (/dashboards/form-submissions.html).
 *
 *   node scripts/create-form-submissions-tables.js          # dry-run
 *   node scripts/create-form-submissions-tables.js --apply  # create (no seed rows)
 *
 * Design (all STRING per house convention):
 *   Form_Submissions        — one row per saved form (any of the 4 saving twins).
 *                             Payload_JSON holds the full field set; the promoted
 *                             columns exist for Inbox filtering/queues.
 *   Sample_Checkout_Items   — one row per checked-out sample item (sample-checkout
 *                             submissions only) so items can be returned piecemeal
 *                             and the Inbox can show what's still out / overdue.
 *
 * ⚠️ sample-checkout payloads NEVER include card fields (cardholder/last4/exp/type)
 * — stripped client-side AND server-side (src/routes/form-submissions.js, jest-locked).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');

const TABLES = [
  {
    Name: 'Form_Submissions',
    Fields: [
      { Name: 'Submission_ID', Type: 'STRING', Unique: true }, // e.g. SMP0711-4821
      { Name: 'Form_ID', Type: 'STRING' },        // garment-drop-off | artwork-request | name-personalization | sample-checkout
      { Name: 'Company', Type: 'STRING' },
      { Name: 'Contact_Name', Type: 'STRING' },
      { Name: 'Phone', Type: 'STRING' },
      { Name: 'Email', Type: 'STRING' },
      { Name: 'Customer_Number', Type: 'STRING' },
      { Name: 'Sales_Rep', Type: 'STRING' },
      { Name: 'Due_Date', Type: 'STRING' },       // ISO yyyy-mm-dd when parseable, else ''
      { Name: 'Status', Type: 'STRING' },         // New / In Progress / Completed / Archived · samples: Checked Out / Partially Returned / Returned / Charged
      { Name: 'Summary', Type: 'STRING' },        // one-line list-view string built at save time
      { Name: 'Payload_JSON', Type: 'TEXT' },     // full form fields as JSON
      { Name: 'Submitted_At', Type: 'STRING' },   // ISO datetime (STRING avoids Caspio tz pitfalls)
      { Name: 'Updated_At', Type: 'STRING' },
      { Name: 'Updated_By', Type: 'STRING' },
      { Name: 'Art_Request_ID', Type: 'STRING' }, // set when an artwork-request row is pushed to Art Hub
      { Name: 'Pushed_To_ShopWorks', Type: 'STRING' }, // 'Yes' after the AEO→SW push (dup guard)
      { Name: 'ShopWorks_Order_ID', Type: 'STRING' },  // ExtOrderID written back by the push
      // Leads CRM columns (2026-07-18) — JotForm ingest + ShopWorks customer linkage
      { Name: 'External_Source', Type: 'STRING' },     // 'jotform:{formID}' — which of the 6 JotForm lead forms
      { Name: 'External_ID', Type: 'STRING' },         // JotForm submissionID — app-level dedupe key (NOT Unique: legacy rows are blank)
      { Name: 'Matched_ID_Customer', Type: 'STRING' }, // ShopWorks id_Customer (auto email-match at ingest, or staff "Link customer")
      { Name: 'Linked_Quote_ID', Type: 'STRING' },     // optional lead → quote_sessions.QuoteID link
      // Leads CRM v2 (2026-07-18) — pipeline value; linking a quote snapshots
      // its TotalAmount here so kanban $ totals cost zero extra reads
      { Name: 'Lead_Value', Type: 'STRING' },
      // Lead qualification (2026-07-19) — Claude-categorized: '' | qualified |
      // unqualified | spam. Drives the Unqualified & Spam review page; spam/
      // unqualified stay Status='Archived' (off the board) but split by this.
      { Name: 'Lead_Category', Type: 'STRING' },
    ],
  },
  {
    // Leads CRM v2 activity timeline — one row per note / status change /
    // attachment / quote link / system event on a lead. Modeled on DesignNotes
    // (src/routes/art.js). PK_ID (autonumber) doubles as chronological order.
    Name: 'Lead_Activity',
    Fields: [
      { Name: 'Submission_ID', Type: 'STRING' },  // FK → Form_Submissions.Submission_ID (e.g. JFL0718-9574)
      { Name: 'Activity_Type', Type: 'STRING' },  // note | status | attachment | quote | system (server allowlist)
      { Name: 'Activity_Text', Type: 'TEXT' },    // TEXT (64K) — notes exceed STRING's 255
      { Name: 'Attachment_URL', Type: 'STRING' }, // proxy /api/files/<key> or JotForm upload URL (server-validated)
      { Name: 'Created_By', Type: 'STRING' },     // staff email (client-sent, same trust model as Updated_By)
      { Name: 'Created_At', Type: 'STRING' },     // ISO — server nowIso() only, never client-supplied
      { Name: 'Parent_PK', Type: 'NUMBER' },      // future threading — dormant v1
    ],
  },
  {
    Name: 'Sample_Checkout_Items',
    Fields: [
      { Name: 'Submission_ID', Type: 'STRING' },  // FK → Form_Submissions.Submission_ID
      { Name: 'Line_Number', Type: 'STRING' },
      { Name: 'Source', Type: 'STRING' },
      { Name: 'Brand', Type: 'STRING' },
      { Name: 'Style', Type: 'STRING' },
      { Name: 'Description', Type: 'STRING' },
      { Name: 'Color', Type: 'STRING' },
      { Name: 'Size', Type: 'STRING' },
      { Name: 'Qty', Type: 'STRING' },
      { Name: 'Retail_Value', Type: 'STRING' },
      { Name: 'Charge_Value', Type: 'STRING' },
      { Name: 'Item_Status', Type: 'STRING' },    // Out / Returned / Charged
      { Name: 'Date_Returned', Type: 'STRING' },
      { Name: 'Condition', Type: 'STRING' },
      { Name: 'Checked_In_By', Type: 'STRING' },
    ],
  },
];

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  for (const def of TABLES) {
    let existing = null;
    try {
      const r = await axios.get(`${BASE}/tables/${def.Name}/fields`, { headers: { Authorization: `Bearer ${token}` } });
      existing = (r.data.Result || []).map(f => f.Name);
    } catch (_) {}
    console.log(`Table ${def.Name}: ${existing ? 'already exists' : 'does NOT exist'}`);
    if (!existing) {
      console.log(`  ${APPLY ? 'creating' : 'would create'}: ${def.Fields.map(f => f.Name).join(', ')}`);
      if (APPLY) { await axios.post(`${BASE}/tables`, def, H); console.log('  ✓ table created'); }
    } else {
      // field-sync: add any columns the script knows that the live table lacks
      for (const field of def.Fields) {
        if (existing.includes(field.Name)) continue;
        console.log(`  ${APPLY ? 'adding' : 'would add'} missing field: ${field.Name}`);
        if (APPLY) { await axios.post(`${BASE}/tables/${def.Name}/fields`, field, H); console.log(`  ✓ added ${field.Name}`); }
      }
    }
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
