/**
 * blog-posts.js — Caspio `Blog_Posts` behind the blog.
 *
 * Mounted with gateWritesOnly: GETs are PUBLIC (the main site's /blog SSR and
 * the homepage teaser read them), writes need X-CRM-API-Secret (the staff
 * Blog Editor goes through the main app's /api/crm-proxy/blog-posts forwarder).
 *
 *   GET  /api/blog-posts                 → { posts } — Published only, newest
 *        first, NO bodies (list view). ?category= ?limit= (≤50).
 *        With a VALID secret header + ?status=all → drafts included (editor).
 *   GET  /api/blog-posts/:slug           → { post } — full body. Published
 *        only unless the secret header is present (editor edits drafts).
 *   POST /api/blog-posts                 → create (gated). 409 on slug collision.
 *   PUT  /api/blog-posts/:slug           → update (gated). First flip to
 *        Published stamps Published_At; every write stamps Updated_At.
 */
'use strict';
const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages, putWithRecordsAffected } = require('../utils/caspio');
const { S, nowIso, validSlug, validatePost, toRecord, toApi } = require('../utils/blog-post-helpers');
const { createTtlCache, shouldBypass } = require('../utils/ttl-cache');

const PATH = '/tables/Blog_Posts/records';

// Whole-table cache for the public reads (2026-09-09). The site caches list and
// post 5 minutes itself and still read this table through here 439 times in 19
// hours: crawlers walk every /blog/<slug> the same way they walk products, each
// site dyno expires on its own clock, and each of the site's ~17 deploys a day
// starts cold. The table is a few dozen rows, so ONE read holds every post (all
// statuses, full bodies) for 10 minutes and list/detail/404 are all answered
// from memory — at most 144 reads a day no matter how hard the blog is crawled.
// A successful POST/PUT through this router clears it, so the Blog Editor's
// publish shows on the very next read; a direct edit in Caspio lands within ten
// minutes. ?refresh=true bypasses; /api/product-cache/clear drops it too.
// Concurrent cold requests share one load; an empty read is never pinned.
const postsCache = createTtlCache({ name: 'blog-posts', ttlMs: 10 * 60 * 1000, maxEntries: 1 });
let postsLoad = null;

async function loadAllPosts(force) {
  if (!force) {
    const hit = postsCache.get('all');
    if (hit) return hit;
  }
  if (!postsLoad) {
    postsLoad = fetchAllCaspioPages(PATH, { 'q.orderBy': 'Post_ID', 'q.pageSize': 100 }, { maxPages: 10 })
      .then((rows) => {
        const all = rows || [];
        if (all.length) postsCache.set('all', all);
        return all;
      })
      .finally(() => { postsLoad = null; });
  }
  return postsLoad;
}

const publishedAtMs = (r) => {
  const t = Date.parse(r.Published_At || '');
  return Number.isFinite(t) ? t : 0;
};

const hasSecret = (req) => {
  const expected = process.env.CRM_API_SECRET;
  return !!expected && req.headers['x-crm-api-secret'] === expected;
};

// GET / — list (public: Published, no bodies)
router.get('/', async (req, res) => {
  try {
    const wantAll = req.query.status === 'all' && hasSecret(req);
    const category = S(req.query.category, 60).replace(/['"\\%_]/g, '').toLowerCase();
    const all = await loadAllPosts(shouldBypass(req));
    // Same filters the Caspio WHERE used to apply (SQL Server compares text
    // case-insensitively, so the category match stays case-insensitive),
    // newest first by Published_At.
    const rows = all
      .filter((r) => wantAll || r.Status === 'Published')
      .filter((r) => !category || String(r.Category || '').toLowerCase() === category)
      .sort((a, b) => publishedAtMs(b) - publishedAtMs(a));

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 100);
    res.json({ posts: rows.slice(0, limit).map((r) => toApi(r, { includeBody: false })) });
  } catch (e) {
    console.error('[blog-posts] list failed:', e.message);
    res.status(502).json({ error: 'Blog posts unavailable' });
  }
});

// GET /:slug — one post, full body
router.get('/:slug', async (req, res) => {
  const slug = req.params.slug;
  if (!validSlug(slug)) return res.status(400).json({ error: 'bad slug' });
  try {
    const all = await loadAllPosts(shouldBypass(req));
    const row = all.find((r) => String(r.Post_ID || '').toLowerCase() === slug);
    if (!row) return res.status(404).json({ error: 'post not found' });
    if (row.Status !== 'Published' && !hasSecret(req)) return res.status(404).json({ error: 'post not found' });
    res.json({ post: toApi(row) });
  } catch (e) {
    console.error('[blog-posts] read failed:', e.message);
    res.status(502).json({ error: 'Blog post unavailable' });
  }
});

// POST / — create (mount gate enforces the secret)
router.post('/', async (req, res) => {
  const body = req.body || {};
  const errors = validatePost(body, { requireAll: true });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  try {
    const dupe = await fetchAllCaspioPages(PATH, {
      'q.where': `Post_ID='${body.slug}'`, 'q.select': 'Post_ID', 'q.pageSize': 5,
    }, { maxPages: 1 });
    if (dupe.length) return res.status(409).json({ error: `slug "${body.slug}" already exists — pick another` });

    const rec = toRecord(body);
    rec.Status = rec.Status || 'Draft';
    rec.Featured = rec.Featured || 'No';
    rec.Updated_At = nowIso();
    rec.Published_At = rec.Status === 'Published' ? nowIso() : '';
    await makeCaspioRequest('post', PATH, {}, rec);
    postsCache.clear(); // the next public read sees the new post
    console.log(`[blog-posts] created ${body.slug} (${rec.Status})`);
    res.status(201).json({ slug: body.slug, status: rec.Status });
  } catch (e) {
    console.error('[blog-posts] create failed:', e.message);
    res.status(502).json({ error: 'Create failed — the post was NOT saved' });
  }
});

// PUT /:slug — update (mount gate enforces the secret)
router.put('/:slug', async (req, res) => {
  const slug = req.params.slug;
  if (!validSlug(slug)) return res.status(400).json({ error: 'bad slug' });
  const body = req.body || {};
  delete body.slug; // the URL is the identity — no renames via PUT (SEO: slugs are permanent)
  const errors = validatePost(body, { requireAll: false });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  try {
    const existing = await fetchAllCaspioPages(PATH, {
      'q.where': `Post_ID='${slug}'`, 'q.select': 'Post_ID,Status,Published_At', 'q.pageSize': 5,
    }, { maxPages: 1 });
    if (!existing.length) return res.status(404).json({ error: 'post not found' });

    const rec = toRecord(body);
    rec.Updated_At = nowIso();
    if (body.status === 'Published' && !S(existing[0].Published_At)) {
      rec.Published_At = nowIso(); // first publish stamps the date; re-publishes keep it
    }
    const result = await putWithRecordsAffected(PATH, `Post_ID='${slug}'`, rec);
    if (!result.RecordsAffected) return res.status(404).json({ error: 'post not found' });
    postsCache.clear(); // the next public read sees the edit
    console.log(`[blog-posts] updated ${slug}${body.status ? ' → ' + body.status : ''}`);
    res.json({ slug, updated: true });
  } catch (e) {
    console.error('[blog-posts] update failed:', e.message);
    res.status(502).json({ error: 'Update failed — the post was NOT saved' });
  }
});

module.exports = router;
