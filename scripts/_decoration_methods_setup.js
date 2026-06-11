// One-off setup helper for the Decoration Method Eligibility tables (2026-06-11).
// Uses the proxy's own Caspio credential machinery (src/utils/caspio + src/config).
// Subcommands:
//   node scripts/_decoration_methods_setup.js fields <TableName>   — dump field defs (type vocabulary)
//   node scripts/_decoration_methods_setup.js tables               — list table names
//   node scripts/_decoration_methods_setup.js create               — create the two tables
//   node scripts/_decoration_methods_setup.js seed                 — seed Decoration_Method_Rules + CRUD-prove Overrides
//   node scripts/_decoration_methods_setup.js verify               — read back both tables

const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');

async function caspio(method, path, data = null, params = {}) {
  const token = await getCaspioAccessToken();
  const res = await axios({
    method,
    url: `${config.caspio.apiBaseUrl}${path}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data,
    params,
    timeout: config.timeouts.perRequest
  });
  return res;
}

// Erik-approved matrix (2026-06-11). Category strings must match live CATEGORY_NAME facets exactly.
const RULES = [
  { Category: 'T-Shirts',            EMB: true, DTG: true, SCP: true, DTF: true, DTG_CottonGate: true, Notes: 'All methods; DTG requires cotton check' },
  { Category: 'Sweatshirts/Fleece',  EMB: true, DTG: true, SCP: true, DTF: true, DTG_CottonGate: true, Notes: 'All methods; DTG requires cotton check' },
  { Category: 'Polos/Knits',         EMB: true, DTG: true, SCP: false,  DTF: true, DTG_CottonGate: true, Notes: 'No screen print on polos' },
  { Category: 'Ladies',              EMB: true, DTG: true, SCP: true, DTF: true, DTG_CottonGate: true, Notes: 'All methods; DTG requires cotton check' },
  { Category: 'Youth',               EMB: true, DTG: true, SCP: true, DTF: true, DTG_CottonGate: true, Notes: 'All methods; DTG requires cotton check' },
  { Category: 'Tall',                EMB: true, DTG: true, SCP: true, DTF: true, DTG_CottonGate: true, Notes: 'All methods; DTG requires cotton check' },
  { Category: 'Infant & Toddler',    EMB: true, DTG: true, SCP: true, DTF: true, DTG_CottonGate: true, Notes: 'All methods; DTG requires cotton check' },
  { Category: 'Activewear',          EMB: true, DTG: false,  SCP: true, DTF: true, DTG_CottonGate: false,  Notes: 'Poly performance fabric - no DTG' },
  { Category: 'Woven Shirts',        EMB: true, DTG: false,  SCP: false,  DTF: false,  DTG_CottonGate: false,  Notes: 'Embroidery only' },
  { Category: 'Outerwear',           EMB: true, DTG: false,  SCP: false,  DTF: false,  DTG_CottonGate: false,  Notes: 'Embroidery only' },
  { Category: 'Workwear',            EMB: true, DTG: false,  SCP: false,  DTF: false,  DTG_CottonGate: false,  Notes: 'Embroidery only' },
  { Category: 'Caps',                EMB: false,  DTG: false,  SCP: false,  DTF: false,  DTG_CottonGate: false,  Notes: 'Cap embroidery handled by separate CAP branch on product page' },
  { Category: 'Bags',                EMB: true, DTG: false,  SCP: false,  DTF: false,  DTG_CottonGate: false,  Notes: 'Embroidery only' },
  { Category: 'Accessories',         EMB: true, DTG: false,  SCP: false,  DTF: false,  DTG_CottonGate: false,  Notes: 'Embroidery only' },
  { Category: 'Personal Protection', EMB: true, DTG: false,  SCP: true, DTF: true, DTG_CottonGate: false,  Notes: 'No DTG' }
];

const RULES_TABLE = {
  Name: 'Decoration_Method_Rules',
  Note: 'Category-level decoration method eligibility (Erik-approved matrix 2026-06-11). Served by GET /api/decoration-methods.',
  Columns: [
    { Name: 'Category',       Type: 'STRING', Unique: true, Description: 'Exact live CATEGORY_NAME facet value' },
    { Name: 'EMB',            Type: 'YES/NO' },
    { Name: 'DTG',            Type: 'YES/NO' },
    { Name: 'SCP',            Type: 'YES/NO' },
    { Name: 'DTF',            Type: 'YES/NO' },
    { Name: 'DTG_CottonGate', Type: 'YES/NO', Description: 'If Yes, DTG additionally requires cotton-content check' },
    { Name: 'Notes',          Type: 'STRING' }
  ]
};

const OVERRIDES_TABLE = {
  Name: 'Decoration_Method_Overrides',
  Note: 'Per-style decoration method overrides (beats category rule). Served by GET /api/decoration-methods.',
  Columns: [
    { Name: 'StyleNumber', Type: 'STRING', Description: 'SanMar STYLE, e.g. PC54' },
    { Name: 'Method',      Type: 'STRING', Description: 'EMB | DTG | SCP | DTF' },
    { Name: 'Allow',       Type: 'YES/NO' },
    { Name: 'Note',        Type: 'STRING' }
  ]
};

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'fields') {
    const table = process.argv[3];
    const res = await caspio('get', `/tables/${table}/fields`);
    console.log(JSON.stringify(res.data, null, 2));

  } else if (cmd === 'tables') {
    const res = await caspio('get', '/tables');
    console.log(JSON.stringify(res.data, null, 2));

  } else if (cmd === 'create') {
    for (const def of [RULES_TABLE, OVERRIDES_TABLE]) {
      const res = await caspio('post', '/tables', def);
      console.log(`CREATED ${def.Name} -> HTTP ${res.status}`);
    }

  } else if (cmd === 'addfields') {
    // Caspio v3 POST /tables returned 201 but ignored the Columns array (tables
    // came back with zero fields) — add each field explicitly via /fields.
    for (const def of [RULES_TABLE, OVERRIDES_TABLE]) {
      const existing = await caspio('get', `/tables/${def.Name}/fields`);
      const have = new Set((existing.data.Result || []).map(f => f.Name));
      for (const col of def.Columns) {
        if (have.has(col.Name)) {
          console.log(`SKIP ${def.Name}.${col.Name} (already exists)`);
          continue;
        }
        const body = {
          Name: col.Name,
          Type: col.Type,
          Unique: !!col.Unique,
          Description: col.Description || '',
          Label: ''
        };
        const res = await caspio('post', `/tables/${def.Name}/fields`, body);
        console.log(`ADDED ${def.Name}.${col.Name} (${col.Type}) -> HTTP ${res.status}`);
      }
    }

  } else if (cmd === 'seed') {
    // Seed the rules matrix
    let created = 0;
    for (const row of RULES) {
      const res = await caspio('post', '/tables/Decoration_Method_Rules/records', row, { 'response': 'rows' });
      created++;
      console.log(`SEEDED ${row.Category} -> HTTP ${res.status}`);
    }
    console.log(`RULES SEEDED: ${created}`);

    // Prove Overrides CRUD with one documented example row, then delete it.
    const example = {
      StyleNumber: 'EXAMPLE-DELETE-ME',
      Method: 'DTG',
      Allow: false,
      Note: 'CRUD smoke test row - created and deleted by _decoration_methods_setup.js'
    };
    const post = await caspio('post', '/tables/Decoration_Method_Overrides/records', example, { 'response': 'rows' });
    console.log(`OVERRIDE EXAMPLE CREATED -> HTTP ${post.status}: ${JSON.stringify(post.data)}`);
    const read = await fetchAllCaspioPages('/tables/Decoration_Method_Overrides/records', {
      'q.where': "StyleNumber='EXAMPLE-DELETE-ME'"
    });
    console.log(`OVERRIDE EXAMPLE READ BACK -> ${JSON.stringify(read)}`);
    const del = await caspio('delete', '/tables/Decoration_Method_Overrides/records', null, {
      'q.where': "StyleNumber='EXAMPLE-DELETE-ME'"
    });
    console.log(`OVERRIDE EXAMPLE DELETED -> HTTP ${del.status}: ${JSON.stringify(del.data)}`);

  } else if (cmd === 'verify') {
    const rules = await fetchAllCaspioPages('/tables/Decoration_Method_Rules/records', { 'q.limit': 100 });
    const overrides = await fetchAllCaspioPages('/tables/Decoration_Method_Overrides/records', { 'q.limit': 100 });
    console.log('RULES>>>', JSON.stringify(rules, null, 2));
    console.log('OVERRIDES>>>', JSON.stringify(overrides));

  } else {
    console.error('Usage: node scripts/_decoration_methods_setup.js fields|tables|create|seed|verify');
    process.exit(1);
  }
}

// Explicit exit: axios keep-alive sockets otherwise hold the event loop open
// after the work is done (Node >= 19 enables agent keepAlive by default).
main().then(() => process.exit(0)).catch(e => {
  console.error('ERR', e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
  process.exit(1);
});
