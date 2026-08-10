#!/usr/bin/env node
/**
 * Publish the three South Sound history posts. Erik's explicit call, 10 Aug 2026.
 *
 *   node scripts/253gear-publish-history-posts.js          # dry run
 *   node scripts/253gear-publish-history-posts.js --live
 *
 * These went up as drafts first so Erik and Steve could read them; this flips them public.
 *
 * WHY IT MATTERS THAT THIS IS A SEPARATE SCRIPT. Creating a draft is reversible and private.
 * Publishing is neither. Keeping the two apart means nobody can accidentally make three
 * pages public by re-running a create, and the moment of going live has its own dry run.
 *
 * ⚠️ `isPublished: true` alone is not proof. The verification re-reads each article AND
 * checks `publishedAt` is actually set — the same trap the product publisher hit, where
 * status said ACTIVE while the storefront still 404'd.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const BLOG_ID = 'gid://shopify/Blog/64242286748';   // "news"

const HANDLES = [
    'pats-drive-in-112th-canyon-road-puyallup',
    'hi-ho-shopping-center-puyallup',
    'puyallup-bowling-center-323-meridian-south'
];

const Q = `
query($id: ID!) {
  blog(id: $id) {
    handle
    articles(first: 50) { nodes { id handle title isPublished publishedAt } }
  }
}`;

const M = `
mutation($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id handle isPublished publishedAt }
    userErrors { field message code }
  }
}`;

async function fetchArticles() {
    const d = await shopify.gql(Q, { id: BLOG_ID }, { isMutation: false });
    return { blogHandle: d.blog.handle, articles: d.blog.articles.nodes };
}

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    const { blogHandle, articles } = await fetchArticles();
    const byHandle = new Map(articles.map((a) => [a.handle, a]));

    const plan = [];
    for (const h of HANDLES) {
        const a = byHandle.get(h);
        if (!a) {
            console.error(`\n✖ ${h} does not exist. Run 253gear-draft-history-posts.js first.`);
            process.exit(1);
        }
        if (a.isPublished) { console.log(`  = already published: ${h}`); continue; }
        plan.push(a);
    }

    if (!plan.length) { console.log('\nNothing to publish.'); return; }

    console.log('\nWill publish:');
    plan.forEach((a) => {
        console.log(`  • ${a.title}`);
        console.log(`      https://253gear.com/blogs/${blogHandle}/${a.handle}`);
    });

    if (!live) {
        console.log(`\nDry run — ${plan.length} article(s) would go PUBLIC. Re-run with --live.`);
        return;
    }

    for (const a of plan) {
        const res = await shopify.gql(M, { id: a.id, article: { isPublished: true } });
        const errs = (res.articleUpdate && res.articleUpdate.userErrors) || [];
        if (errs.length) {
            console.error(`\n✖ ${a.handle}: ${errs.map((e) => `${e.field} ${e.message}`).join('; ')}`);
            process.exit(1);
        }
        console.log(`✔ published ${a.handle}`);
    }

    // Re-read. isPublished true with a null publishedAt is the shape that 404s.
    const after = (await fetchArticles()).articles;
    let bad = 0;
    for (const h of HANDLES) {
        const a = after.find((x) => x.handle === h);
        if (!a || !a.isPublished) { console.error(`✖ ${h} is not published on re-read`); bad++; continue; }
        if (!a.publishedAt) { console.error(`✖ ${h} says published but publishedAt is null — it will 404`); bad++; }
    }
    if (bad) { console.error(`\n✖ ${bad} problem(s).`); process.exit(1); }

    console.log('\n✔ Verified by re-reading: all three published, each with a publishedAt set.');
    HANDLES.forEach((h) => console.log(`   https://253gear.com/blogs/${blogHandle}/${h}`));
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
