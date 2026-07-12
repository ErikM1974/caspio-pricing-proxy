/**
 * seed-product-copy-batch2.js — batch 2 of NWCA-written product copy (45 styles).
 *
 *   node scripts/seed-product-copy-batch2.js          # dry-run
 *   node scripts/seed-product-copy-batch2.js --apply  # insert missing rows
 *
 * Insert-only: never overwrites an existing Product_Copy row, so Erik's Caspio
 * edits always win. Styles chosen by REAL sales rank — DTG top-20 (units sold)
 * + EMB 10-year curated top-sellers + blog-roadmap anchor styles + ladies'
 * companions. Sales figures cited in the copy come from those exports
 * (rounded down, safe to age). No fabric-%/oz claims beyond what the SanMar
 * title itself states.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Product_Copy';
const APPLY = process.argv.includes('--apply');

const COPY = {
  // ---------- T-shirts ----------
  PC450: "Crews have taken home more than 9,000 of these from our Milton shop, and the reason is simple: the Fan Favorite is the softer, lighter take on the classic cotton tee — closer to a retail shirt than a uniform. It drapes better than a standard workhorse tee, prints beautifully, and costs barely more. When a customer says 'like the usual one, but softer,' this is the answer.",
  PC61LS: "The long-sleeve Essential Tee is what Northwest crews wear from October to May — the same dense, durable cotton as the short-sleeve PC61 with coverage for cold mornings and sun-exposed afternoons. Nearly 3,000 have gone through our printers. The forearm makes a natural home for a company name or a safety-stripe wrap.",
  DT6000: "District's Very Important Tee is the one we suggest when a team skews younger or the shirt needs to feel like something you'd buy at a mall, not get issued at work — soft, modern fit, colors that photograph well. It's a favorite canvas for full-color DTG prints, where its smooth surface lets fine detail through.",
  PC150: "Ring spun cotton has a smoother, tighter surface than standard tees, and that's exactly why we reach for the PC150 when artwork has fine lines or small text — the print sits crisp instead of sinking into the weave. Almost 2,000 decorated here so far, most of them designs that would blur on a coarser shirt.",
  PC600: "The Bouncer Tee is Port & Company's heavyweight — a thick, boxy cut that landed as streetwear and stuck around because crews love the substantial feel. It shrugs off job-site abuse, and the wide, flat chest is a big canvas for bold prints. If your team keeps asking for 'those heavier shirts,' this is the one.",
  PC54LS: "Take the most-printed tee in our shop and add sleeves: the PC54LS is the long-sleeve twin of the Core Cotton Tee, same deep color wall, same easy-printing cotton, same full-roster price point. Teams that order PC54s for summer come back for these when the Northwest weather turns.",
  DT104: "District's Perfect Weight Tee threads the needle — enough body to feel substantial, light enough to wear year-round indoors. The fit is trimmer and more modern than a traditional boxy tee, which makes it a regular pick for tech offices, taprooms, and anyone who wants staff shirts people actually keep wearing.",
  BC3001CVC: "The heathered version of BELLA+CANVAS's famous retail tee — the cotton-poly blend gives it those soft, melange colors that read 'brand' instead of 'uniform.' Startups, breweries, and event teams pick it when the shirt is the marketing. It prints beautifully; ask us about designs that play off the heather texture.",
  NL3600: "Next Level built its reputation on this shirt: a cotton tee soft enough that people double-check the label. We print it for customers who want giveaway or merch shirts that get worn instead of donated — it costs a little more than a standard tee and gets kept a lot longer. DTG full-color work especially shines on it.",
  DT5000: "The Concert Tee earns its name — light, drapey, and cut like the shirt you'd buy at the merch table. It's our go-to for bands, events, and retail-style company merch where a heavy workwear tee would feel wrong. The lighter fabric takes soft-hand prints that move with the shirt.",
  2300: "A pocket changes who buys the shirt: the Gildan Ultra Cotton Pocket Tee is the trades' pick — pencils, glasses, phone — in the same durable 100% US cotton as the pocketless classic. We've decorated more than a thousand, usually with a left-chest logo over the pocket or a bold back print. A working shirt in the most literal sense.",
  CTK126: "Carhartt's Workwear Pocket Long Sleeve is what crews request by brand name — the pocket for the job site, the sleeve for the weather, the label for the respect. Embroidery over the pocket keeps the workwear look; we've stitched hundreds for construction and excavation companies who want gear the crew won't leave in the truck.",
  1717: "Comfort Colors dyes the garment after it's sewn, which is why every 1717 has those soft, sun-washed colors nobody else quite matches. It's the heavyweight tee behind half the retail merch you've seen lately — breweries, coffee roasters, and destination businesses pick it when the shirt has to sell itself. Prints best with designs that lean into the vintage look.",
  DT6000Y: "The youth cut of District's Very Important Tee brings the same soft feel and modern fit down to school sizes — it's a staple of our spirit-wear and youth-team orders. Kids notice scratchy shirts more than adults do; this one passes the kid test, and the smooth surface takes detailed full-color prints cleanly.",
  LPC54: "The women's-cut companion to the PC54 — same cotton, same color wall, tailored fit instead of a shrunken men's box. When we build a company order, pairing PC54 and LPC54 lets every employee get the same shirt in a cut that actually fits. If you're ordering unisex for a mixed team, ask us about splitting the run; it costs nothing extra.",

  // ---------- Sweatshirts / fleece ----------
  PC78H: "Add the print orders to the embroidery orders and the Core Fleece Hoodie clears five thousand units through our shop — it's the default crew hoodie of the Northwest. Soft fleece, honest pouch pocket, a price that works at full-roster quantities, and it takes a left-chest logo or a full safety-stripe layout equally well.",
  ST254: "Sport-Tek's pullover hoodie is the team-sideline standard — we decorate it for schools, clubs, and rec leagues that want an athletic look without an athletic price. The smooth fleece face holds screen-printed numbers and mascots crisply, and the color range covers most team palettes straight off the shelf.",
  PC850H: "The Fan Favorite Fleece Hoodie is the softest of the Port & Company hoodie family — the one that feels like a retail sweatshirt, not a uniform piece. Companies choose it for employee gifts and holiday orders where comfort is the point. It embroiders cleanly and the fleece face flatters a big printed graphic.",
  CTK121: "Over a hundred separate orders for the Carhartt Midweight Hooded Sweatshirt have come through our embroidery department — construction, excavation, and logging crews reorder it season after season. The loose Carhartt fit layers over work shirts, and an embroidered left-chest logo on that label earns instant credibility on any job site.",
  F281: "Sport-Tek calls this the Super Heavyweight and means it — the warmest pullover hoodie we stock, built for crews that work outside through a Northwest winter. More than 1,300 have left our shop with logos on them, most headed for landscaping, marine, and utility companies whose people live in them from November on.",
  PC78ZH: "The full-zip version of the Northwest's default crew hoodie — same soft Core Fleece, but it goes on and off over a hard hat and layers open when the afternoon warms up. Foremen tend to pick the zip; crews tend to get the pullover. Order both decorated identically and everyone matches.",
  LST253: "The women's quarter-zip is the piece that disappears first from office swag closets — a smooth sweatshirt knit with a flattering cut that works over a polo or under a jacket. We embroider it for front-office teams, medical groups, and school staff; pair it with the men's quarter-zip for a matched program.",
  LPC78H: "The women's-cut Core Fleece Hoodie — same fleece, same colors, same price neighborhood as the unisex PC78H, tailored through the body instead of boxy. Mixed crews get one hoodie program in two cuts and everybody's actually comfortable. It takes printed stripes and embroidered logos just like its unisex twin.",

  // ---------- Polos ----------
  CS410: "Security teams, EMS, and uniformed staff wear polos hard, and snag-proof knit is the difference between six months and three years of service — the CornerStone Tactical adds mic and pen functionality to that fabric. We embroider names, badges, and unit marks on hundreds of these; it's a uniform polo that's genuinely built like one.",
  CS412: "The non-tactical sibling of our most-ordered uniform polo: the same snag-proof knit that survives daily wear and industrial washing, in a clean everyday cut. Field-service and facilities companies standardize on it because a year in, the polos still look issued-last-week. Embroidered logos and employee names are its bread and butter.",
  ST650: "Nearly 3,000 units across 170 orders make the Micropique Sport-Wick our most-embroidered polo, full stop. The wicking knit stays presentable through a full shift, the price holds at team quantities, and the color range is deep enough to match almost any logo. When a company says 'we need polos,' this is where we start.",
  NKDC1963: "Sometimes the swoosh is the point. The Nike Dri-FIT Micro Pique 2.0 is our pick when polos are a client gift, a golf-day piece, or a management order — the brand carries weight an equivalent no-name polo can't. We've embroidered over 1,600 of them; the fine pique face takes small text and detailed logos cleanly.",
  ST657: "The long-sleeve Micropique Sport-Wick solves a specific Northwest problem: staff who need to look uniformed year-round without layering a sweatshirt over the logo. Same wicking knit as our most-popular polo, same colors, sleeves for the other eight months. Front-desk and field teams split their orders between the two.",
  OG101: "OGIO's Caliber2.0 is the polo for companies that find traditional polos a little stiff — a modern cut with stretch that moves, in colors with some attitude. Sales teams and tech companies pick it to look sharp without looking corporate. The knit embroiders beautifully; we run it with tone-on-tone thread a lot.",
  LST650: "The women's Micropique Sport-Wick pairs with the unisex ST650 — the same wicking pique in a tailored cut with a feminine placket. Together they're the backbone of most polo programs we run: one fabric, one color, one logo, two cuts, everyone comfortable. Order them in the same run and the embroidery matches exactly.",

  // ---------- Outerwear ----------
  J317: "The most-embroidered jacket in our shop — more than 800 Core Soft Shells across 120-plus orders. Soft shell is the Northwest answer to weather that can't decide: it blocks wind and shrugs off drizzle while staying comfortable indoors. The smooth chest panel takes an embroidered logo perfectly, which is exactly why every company seems to have one.",
  CT102286: "The Gilliam Vest is what happens when Carhartt makes a layering piece: a quilted vest crews wear over hoodies October through June. It leaves the arms free for real work, and the chest embroiders cleanly. One of our most-reordered outerwear pieces — companies buy a batch, the crew actually wears them, and the next hires need theirs.",
  J333: "When the forecast says rain — so, here, most of the time — the Torrent is the jacket we recommend first: genuinely waterproof, light enough to stuff behind a truck seat, priced for whole-crew orders. Port Authority's shell fabric takes embroidery well, and 750-plus of them have gone out our door with company logos on the chest.",
  CT102208: "The jacket version of Carhartt's Gilliam line — light insulation, real pockets, and the name that means something on a job site. It fills the gap between a hoodie and a winter coat, which in the Puget Sound is about nine months of the year. We embroider it constantly for construction and field-service companies.",
  CT103828: "Duck canvas is the fabric Carhartt built its name on, and the Detroit is the jacket: stiff at first, broken-in and personal after a season, tough throughout. Crews request it by name. An embroidered company logo on that blanket-lined canvas is about as Pacific Northwest workwear as it gets — we've done nearly 700 of them.",

  // ---------- Caps ----------
  C112: "The single most-decorated style in our shop's history — over 14,000 of these trucker caps across nearly 300 orders. The foam front panel is a perfect flat stage for embroidery or a patch, the mesh back keeps it comfortable, and the snapback fits everyone, which makes ordering for a whole crew painless. There's a reason it's everywhere.",
  C865: "The Flexfit band is why this cap gets reordered: no snaps, no velcro, just a fitted feel that covers the whole crew in two sizes. We've embroidered 4,600 of them — it's the step-up cap companies choose when the trucker style feels too casual. The structured front takes a clean, dimensional logo.",
  CP80: "The plain six-panel twill cap has outlived every headwear trend for a reason — it's inexpensive, it fits under what needs to fit over it, and it takes an embroidered logo without fuss. We've run more than 2,000 for crews, events, and giveaways. When the answer is 'just a normal hat with our logo,' this is the hat.",
  NE201: "New Era makes the caps the pros wear, and the NE201 brings that pedigree to the relaxed, unstructured shape everyone actually reaches for on the weekend. It's the 'dad cap' with a big-league label — taprooms, coffee shops, and brands that care about the details pick it. The low-profile front suits a small, clean embroidered mark.",

  // ---------- Workwear / wovens / safety ----------
  SP24: "The classic mechanic's shirt, straight from Red Kap's industrial uniform heritage — a work shirt built for shops, fleets, and service bays. We embroider company logos on one chest side and employee names on the other, the way shop shirts have been done forever. More than 700 have gone through our machines.",
  S508: "The short-sleeve Easy Care is the button-down we recommend for uniform programs: wrinkle-resistant enough to look pressed at hour ten, priced to outfit a full staff, and available in enough colors to match a brand. Office teams, dispatchers, and counter staff wear these with an embroidered left-chest logo — we've done over 500.",
  S608: "The long-sleeve half of Port Authority's Easy Care pair, and our most-embroidered dress shirt — 79 separate orders and counting. It's the staple of office and customer-facing uniform programs: wrinkle-resistant, brand-colored, professional without a tie. Most companies order it alongside the short-sleeve S508 and let staff choose.",
  CSV400: "The standard-issue ANSI 107 Class 2 vest: solid construction, real reflective tape, and the certification DOT and site-spec jobs require. We add company logos by print or transfer without touching the compliance. If your crew works summers in it, look at the mesh-back CSV405; if you need the classic all-season vest, this is it.",
  CSV100: "The economy answer to a common problem: visitors, subs, and new hires need certified vests, and they need a stack of them. The CSV100 is ANSI 107 Class 2 compliant, all-mesh so it wears over anything, with a pocket for the essentials — at a price that makes sense to buy by the box. Logo it once and every vest on site is on-brand.",
  ST350: "Summer job sites and the PosiCharge Competitor Tee go together — a light, wicking performance shirt whose colors are locked in so they survive industrial laundry without fading onto everything else. Landscaping and athletic crews order it by the stack when cotton gets heavy in July. Prints cleanly with soft-hand inks that don't block the wicking.",
};

(async () => {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} — ${Object.keys(COPY).length} styles\n`);

  let added = 0, skipped = 0;
  for (const [style, desc] of Object.entries(COPY)) {
    if (!APPLY) { console.log(`  would add ${style} (${desc.length} chars)`); continue; }
    const q = await axios.get(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Style='${style}'`)}&q.select=Style`, H);
    if ((q.data.Result || []).length) { console.log(`  = exists, skipped: ${style}`); skipped++; continue; }
    await axios.post(`${BASE}/tables/${TABLE}/records`, {
      Style: style, Custom_Description: desc, Author: 'Claude (batch 2, 2026-07-12)', Updated_At: new Date().toISOString(),
    }, H);
    console.log(`  + inserted ${style}`);
    added++;
  }
  console.log(`\n${APPLY ? `Done: ${added} inserted, ${skipped} skipped.` : 'Dry-run only. Re-run with --apply.'}`);
  process.exit(0); // api-tracker timer keeps the loop alive — exit explicitly
})().catch(e => { console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
