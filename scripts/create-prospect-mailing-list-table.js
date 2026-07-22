#!/usr/bin/env node
/**
 * Create the `Prospect_Mailing_List` Caspio table — storage for the owner's
 * ("Jim's") manual prospect / mailing list. He types in companies he finds in
 * magazines and around the Milton area; staff add/edit/delete them on
 * /dashboards/jim-mailing-list.html.
 *
 *   node scripts/create-prospect-mailing-list-table.js          # dry-run
 *   node scripts/create-prospect-mailing-list-table.js --apply  # create the table
 *
 * Deliberately a STANDALONE list — NOT Form_Submissions. The Leads CRM table
 * fires AE auto-assignment, Slack pings and the 7:45 follow-up digest on every
 * insert; hand-typed magazine prospects must never touch that pipeline. All
 * columns STRING (house convention) except Notes (TEXT/64K). PK_ID auto-added —
 * do NOT declare it (Caspio adds the autonumber PK itself).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');

const TABLES = [
  {
    Name: 'Prospect_Mailing_List',
    Fields: [
      { Name: 'Company', Type: 'STRING' },       // the one required field
      { Name: 'Contact_Name', Type: 'STRING' },  // legacy combined "First Last (Title)" — kept for display
      { Name: 'First_Name', Type: 'STRING' },    // split for Mailchimp FNAME + sort/search by name
      { Name: 'Last_Name', Type: 'STRING' },     // split for Mailchimp LNAME
      { Name: 'Address', Type: 'STRING' },        // street
      { Name: 'City', Type: 'STRING' },
      { Name: 'State', Type: 'STRING' },
      { Name: 'Zip', Type: 'STRING' },
      { Name: 'Phone', Type: 'STRING' },
      { Name: 'Email', Type: 'STRING' },
      { Name: 'Source', Type: 'STRING' },         // where Jim found them (magazine / website)
      { Name: 'Website', Type: 'STRING' },        // company website (from Bigin, or hand-typed)
      { Name: 'Category', Type: 'STRING' },       // segment / mailing list (Bigin Tag: "Fire Dept Prospect" etc.)
      { Name: 'Notes', Type: 'TEXT' },            // free-form (TEXT — can exceed 255)
      { Name: 'Bigin_Id', Type: 'STRING' },       // source Bigin Company Id — traceability + future de-dupe (read-only)
      // Outreach tracking (any channel — physical mail or email)
      { Name: 'Status', Type: 'STRING' },          // Not contacted / Mailed / Responded / Customer / Do not mail
      { Name: 'Last_Mailed_At', Type: 'STRING' },  // ISO date of the last time we reached out
      // Mailchimp send tracking (stamped when a campaign send is recorded)
      { Name: 'Mailchimp_Status', Type: 'STRING' },    // subscribed / unsubscribed / cleaned / '' (from Mailchimp)
      { Name: 'Mailchimp_Last_Sent', Type: 'STRING' }, // ISO datetime of the last Mailchimp campaign sent to them
      { Name: 'Mailchimp_Sent_Count', Type: 'STRING' },// how many Mailchimp emails they've been sent
      { Name: 'Added_By', Type: 'STRING' },       // staff email, stamped server-side at create
      { Name: 'Created_At', Type: 'STRING' },     // ISO datetime (STRING avoids Caspio tz pitfalls)
      { Name: 'Updated_At', Type: 'STRING' },
      { Name: 'Updated_By', Type: 'STRING' },     // staff email, stamped server-side on edit
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
// Explicit exit: the caspio util keeps a token-refresh timer alive that would
// otherwise hang the process after the work is done.
main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
