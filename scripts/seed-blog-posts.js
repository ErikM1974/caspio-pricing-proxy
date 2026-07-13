/**
 * seed-blog-posts.js — insert blog posts into Caspio `Blog_Posts` as DRAFTS.
 * Batches live as JSON arrays: [{ slug, title, metaDescription, category,
 * heroImageUrl, bodyMarkdown }, ...] in scripts/blog-posts/*.json.
 *
 *   node scripts/seed-blog-posts.js scripts/blog-posts/product-style-batch1.json "product-style batch 1"          # dry-run
 *   node scripts/seed-blog-posts.js scripts/blog-posts/product-style-batch1.json "product-style batch 1" --apply  # insert
 *
 * Insert-only + Status='Draft': existing slugs are never overwritten (Erik's edits
 * win), and NOTHING is published — posts land in the Blog Editor for review, and
 * only go public when Erik flips Status to Published. Mirrors seed-product-copy.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');
const { validatePost, toRecord, nowIso } = require('../src/utils/blog-post-helpers');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Blog_Posts';
const [, , jsonPath, batchLabel] = process.argv;
const APPLY = process.argv.includes('--apply');
const UPDATE = process.argv.includes('--update'); // update Body_Markdown/etc of EXISTING drafts (e.g. link fixes)

if (!jsonPath || !batchLabel) {
  console.error('Usage: node scripts/seed-blog-posts.js <posts.json> "<batch label>" [--apply]');
  process.exit(1);
}
const POSTS = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));
if (!Array.isArray(POSTS)) { console.error('JSON must be an array of posts'); process.exit(1); }

(async () => {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing DRAFTS)' : 'DRY-RUN'} — ${POSTS.length} posts from ${path.basename(jsonPath)}\n`);

  let added = 0, skipped = 0, rejected = 0;
  for (const p of POSTS) {
    const errors = validatePost(p, { requireAll: true });
    if (errors.length) { console.log(`  !! rejected ${p.slug || '(no slug)'}: ${errors.join('; ')}`); rejected++; continue; }
    const metaLen = (p.metaDescription || '').length;
    if (metaLen > 160) { console.log(`  !! rejected ${p.slug}: meta ${metaLen} chars (>160)`); rejected++; continue; }

    if (!APPLY) { console.log(`  would ${UPDATE ? 'UPSERT' : 'add DRAFT'} ${p.slug}  (${(p.bodyMarkdown || '').length} md chars, meta ${metaLen})`); continue; }

    const q = await axios.get(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Post_ID='${p.slug}'`)}&q.select=Post_ID`, H);
    if ((q.data.Result || []).length) {
      if (!UPDATE) { console.log(`  = exists, skipped: ${p.slug}`); skipped++; continue; }
      // --update: refresh content fields (title/meta/hero/category/body) but NEVER touch
      // Status or Published_At — so an already-published post stays published and a draft stays draft.
      const upd = toRecord(p);
      delete upd.Status; delete upd.Featured; delete upd.Published_At;
      upd.Updated_At = nowIso();
      const r = await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Post_ID='${p.slug}'`)}`, upd, H);
      console.log(`  ~ updated: ${p.slug} (RecordsAffected=${r.data.RecordsAffected})`);
      added++;
      continue;
    }
    if (UPDATE) { console.log(`  ?? --update but slug not found, skipped: ${p.slug}`); skipped++; continue; }

    const rec = toRecord(p);
    rec.Status = 'Draft';
    rec.Featured = 'No';
    rec.Published_At = '';
    rec.Updated_At = nowIso();
    rec.Author = rec.Author || `Claude (${batchLabel})`;
    await axios.post(`${BASE}/tables/${TABLE}/records`, rec, H);
    console.log(`  + DRAFT created: ${p.slug}`);
    added++;
  }
  console.log(`\n${APPLY ? `Done: ${added} drafts created, ${skipped} already existed, ${rejected} rejected. Review + publish in the Blog Editor.` : `Dry-run only (${rejected} rejected). Re-run with --apply to create drafts.`}`);
  process.exit(0); // api-tracker timer keeps the loop alive — exit explicitly
})().catch((e) => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
