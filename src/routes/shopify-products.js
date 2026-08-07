// 253gear.com publisher — the HTTP surface for Steve's dashboard tab.
//
//   GET  /api/shopify/config                      prices, ladder, styles, tag vocabulary
//   GET  /api/shopify/products?designNumber=      duplicate check / does it exist
//   POST /api/shopify/products                    create a DRAFT -> 202 { jobId }
//   GET  /api/shopify/jobs/:designNumber          progress, derived from Shopify
//   POST /api/shopify/jobs/:designNumber/resume   resume a stalled or failed run
//   GET  /api/shopify/products/:productId         full read-back for the preview pane
//   POST /api/shopify/products/:productId/publish the publish click
//   POST /api/shopify/products/:productId/audit   re-run the checks
//   POST /api/shopify/config/refresh-collections  re-read live smart-collection rules
//
// Gated at the mount with requireCrmApiSecret (server.js) and fronted by a
// requirePageAccess('gear-publisher.html') forwarder in the app, so one Caspio row
// governs both the page and its data.
//
// 🔴 DELIBERATELY ABSENT: any generic GraphQL passthrough, and any route that edits
// an existing product. `write_products` is catalogue-wide — it can reprice or unimage
// all 47 live products, not just create new ones. A passthrough would put the entire
// Shopify Admin API behind a staff cookie. This surface is a fixed allowlist and v1
// is create-only, which caps the blast radius of a stolen session at "one bad draft".
//
// 🔴 There is no delete path. The store's rule is archive, never delete; deletion is
// Erik's own click, every time.

'use strict';

const express = require('express');
const router = express.Router();

const shopify = require('../utils/shopify-client');
const orchestrator = require('../utils/shopify-orchestrator');
const { loadConfig, invalidate, ConfigError, TABLE, REQUIRED_KEYS } = require('../utils/shopify-config');
const { auditProduct } = require('../utils/shopify-audit');
const { ProductBuildError, DESIGN_NUMBER_RE } = require('../utils/shopify-product-builder');
const { analyzeDesign } = require('../utils/shopify-vision');
const {
    classifyFromText, classifyFromSources, acceptModelSuggestion, buildTagSet, collectionsForTags, trimToWidth
} = require('../utils/shopify-classify');

const JSON_LIMIT = '512kb';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Numeric Shopify product id -> GID. Rejects anything else so a caller can never
 *  smuggle a path segment or a foreign resource type through a route param. */
function toProductGid(productId) {
    const id = String(productId || '').trim();
    return /^\d{1,20}$/.test(id) ? `gid://shopify/Product/${id}` : null;
}

/**
 * One error contract for the whole surface.
 * Missing config is 503 (fix the table), a bad payload is 400 (fix the request),
 * and anything upstream is 502 — never a 200 with a half-truth.
 */
function fail(res, err, tag) {
    const message = shopify.redactShopify(err);
    console.error(`[253gear:${tag}]`, message);

    if (err instanceof ConfigError || err.code === 'NOT_CONFIGURED') {
        return res.status(503).json({
            success: false, error: message, code: 'NOT_CONFIGURED',
            table: TABLE, required: REQUIRED_KEYS, missing: (err.detail && err.detail.missing) || undefined
        });
    }
    if (err instanceof ProductBuildError || err.isValidation) {
        return res.status(400).json({ success: false, error: message, code: err.code || 'VALIDATION_FAILED', detail: err.detail });
    }
    if (err.code === 'BUSY') {
        return res.status(429).json({ success: false, error: message, code: 'BUSY' });
    }
    return res.status(502).json({ success: false, error: message, code: err.code || 'UPSTREAM_FAILED' });
}

/** Shopify credentials present? Refuse rather than call unauthenticated. */
function requireShopify(req, res, next) {
    if (!shopify.isConfigured()) {
        return res.status(503).json({
            success: false, code: 'NOT_CONFIGURED',
            error: 'Shopify credentials are not set on this dyno',
            missing: shopify.missingConfig()
        });
    }
    next();
}

// ── Config ───────────────────────────────────────────────────────────────────

router.get('/config', async (req, res) => {
    try {
        const cfg = await loadConfig({ refresh: String(req.query.refresh || '') === 'true' });
        res.json({ success: true, config: cfg });
    } catch (e) { fail(res, e, 'config'); }
});

/**
 * Read the live smart-collection rules and cache them into the config table.
 *
 * This is what makes "files it into the right category" true rather than hopeful:
 * the tag vocabulary is DISCOVERED from what the collections actually key on, never
 * assumed. Until this has run, `collectionsKnown` is false and the classifier says
 * so instead of guessing.
 */
router.post('/config/refresh-collections', requireShopify, async (req, res) => {
    try {
        const data = await shopify.gql(`
            query { collections(first:50){ nodes{ id handle title
              ruleSet{ appliedDisjunctively rules{ column relation condition } } } } }`,
            {}, { isMutation: false });

        const nodes = (data.collections && data.collections.nodes) || [];
        const rules = [];
        const vocabulary = new Set();

        for (const c of nodes) {
            if (!c.ruleSet || !Array.isArray(c.ruleSet.rules)) continue;   // manual collection
            for (const r of c.ruleSet.rules) {
                rules.push({ handle: c.handle, column: r.column, relation: r.relation, condition: r.condition });
                if (String(r.column).toUpperCase() === 'TAG') vocabulary.add(String(r.condition).trim().toLowerCase());
            }
        }

        res.json({
            success: true,
            collections: nodes.length,
            automatic: new Set(rules.map((r) => r.handle)).size,
            tagVocabulary: Array.from(vocabulary),
            collectionRules: rules,
            note: `Save these into ${TABLE} as keys "tag_vocabulary" and "collection_rules" (Value_Type json).`
        });
        invalidate();
    } catch (e) { fail(res, e, 'refresh-collections'); }
});

// ── Lookup ───────────────────────────────────────────────────────────────────

router.get('/products', requireShopify, async (req, res) => {
    const designNumber = String(req.query.designNumber || '').trim();
    if (!DESIGN_NUMBER_RE.test(designNumber)) {
        return res.status(400).json({ success: false, code: 'BAD_DESIGN_NUMBER', error: 'designNumber must be 4-6 digits' });
    }
    try {
        const product = await orchestrator.findExistingProduct(designNumber);
        res.json({
            success: true,
            designNumber,
            found: Boolean(product),
            product: product ? {
                gid: product.id,
                legacyId: product.legacyResourceId,
                handle: product.handle,
                title: product.title,
                status: product.status,
                publishedAt: product.publishedAt,
                adminUrl: `https://${shopify.shopDomain()}/admin/products/${product.legacyResourceId}`,
                storefrontUrl: `${shopify.storefrontOrigin()}/products/${product.handle}`
            } : null
        });
    } catch (e) { fail(res, e, 'products-lookup'); }
});

router.get('/products/:productId', requireShopify, async (req, res) => {
    const gid = toProductGid(req.params.productId);
    if (!gid) return res.status(400).json({ success: false, code: 'BAD_PRODUCT_ID', error: 'productId must be numeric' });
    try {
        const cfg = await loadConfig().catch(() => null);
        const status = await orchestrator.getStatus(String(req.query.designNumber || '').trim(), cfg);
        res.json({ success: true, ...status });
    } catch (e) { fail(res, e, 'product-read'); }
});

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Start a draft build. Returns 202 immediately — the sequence runs detached because
 * media processing alone can outlast Heroku's 30s router timeout.
 *
 * The mandatory-identity gate lives HERE, server-side. A UI-only gate is not a gate:
 * nothing reaches 253gear.com without a ShopWorks design number and a description.
 */
router.post('/products', requireShopify, express.json({ limit: JSON_LIMIT }), async (req, res) => {
    const body = req.body || {};
    const problems = [];

    const designNumber = String(body.designNumber || '').trim();
    if (!DESIGN_NUMBER_RE.test(designNumber)) problems.push('designNumber must be 4-6 digits');
    if (!String(body.designName || '').trim()) problems.push('designName is required');
    if (!String(body.designDescription || '').trim()) problems.push('designDescription (from ShopWorks) is required');
    if (!Array.isArray(body.images) || !body.images.length) problems.push('at least one image is required');
    for (const img of body.images || []) {
        if (!img || !img.externalKey) problems.push('every image needs an externalKey');
        if (!String((img && img.altText) || '').trim()) problems.push('every image needs alt text');
        if (!img || !img.styleOption || !img.catalogColor) problems.push('every image needs styleOption and catalogColor');
    }

    if (problems.length) {
        return res.status(400).json({ success: false, code: 'VALIDATION_FAILED', problems: [...new Set(problems)] });
    }

    try {
        const cfg = await loadConfig();
        const { job, replay } = orchestrator.startCreate(body, cfg, {
            idempotencyKey: req.get('Idempotency-Key') || null,
            createdBy: req.get('X-Staff-Email') || 'staff'
        });

        return res.status(replay ? 200 : 202).json({
            success: true,
            replay,
            jobId: job.designNumber,
            designNumber: job.designNumber,
            status: job.status,
            pollUrl: `/api/shopify/jobs/${job.designNumber}`
        });
    } catch (e) { fail(res, e, 'create'); }
});

// ── Progress ─────────────────────────────────────────────────────────────────

router.get('/jobs/:designNumber', requireShopify, async (req, res) => {
    const designNumber = String(req.params.designNumber || '').trim();
    if (!DESIGN_NUMBER_RE.test(designNumber)) {
        return res.status(400).json({ success: false, code: 'BAD_DESIGN_NUMBER', error: 'designNumber must be 4-6 digits' });
    }
    try {
        const cfg = await loadConfig().catch(() => null);
        const status = await orchestrator.getStatus(designNumber, cfg);
        res.json({ success: true, job: status });
    } catch (e) { fail(res, e, 'job-status'); }
});

router.post('/jobs/:designNumber/resume', requireShopify, express.json({ limit: JSON_LIMIT }), async (req, res) => {
    const designNumber = String(req.params.designNumber || '').trim();
    if (!DESIGN_NUMBER_RE.test(designNumber)) {
        return res.status(400).json({ success: false, code: 'BAD_DESIGN_NUMBER', error: 'designNumber must be 4-6 digits' });
    }
    const payload = (req.body && req.body.payload) || null;
    if (!payload) {
        return res.status(400).json({
            success: false, code: 'PAYLOAD_REQUIRED',
            error: 'Resume needs the original payload — the draft is held in the browser, not on the dyno'
        });
    }
    try {
        const cfg = await loadConfig();
        const { job, replay } = orchestrator.startCreate({ ...payload, designNumber }, cfg, {
            createdBy: req.get('X-Staff-Email') || 'staff'
        });
        res.status(202).json({ success: true, replay, jobId: job.designNumber, status: job.status,
            pollUrl: `/api/shopify/jobs/${job.designNumber}` });
    } catch (e) { fail(res, e, 'job-resume'); }
});

// ── Classify ─────────────────────────────────────────────────────────────────

/**
 * Read the hero mockup and propose a city, tags, SEO and alt text.
 *
 * Deterministic first: if the artwork text names exactly one place in the live
 * collection vocabulary, that settles it with a reason a person can check, and the
 * model's own city guess is ignored. Inference is only consulted for the residue —
 * designs with no place name — and is capped at medium confidence.
 *
 * Nothing here applies anything. The response is a SUGGESTION for Steve to confirm,
 * because the city collections are automatic and a wrong tag files itself instantly.
 */
router.post('/classify', express.json({ limit: '64kb' }), async (req, res) => {
    const { externalKey, designName, styles = [] } = req.body || {};
    if (!externalKey) {
        return res.status(400).json({ success: false, code: 'VALIDATION_FAILED', error: 'externalKey is required' });
    }

    try {
        const cfg = await loadConfig();

        const { buffer, contentType } = await orchestrator.fetchStoredFile(externalKey);
        const seen = await analyzeDesign(buffer, contentType, {
            vocabulary: (cfg.cities || []).map((c) => c.name),
            designName
        });

        // 1) The artwork's own words decide, when they can.
        let verdict = classifyFromSources({ designName, designText: seen.design_text }, cfg.cities);

        // 2) Only ask the model to stand in when the text said nothing.
        //    An 'ambiguous' verdict is NOT overridden — two named places is a question
        //    for a human, and letting the model break the tie would hide that.
        if (verdict.method === 'none' && seen.city) {
            verdict = acceptModelSuggestion(
                { city: seen.city, confidence: seen.city_confidence, reason: seen.city_reason },
                cfg.cities
            );
        }

        const { tags, rejected } = buildTagSet({ city: verdict.city, styles }, cfg);
        const collections = collectionsForTags(tags, cfg);

        res.json({
            success: true,
            city: verdict.city,
            confidence: verdict.confidence,
            reason: verdict.reason,
            method: verdict.method,
            candidates: verdict.candidates,
            needsHuman: verdict.city === null,
            tags,
            rejectedTags: rejected,
            collections,
            collectionsKnown: cfg.collectionsKnown,
            seo: {
                title: trimToWidth(seen.seo_title, 60),
                description: trimToWidth(seen.seo_description, 155)
            },
            altText: seen.alt_text,
            seen: {
                designText: seen.design_text,
                designDescription: seen.design_description,
                designColors: seen.design_colors
            },
            model: seen.model
        });
    } catch (e) { fail(res, e, 'classify'); }
});

// ── Audit + publish ──────────────────────────────────────────────────────────

router.post('/products/:productId/audit', requireShopify, async (req, res) => {
    const gid = toProductGid(req.params.productId);
    if (!gid) return res.status(400).json({ success: false, code: 'BAD_PRODUCT_ID', error: 'productId must be numeric' });
    try {
        const cfg = await loadConfig().catch(() => null);
        const data = await shopify.gql(
            `query($id:ID!){ product(id:$id){
               id title handle status publishedAt descriptionHtml tags
               options{ name }
               media(first:100){ nodes{ ... on MediaImage { id alt status image{ url } } } }
               variants(first:250){ nodes{ id sku price image{ id url } inventoryItem{ tracked } selectedOptions{ name value } } }
             } }`, { id: gid }, { isMutation: false });

        if (!data.product) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'No such product' });

        const result = auditProduct(data.product, {
            config: cfg, catalogue: null, expectPublished: Boolean(data.product.publishedAt)
        });
        res.json({ success: true, ...result });
    } catch (e) { fail(res, e, 'audit'); }
});

/**
 * Publish. 409s unless the audit is clean — the gate is server-side so a disabled
 * button in the browser is a courtesy, not the control.
 */
router.post('/products/:productId/publish', requireShopify, express.json({ limit: '64kb' }), async (req, res) => {
    const gid = toProductGid(req.params.productId);
    if (!gid) return res.status(400).json({ success: false, code: 'BAD_PRODUCT_ID', error: 'productId must be numeric' });

    try {
        const cfg = await loadConfig();
        const pre = await shopify.gql(
            `query($id:ID!){ product(id:$id){
               id title handle status publishedAt descriptionHtml tags
               options{ name }
               media(first:100){ nodes{ ... on MediaImage { id alt status image{ url } } } }
               variants(first:250){ nodes{ id sku price image{ id url } inventoryItem{ tracked } selectedOptions{ name value } } }
             } }`, { id: gid }, { isMutation: false });

        if (!pre.product) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'No such product' });

        const audit = auditProduct(pre.product, { config: cfg, catalogue: null, expectPublished: false });
        if (!audit.pass) {
            return res.status(409).json({
                success: false, code: 'AUDIT_FAILED',
                error: 'Publish blocked — fix the failing checks first',
                audit
            });
        }

        const result = await orchestrator.publish(gid, cfg);
        const verified = await orchestrator.verifyStorefront(result.handle);

        res.json({ success: true, ...result, verified });
    } catch (e) { fail(res, e, 'publish'); }
});

module.exports = router;
