/**
 * create-blog-posts-table.js — one-time creation + seed for Caspio `Blog_Posts`.
 *
 *   node scripts/create-blog-posts-table.js          # dry-run (no writes)
 *   node scripts/create-blog-posts-table.js --apply  # create + seed
 *
 * The blog content store: Erik writes/edits posts in /dashboards/blog-editor.html
 * (or straight in Caspio) and the main site server-renders them at /blog/:slug —
 * publishing NEVER needs a deploy.
 *
 * Fields (all STRING except Body_Markdown — needs Caspio TEXT/64k):
 *   Post_ID (slug, unique) · Title · Meta_Description (SEO, ~155 chars) ·
 *   Category · Hero_Image_URL · Video_URL · Body_Markdown · Author ·
 *   Status ('Draft'/'Published') · Featured ('Yes'/'No') ·
 *   Published_At · Updated_At (ISO strings — app-managed)
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Blog_Posts';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'Post_ID', Type: 'STRING', Unique: true },
    { Name: 'Title', Type: 'STRING' },
    { Name: 'Meta_Description', Type: 'STRING' },
    { Name: 'Category', Type: 'STRING' },
    { Name: 'Hero_Image_URL', Type: 'STRING' },
    { Name: 'Video_URL', Type: 'STRING' },
    { Name: 'Body_Markdown', Type: 'TEXT' },
    { Name: 'Author', Type: 'STRING' },
    { Name: 'Status', Type: 'STRING' },
    { Name: 'Featured', Type: 'STRING' },
    { Name: 'Published_At', Type: 'STRING' },
    { Name: 'Updated_At', Type: 'STRING' },
  ],
};

const SEED = [{
  Post_ID: 'welcome-to-the-nwca-blog',
  Title: 'Welcome to the Northwest Custom Apparel Blog',
  Meta_Description: 'News, guides, and behind-the-scenes from Northwest Custom Apparel — custom embroidery, screen printing, DTG, and DTF in Milton, WA since 1977.',
  Category: 'News',
  Hero_Image_URL: 'https://cdn.caspio.com/A0E15000/Safety%20Stripes/web%20northwest%20custom%20apparel%20logo.png?ver=1',
  Video_URL: '',
  Body_Markdown: [
    'Since 1977 we\'ve decorated apparel for Northwest teams, crews, and companies — and this is where we\'ll share what we learn doing it.',
    '',
    '## What you\'ll find here',
    '',
    '- **Guides** — how to choose between embroidery, screen printing, DTG, and DTF for your project',
    '- **Behind the scenes** — how your order actually gets made in our Milton shop',
    '- **News** — new equipment, new brands, seasonal deadlines worth knowing',
    '',
    'Have a topic you want covered? Call us at 253-922-5793 or [request a quote](/pages/request-a-quote.html) and ask away.',
  ].join('\n'),
  Author: 'Northwest Custom Apparel',
  Status: 'Published',
  Featured: 'Yes',
  Published_At: new Date().toISOString(),
  Updated_At: new Date().toISOString(),
}];

(async () => {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  let exists = false;
  try { await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } }); exists = true; } catch (_) {}
  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);
  if (!exists) {
    console.log(`  ${APPLY ? 'creating' : 'would create'}: ${TABLE_DEF.Fields.map(f => `${f.Name}(${f.Type})`).join(', ')}`);
    if (APPLY) { await axios.post(`${BASE}/tables`, TABLE_DEF, H); console.log('  ✓ table created'); }
  }

  console.log('\nSeed:');
  for (const r of SEED) {
    if (!APPLY) { console.log(`  would add ${r.Post_ID}`); continue; }
    const q = await axios.get(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Post_ID='${r.Post_ID}'`)}&q.select=Post_ID`, H);
    if ((q.data.Result || []).length) { console.log(`  = exists, skipped: ${r.Post_ID}`); continue; }
    await axios.post(`${BASE}/tables/${TABLE}/records`, r, H);
    console.log(`  ✓ inserted ${r.Post_ID}`);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
  process.exit(0); // api-tracker timer keeps the loop alive — exit explicitly
})().catch(e => { console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
