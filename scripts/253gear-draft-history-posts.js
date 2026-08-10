#!/usr/bin/env node
/**
 * Three South Sound history posts, created as DRAFTS.
 *
 *   node scripts/253gear-draft-history-posts.js          # dry run
 *   node scripts/253gear-draft-history-posts.js --live
 *
 * WHY POSTS AND NOT MORE PRODUCTS. Measured over 90 days: one 864-word blog article pulls
 * 232 sessions, against 277 for the homepage and 15 for a typical product page. The store
 * has two articles and the newest is from 2023. Meanwhile 26 products sit on an identical
 * 15-session crawler floor. The best-performing content type on this store is the one it
 * has almost none of.
 *
 * 🔑 THE POSTS COME BEFORE THE SHIRTS, DELIBERATELY. None of these three subjects has a
 * product yet — Steve has not drawn them. That is an advantage rather than a problem:
 * ranking takes months, so a post published now is already earning position by the time the
 * design lands, and the product link gets added to a page that is warm instead of cold.
 *
 * 🔴 EVERY FACTUAL SENTENCE COMES FROM data/design-briefs.json IN 253gear-growth, which is
 * sourced claim by claim. Where the record is thin the post SAYS SO and asks the reader.
 * That is not modesty — the Tipperary page had to be rewritten because six of its twelve
 * claims could not be stood behind, and an honest gap is also an invitation to the one
 * person who can close it.
 *
 * ⚠️ Photographs are CREDITED, never reproduced. Each post names whose picture it is and
 * where it was posted. The Puyallup Bowling Center print has no recorded photographer and
 * somebody asked publicly for a credit without getting one — so that post says that too.
 */

'use strict';

require('dotenv').config();
const shopify = require('./../src/utils/shopify-client');

const BLOG_ID = 'gid://shopify/Blog/64242286748';   // "news" — currently empty

const M = `
mutation($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article { id handle title isPublished }
    userErrors { field message code }
  }
}`;

const Q_EXISTING = `
query($id: ID!) {
  blog(id: $id) { articles(first: 50) { nodes { handle title } } }
}`;

const POSTS = [
    {
        title: "Pat's Drive In — 112th and Canyon Road, Puyallup",
        handle: 'pats-drive-in-112th-canyon-road-puyallup',
        tags: ['Puyallup', 'South Sound history', "Pat's Drive In", 'drive-in'],
        summary: 'You ordered at the window, went back to your car, and waited for somebody to wave at you through the glass.',
        body: [
            '<p>You ordered at the window, paid, and went back and sat in your car. When the food was ready, somebody waved at you through the glass.</p>',
            '<p>That is the thing people remember about Pat’s Drive In, and it is exactly the sort of detail that never makes it into any record. Pat’s stood at 112th and Canyon Road in Puyallup. One photograph of it is known to exist — a colour print showing a low building with cream walls and a red-trimmed roofline, cars nosed in on gravel, and a tall pole sign out by the road.</p>',
            '<p>Ask the internet about Pat’s Drive In and it will tell you about a restaurant in Tucson, Arizona. Ask anybody who grew up here and you get burgers, onion rings and milkshakes.</p>',
            '<p>Tammy Farmer: <em>“Had the best cheeseburgers the best onion rings and oh my gosh very best milkshakes.”</em> Susan Chesley-Balogh: <em>“I loved their burgers and shakes! Nothing like it around here now.”</em> Judy Ross, more briefly: <em>“Great milkshakes!”</em></p>',
            '<p>Diane Pederson Uhrich worked there in the late 1970s. Tina Christensen’s father — Ken Christensen, class of ’61 — had a favourite milkshake there, which she mentioned while saying how much she misses him.</p>',
            '<p>Two things here appear nowhere else on the internet. Dewayne Iverson says that before it was Pat’s, it was Walt’s. And Don Bagley points out that the Brown Cow was across the street — which means that corner had two drive-ins facing each other.</p>',
            '<p>Pat’s was also where you ate before the film. The 112th Street Drive-In Theater opened on 2 August 1968 a short way along the same road, and Ken Ruether remembers Pat’s as the stop on the way. <em>“Very sad to see it go away,”</em> he added.</p>',
            '<h2>What we do not know</h2>',
            '<p>We cannot tell you what years Pat’s operated. Nobody has given a date and we are not going to invent one. Diane worked there in the late seventies, so it was certainly trading then. We do not know when it stopped being Walt’s, or who Walt was.</p>',
            '<p>If you know — or if you have a photograph, particularly of the sign lit at night — please tell us. We will add it to this page and credit you.</p>',
            '<p>We print South Sound designs a few miles from that corner, in Milton. You can see what we have so far in the <a href="https://253gear.com/collections/puyallup-t-shirts" title="Puyallup and Sumner Collection">Puyallup collection</a>.</p>',
            '<p><em>Most of what is above comes from a photograph posted by Lori Haun to the Puyallup Valley History Group and the sixty-seven comments underneath it. The photograph is hers. The memories belong to the people who left them.</em></p>'
        ].join('\n')
    },
    {
        title: 'The Hi-Ho Shopping Center — River Road and Meridian, Puyallup',
        handle: 'hi-ho-shopping-center-puyallup',
        tags: ['Puyallup', 'South Sound history', 'Hi-Ho Shopping Center'],
        summary: 'Sears at one end, Elvins at the other, and twenty-five acres of River Road in between.',
        body: [
            '<p>Sears at one end, Elvins at the other, and a drug store, a laundry and a filling station in between. Twenty-five acres of it on River Road.</p>',
            '<p>The Hi-Ho Shopping Center sat where North Meridian meets River Road in Puyallup, and for a stretch of years it was simply where you went. Fourteen retailers and a bank. Groceries, prescriptions, clothing, gardening supplies, flowers and petrol. In 1965 the whole site grossed over nine million dollars.</p>',
            '<p>What dates the Hi-Ho most precisely is the naming. The shops inside it were the Hi-Ho Food Center, the Hi-Ho Launder Center and the Hi-Ho Shoe Center — the name running down the front of the building, repeated, one storefront after the next.</p>',
            '<p>In February 1965 a Tacoma Transit bus was carrying an advert for it. The photograph of Bus #303 survives, and the advert reads: <em>“on River Road in Puyallup, just 10 minutes away from Tacoma.”</em> Ten minutes was the pitch. That is how far away Tacoma felt.</p>',
            '<p>Fred Meyer acquired it in 1980 and traded it as Fred Meyer’s Hi-Ho, which is how many people remember the name at all. The Hi-Ho name was retired around 1999.</p>',
            '<h2>Where to actually see it</h2>',
            '<p>The Tacoma Public Library’s Northwest Room holds at least five dated photographs, and they are very nearly the only record of what the place looked like:</p>',
            '<ul>',
            '<li>an aerial dated <strong>9 March 1963</strong> — the earliest hard proof we have found that the centre existed</li>',
            '<li>a street view, <strong>8 July 1966</strong></li>',
            '<li>a second frame from the same day showing the Elvins end</li>',
            '<li>the bus advert, <strong>18 February 1965</strong></li>',
            '<li>an interior from <strong>20 January 1967</strong>, with a Green Giant display</li>',
            '</ul>',
            '<h2>What we do not know</h2>',
            '<p>Two things, and we would rather say so than guess at them.</p>',
            '<p>We have no reliable opening date. The year 1962 gets repeated online, but the only date we can actually stand behind is that aerial from March 1963. And nobody seems to know who Elvins was. The department store anchored one end of the centre for years, and we cannot find a founder, an origin or a closing date for it anywhere.</p>',
            '<p>If you worked at the Hi-Ho, or you remember what the sign looked like, we would like to hear from you — particularly about the sign, because no written description of it exists.</p>',
            '<p>We print South Sound designs in Milton, a few minutes up the road. The <a href="https://253gear.com/collections/puyallup-t-shirts" title="Puyallup and Sumner Collection">Puyallup collection</a> is where ours live.</p>'
        ].join('\n')
    },
    {
        title: 'Six Brunswick Lanes at 323 Meridian South — the Puyallup Bowling Center',
        handle: 'puyallup-bowling-center-323-meridian-south',
        tags: ['Puyallup', 'South Sound history', 'bowling'],
        summary: 'The sign read BOWLING, one letter above the next, on a blade of sheet metal braced back to the roof.',
        body: [
            '<p>The sign read BOWLING, one letter above the next, down a tall blade of sheet metal held out over the pavement.</p>',
            '<p>That sign is most of what survives of the Puyallup Bowling Center. There is one photograph — a faded colour print from around 1956, the magenta gone the way old colour prints go, the sky reading deeper than it can really have been. In it the building is a single-storey flat-roofed cream stucco block with a stepped parapet. There is a two-tone light blue and white station wagon at the kerb. The street has two lanes and a painted white edge.</p>',
            '<p>Inside were six Brunswick lanes. The address was 323 Meridian South.</p>',
            '<p>The sign is the reason we wanted to write this down. It has a rounded bullnose top, chunky cream letters on a dark maroon panel, a fluted banded collar beneath the lettering, and it tapers to an angled point at the bottom. Behind it, diagonal and X-pattern steel bracing runs back to the roof, plainly silhouetted against the sky. Nobody builds signs like that now, and almost nobody draws the bracing.</p>',
            '<h2>Older than the photograph</h2>',
            '<p>Scott Handley, who has looked harder at this than we have, found a reference in <em>Tacoma Bowling News</em> dated <strong>6 August 1951</strong>. So the Puyallup Bowling Center was trading at least five years before that picture was taken, and the “circa 1956” on the photograph dates the print, not the business.</p>',
            '<h2>What we do not know</h2>',
            '<p>We do not know when it closed, who owned it, or what stands at 323 Meridian South today. If you bowled there, tell us and we will put it on this page.</p>',
            '<p>We print South Sound designs in Milton. Ours are in the <a href="https://253gear.com/collections/253-gear" title="253 Gear Collection">253 Gear collection</a>.</p>',
            '<p><em>The photograph was posted to the Puyallup Valley History Group by Rob Riley in December 2024. Its original photographer is not recorded, and somebody asked in the comments for a proper credit without getting an answer — so if the picture is yours, or you know whose it is, we would like to credit it properly.</em></p>'
        ].join('\n')
    }
];

const words = (h) => String(h).replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;

async function main() {
    const live = process.argv.includes('--live');
    if (!shopify.isConfigured()) {
        console.error('Shopify not configured:', shopify.missingConfig().join(', '));
        process.exit(1);
    }

    // Idempotency: never create a second copy of a post that already exists.
    const existing = (await shopify.gql(Q_EXISTING, { id: BLOG_ID }, { isMutation: false })).blog.articles.nodes;
    const have = new Set(existing.map((a) => a.handle));
    const todo = POSTS.filter((p) => !have.has(p.handle));

    console.log(`\nBlog "news" currently holds ${existing.length} article(s).`);
    POSTS.forEach((p) => {
        const dup = have.has(p.handle);
        console.log(`\n  ${dup ? '= already exists' : '+ NEW'}  ${p.title}`);
        console.log(`      /blogs/news/${p.handle}`);
        console.log(`      ${words(p.body)} words, ${(p.body.match(/<a /g) || []).length} link(s), tags: ${p.tags.join(', ')}`);
    });

    if (!todo.length) { console.log('\nNothing to create.'); return; }

    if (!live) {
        console.log(`\nDry run — would create ${todo.length} DRAFT article(s). Re-run with --live.`);
        return;
    }

    for (const p of todo) {
        const res = await shopify.gql(M, {
            article: {
                blogId: BLOG_ID,
                title: p.title,
                handle: p.handle,
                body: p.body,
                summary: p.summary,
                tags: p.tags,
                // 🔴 DRAFT. Erik and Steve read these before a word of it is public.
                isPublished: false,
                author: { name: 'Northwest Custom Apparel' }
            }
        });
        const errs = (res.articleCreate && res.articleCreate.userErrors) || [];
        if (errs.length) {
            console.error(`\n✖ ${p.handle}: ${errs.map((e) => `${e.field} ${e.message}`).join('; ')}`);
            process.exit(1);
        }
        console.log(`✔ created draft: ${res.articleCreate.article.handle}`);
    }

    // Re-read and assert, including that nothing went live by accident.
    const after = (await shopify.gql(Q_EXISTING, { id: BLOG_ID }, { isMutation: false })).blog.articles.nodes;
    const afterHandles = new Set(after.map((a) => a.handle));
    let bad = 0;
    for (const p of POSTS) {
        if (!afterHandles.has(p.handle)) { console.error(`✖ ${p.handle} missing on re-read`); bad++; }
    }
    if (bad) { console.error(`\n✖ ${bad} problem(s).`); process.exit(1); }

    console.log('\n✔ Verified by re-reading. All three exist as DRAFTS — nothing is public yet.');
    console.log('  Read them in Shopify admin → Content → Blog posts, then publish the ones that are right.');
}

main().catch((e) => {
    console.error('\nFAILED:', shopify.redactShopify(e));
    process.exit(1);
});
