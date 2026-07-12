/**
 * create-product-copy-table.js — one-time creation + seed for Caspio `Product_Copy`.
 *
 *   node scripts/create-product-copy-table.js          # dry-run
 *   node scripts/create-product-copy-table.js --apply  # create + seed
 *
 * WHY: every product page showed SanMar's manufacturer description — identical
 * on every dealer site in America, so Google had no reason to rank ours.
 * This table holds NWCA-written unique copy. The proxy's /api/product-details
 * merges it over PRODUCT_DESCRIPTION at read time, so the visible PDP, the
 * SSR meta description, and the Product schema all pick it up — and a SanMar
 * bulk-table reload can never clobber it. Erik edits rows directly in Caspio.
 *
 * Seed batch 1 (18 styles): the safety top-sellers, youth lineup, and the
 * blog-roadmap anchor styles. Copy is decoration/use-case focused and
 * deliberately avoids spec claims (weights/fabric %s) that could drift.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Product_Copy';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'Style', Type: 'STRING', Unique: true },
    { Name: 'Custom_Description', Type: 'TEXT' },
    { Name: 'Author', Type: 'STRING' },
    { Name: 'Updated_At', Type: 'STRING' },
  ],
};

const COPY = {
  PC55: "The Port & Company Core Blend Tee is the shirt we print more than any other for Northwest crews — a cotton-poly blend that holds its shape through job-site laundry cycles and takes screen printing beautifully, including our silver diamond-plate safety stripes. Safety Green and Safety Orange are the colors working crews order most, with your logo front and center.",
  2000: "The Gildan Ultra Cotton Tee is the pick for crews that insist on 100% cotton — a boxy, durable classic that screen prints crisply and carries embroidery without puckering. We decorate it year-round for construction companies, breweries, and events across the Puget Sound, and its huge color range makes brand-matching easy.",
  '29M': "The Jerzees Dri-POWER ACTIVE 50/50 Tee earns its spot on hot job sites: a moisture-managing blend that stays comfortable when the afternoon sun hits. It's one of our safety-color best sellers, prints cleanly with hi-vis stripe layouts, and holds up to industrial washing better than most budget tees.",
  PC55LS: "The long-sleeve version of our most-printed tee, the PC55LS covers arms against sun, scrapes, and early-morning cold without the weight of a sweatshirt. Crews order it in Safety Green with printed stripes for shoulder-season visibility; the sleeve makes a great spot for a secondary logo or employee name.",
  18500: "The Gildan Heavy Blend Hooded Sweatshirt is the classic heavyweight crew hoodie — roomy, warm, and built to survive the truck, the shop floor, and the wash. It's a favorite canvas for our printed safety stripes in blaze orange or safety green, and the front pouch and hood hold their shape after months of wear.",
  PC90H: "The Port & Company Essential Fleece Pullover Hoodie is the budget-friendly standard we decorate by the hundreds for Northwest crews — soft fleece that embroiders cleanly on the chest and takes full stripe layouts across front, back, and sleeves. In Safety Green with silver stripes, your crew is visible from the next block.",
  12500: "The Gildan DryBlend Pullover Hoodie adds a moisture-shedding blend to the classic hoodie formula — it dries faster than all-cotton fleece and resists the drizzle that defines Northwest winters. A strong mid-priced choice for crews that live outdoors, and it prints and embroiders equally well.",
  PC90HT: "Same essential fleece hoodie, cut for tall frames — because crews come in all heights and nobody likes a hoodie that rides up when they reach overhead. We stock the PC90HT in core work colors so your 6'4\" foreman matches the rest of the crew, stripes, logo, and all.",
  CSV405: "The CornerStone ANSI 107 Class 2 Mesh Back Safety Vest is the certified vest we logo most: real reflective tape, a mesh back that keeps it wearable in August, and compliance for DOT and site-spec jobs. We print or transfer your company logo without touching the certification. Printed-stripe hoodies are for every day; this is for the jobs that require the rating.",
  PC54: "The Port & Company Core Cotton Tee is the straightforward 100% cotton crewneck that anchors thousands of our orders — soft enough for everyday wear, priced for full-team runs, and available in a color wall deep enough to match almost any logo. Screen printing is its sweet spot; DTG handles the detailed full-color designs.",
  PC61: "The Port & Company Essential Tee is the PC54's heavier-duty sibling — a denser cotton hand that feels more substantial and drapes less, which crews and customers read as quality. It's our go-to recommendation when a team wants a cotton tee that survives industrial laundering, and it takes both screen printing and left-chest embroidery cleanly.",
  PC54Y: "The youth version of the Northwest's most-printed tee, the PC54Y lets kids match the crew, the team, or the family reunion exactly — same colors, same logo, scaled down. It's the backbone of our school spirit-wear and youth-team orders, sized for ages 6 through 18 and priced for full-roster runs.",
  PC90YH: "The Port & Company Youth Core Fleece Hoodie is the kid-size twin of the adult crew standard — the piece that completes the 'matching family look' our customers photograph most. Soft fleece, real pouch pocket, and it takes a printed logo just like mom's and dad's. School teams and company-family orders live here.",
  RS4400: "The Rabbit Skins Infant Baby Rib Bodysuit puts your logo on the newest member of the team — a soft ribbed-cotton bodysuit with a three-snap closure that survives real baby logistics. It's our standard new-hire baby gift and the piece that turns a company order into a family story. We print rather than embroider on infant knits, so nothing scratches.",
  RS1005: "The Rabbit Skins Infant Premium Jersey Bib might be the most-photographed item we decorate — a soft, hook-and-loop bib that carries a full logo front and center. Companies order them for employee baby gifts; teams order them for the youngest fans. Soft DTG or transfer printing keeps it comfortable and washable.",
  K500: "The Port Authority Silk Touch Polo is the front-desk and office uniform staple — a smooth, wrinkle-resistant polo that embroiders like it was designed for it (it basically was). It holds color and shape through years of Monday mornings, comes in a deep color range with a matching ladies' cut, and makes a team look coordinated without feeling like uniforms.",
  CP90: "The Port & Company Knit Cap is the winter workhorse: a snug acrylic beanie that takes a surprisingly sharp embroidered logo for its size. Crews order them by the box each fall — they're the easiest add-on to any cold-weather order and one of the most-worn pieces we decorate, on the clock and off.",
  CT100617: "The Carhartt Rain Defender Paxton Heavyweight Hooded Zip Mock Sweatshirt is the premium crew jacket in our lineup — heavyweight fleece with Carhartt's water-repellent finish and a name your crew already respects. It's the garment in our safety-stripes photos: black, striped in silver diamond-plate and hi-vis yellow, logo on the chest. When a company wants gear the crew actually keeps, this is it."
};

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

  console.log('\nSeed (insert-only — existing rows never overwritten):');
  for (const [style, desc] of Object.entries(COPY)) {
    if (!APPLY) { console.log(`  would add ${style} (${desc.length} chars)`); continue; }
    const q = await axios.get(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Style='${style}'`)}&q.select=Style`, H);
    if ((q.data.Result || []).length) { console.log(`  = exists, skipped: ${style}`); continue; }
    await axios.post(`${BASE}/tables/${TABLE}/records`, {
      Style: style, Custom_Description: desc, Author: 'Claude (batch 1, 2026-07-12)', Updated_At: new Date().toISOString(),
    }, H);
    console.log(`  ✓ inserted ${style}`);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
  process.exit(0); // api-tracker timer keeps the loop alive — exit explicitly
})().catch(e => { console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
