// blog-post-helpers.js — pure helpers for src/routes/blog-posts.js.
// Imports NOTHING (utils/caspio's api-tracker timer keeps jest's event loop
// alive) so tests/jest/blog-posts.test.js can import these directly.
'use strict';

const S = (v, max = 255) => String(v == null ? '' : v).trim().slice(0, max);
const nowIso = () => new Date().toISOString();

// slugs are the URL + the Caspio key: lowercase kebab, no leading/trailing
// dashes, 3–80 chars. slugify() builds one from a title; validSlug() gates
// what the API accepts (also blocks path tricks like '..' by construction).
function slugify(title) {
  return S(title, 120)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

const validSlug = (v) => typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/.test(v) && v.length >= 3;

const STATUSES = ['Draft', 'Published'];
const MAX_BODY = 60000; // Caspio TEXT field is 64k — leave headroom

function validatePost(body, { requireAll = true } = {}) {
  const errors = [];
  if (requireAll || body.slug !== undefined) {
    if (!validSlug(body.slug)) errors.push('slug must be 3-80 chars of lowercase letters, digits, and dashes');
  }
  if (requireAll || body.title !== undefined) {
    if (!S(body.title)) errors.push('title is required');
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    errors.push(`status must be one of: ${STATUSES.join(', ')}`);
  }
  if (body.bodyMarkdown !== undefined && String(body.bodyMarkdown).length > MAX_BODY) {
    errors.push(`bodyMarkdown is over ${MAX_BODY} characters — split the post`);
  }
  return errors;
}

// API shape ←→ Caspio row
function toRecord(body) {
  const rec = {};
  if (body.slug !== undefined) rec.Post_ID = S(body.slug, 80);
  if (body.title !== undefined) rec.Title = S(body.title);
  if (body.metaDescription !== undefined) rec.Meta_Description = S(body.metaDescription);
  if (body.category !== undefined) rec.Category = S(body.category, 60);
  if (body.heroImageUrl !== undefined) rec.Hero_Image_URL = S(body.heroImageUrl, 500);
  if (body.videoUrl !== undefined) rec.Video_URL = S(body.videoUrl, 500);
  if (body.bodyMarkdown !== undefined) rec.Body_Markdown = String(body.bodyMarkdown).slice(0, MAX_BODY);
  if (body.author !== undefined) rec.Author = S(body.author, 120);
  if (body.status !== undefined) rec.Status = S(body.status, 20);
  if (body.featured !== undefined) rec.Featured = body.featured === 'Yes' || body.featured === true ? 'Yes' : 'No';
  return rec;
}

function toApi(row, { includeBody = true } = {}) {
  const out = {
    slug: row.Post_ID,
    title: row.Title || '',
    metaDescription: row.Meta_Description || '',
    category: row.Category || '',
    heroImageUrl: row.Hero_Image_URL || '',
    videoUrl: row.Video_URL || '',
    author: row.Author || '',
    status: row.Status || 'Draft',
    featured: row.Featured === 'Yes' ? 'Yes' : 'No',
    publishedAt: row.Published_At || '',
    updatedAt: row.Updated_At || '',
  };
  if (includeBody) out.bodyMarkdown = row.Body_Markdown || '';
  return out;
}

module.exports = { S, nowIso, slugify, validSlug, validatePost, toRecord, toApi, STATUSES, MAX_BODY };
