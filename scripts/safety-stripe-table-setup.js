// One-time setup for the Caspio table `Safety_Stripe_Top_Sellers_2026`
// (backs GET /api/safety-stripes/top-sellers). Idempotent: inspects the table's
// existing fields and ADDS only the missing ones via POST /tables/{name}/fields.
// Caspio v3 table-create takes "Fields" (not "Columns"); a first run that used
// "Columns" created the table with only its default PK_ID — this backfills the rest.
//
//   node scripts/safety-stripe-table-setup.js
//
// Product image/title/colors hydrate from SanMar at request time, so this table
// stores ONLY curated metadata: style + safety-color + rank + note.

const { makeCaspioRequest } = require('../src/utils/caspio');

const TABLE = 'Safety_Stripe_Top_Sellers_2026';

// is_active is a Text field storing 'Yes'/'No' (route's isActiveRow tolerates it).
const DESIRED = [
  { Name: 'style', Type: 'STRING', Length: 255 },
  { Name: 'style_rank', Type: 'INTEGER' },
  { Name: 'product_title', Type: 'STRING', Length: 255 },
  { Name: 'category', Type: 'STRING', Length: 255 },
  { Name: 'color_name', Type: 'STRING', Length: 255 },
  { Name: 'catalog_color', Type: 'STRING', Length: 255 },
  { Name: 'color_rank', Type: 'INTEGER' },
  { Name: 'units_sold', Type: 'INTEGER' },
  { Name: 'is_active', Type: 'STRING', Length: 10 },
  { Name: 'best_for', Type: 'STRING', Length: 255 },
];

(async () => {
  let existing = [];
  try {
    const fields = await makeCaspioRequest('get', `/tables/${TABLE}/fields`);
    const arr = Array.isArray(fields) ? fields : (fields.Result || fields.Fields || []);
    existing = arr.map((f) => f.Name);
  } catch (e) {
    console.error('GET_FIELDS_FAILED', e.message);
  }
  console.log('EXISTING_FIELDS', JSON.stringify(existing));

  for (const f of DESIRED) {
    if (existing.includes(f.Name)) { console.log('SKIP', f.Name); continue; }
    try {
      await makeCaspioRequest('post', `/tables/${TABLE}/fields`, {}, f);
      console.log('ADDED', f.Name);
    } catch (e) {
      console.error('ADD_FAILED', f.Name, e.message);
    }
  }
  console.log('DONE');
})();
