// The 253gear create sequence: draft product -> media -> variant binding -> audit.
//
// Every step is READ-THEN-CONVERGE. That is not stylistic: this store's standing
// rule is "never delete, archive" (Downloads/253gear-ops/CLAUDE.md gotcha 7), so a
// half-created product cannot be cleaned up — it can only be resumed. A sequence
// that blindly re-ran would leave permanent duplicates.
//
// WHERE STATE LIVES. Shopify is authoritative. `getStatus()` answers "where did this
// get to?" by asking Shopify — does the product exist, how many media, are they READY,
// is every variant bound, is it published — never by trusting a local record. The
// in-memory `jobs` map below drives the progress bar ONLY; losing it to a dyno cycle
// costs a progress display, not correctness, and a resume recomputes everything.
// (Same shape as the async 202+poll in src/routes/sanmar-orders.js:2271-2291, which
// exists because Heroku's router kills a request at 30 seconds.)
//
// Publishing is deliberately NOT part of this sequence. It is a separate call after
// a human has looked at the draft.

'use strict';

const axios = require('axios');
const FormData = require('form-data');
const shopify = require('./shopify-client');
const builder = require('./shopify-product-builder');
const { auditProduct } = require('./shopify-audit');
const { getCaspioAccessToken } = require('./caspio');
const { isValidFileKey } = require('./where-guards');
const config = require('../../config');

const caspioV3BaseUrl = config.caspio.apiV3BaseUrl || `https://${config.caspio.domain}/rest/v3`;

const MEDIA_POLL_MAX_MS = 90000;
const MEDIA_POLL_STEPS = [1000, 2000, 3000, 5000, 8000, 13000, 13000, 13000, 13000, 13000];
const VARIANT_BIND_BATCH = 100;
const STALE_JOB_MS = 3 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── In-memory job registry (progress display only) ───────────────────────────

const jobs = new Map();           // designNumber -> job
const idempotencyIndex = new Map(); // Idempotency-Key -> designNumber
let runningCount = 0;

const STEPS = ['preflight', 'product', 'media', 'media_ready', 'binding', 'audit'];

function newJob(designNumber, idempotencyKey, createdBy) {
    return {
        designNumber,
        idempotencyKey: idempotencyKey || null,
        createdBy: createdBy || 'staff',
        status: 'queued',
        step: 'preflight',
        stepsDone: [],
        progress: { done: 0, total: STEPS.length },
        productGid: null,
        legacyId: null,
        handle: null,
        media: [],
        variantsBound: { bound: 0, total: 0 },
        audit: null,
        errors: [],
        startedAt: Date.now(),
        heartbeatAt: Date.now()
    };
}

function beat(job, step) {
    if (step && job.step !== step) {
        if (!job.stepsDone.includes(job.step)) job.stepsDone.push(job.step);
        job.step = step;
        job.progress = { done: job.stepsDone.length, total: STEPS.length };
    }
    job.heartbeatAt = Date.now();
}

function failJob(job, step, err) {
    job.status = err && err.disposition === 'reconcile' ? 'needs_attention' : 'failed';
    job.errors.push({
        step,
        code: (err && err.code) || 'UNKNOWN',
        message: shopify.redactShopify(err),
        at: new Date().toISOString()
    });
    job.heartbeatAt = Date.now();
    console.error(`[253gear] job ${job.designNumber} failed at ${step}:`, shopify.redactShopify(err));
}

/** A job whose heartbeat has gone quiet is reported resumable, not "still working". */
function decorateStaleness(job) {
    const stalled = job.status === 'running' && (Date.now() - job.heartbeatAt) > STALE_JOB_MS;
    return { ...job, stalled, resumable: stalled || job.status === 'needs_attention' || job.status === 'failed' };
}

// ── GraphQL documents ────────────────────────────────────────────────────────

const Q_FIND_BY_TITLE = `
query($q:String!){ products(first:10, query:$q){ nodes{
  id legacyResourceId title handle status publishedAt
} } }`;

const Q_PRODUCT_FULL = `
query($id:ID!){
  product(id:$id){
    id legacyResourceId title handle status publishedAt descriptionHtml tags
    options{ id name values }
    media(first:100){ nodes{ ... on MediaImage { id alt status mediaErrors{ code details message } image{ url width height } } } }
    variants(first:250){ nodes{ id sku price image{ id } inventoryItem{ tracked } selectedOptions{ name value } } }
  }
}`;

const M_PRODUCT_SET = `
mutation($input:ProductSetInput!){ productSet(synchronous:true, input:$input){
  product{ id legacyResourceId handle
    media(first:100){ nodes{ ... on MediaImage { id status } } }
    variants(first:250){ nodes{ id sku selectedOptions{ name value } } } }
  userErrors{ field message code } } }`;

const M_STAGED_UPLOADS = `
mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){
  stagedTargets{ url resourceUrl parameters{ name value } }
  userErrors{ field message } } }`;

const M_CREATE_MEDIA = `
mutation($productId:ID!,$media:[CreateMediaInput!]!){
  productCreateMedia(productId:$productId, media:$media){
    media{ ... on MediaImage { id status alt } }
    mediaUserErrors{ field message code } } }`;

const Q_MEDIA_STATUS = `
query($id:ID!){ product(id:$id){ media(first:100){ nodes{
  ... on MediaImage { id status alt mediaErrors{ code details message } } } } } }`;

const M_BIND_VARIANTS = `
mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
  productVariantsBulkUpdate(productId:$productId, variants:$variants){
    productVariants{ id image{ id } }
    userErrors{ field message code } } }`;

const M_PRODUCT_UPDATE_STATUS = `
mutation($id:ID!,$status:ProductStatus!){
  productUpdate(input:{ id:$id, status:$status }){ product{ id status publishedAt } userErrors{ field message } } }`;

const M_PUBLISHABLE_PUBLISH = `
mutation($id:ID!,$input:[PublicationInput!]!){
  publishablePublish(id:$id, input:$input){
    publishable{ ... on Product { id publishedAt } } userErrors{ field message } } }`;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find a live product by ShopWorks design number.
 *
 * Title search is the primary key because every product in this catalogue carries
 * `#<designNumber>` by convention and the catalogue is audited for zero duplicates.
 * Crucially it also catches products Erik created BY HAND in the admin, which no
 * local record would know about.
 */
async function findExistingProduct(designNumber) {
    const number = String(designNumber || '').trim();
    if (!/^\d{4,6}$/.test(number)) return null;

    // Shopify's tokenizer may drop '#', so match on the digits and confirm in JS.
    const data = await shopify.gql(Q_FIND_BY_TITLE, { q: `title:*${number}*` }, { isMutation: false });
    const nodes = (data && data.products && data.products.nodes) || [];
    const re = new RegExp(`#${number}\\s*$`);
    return nodes.find((p) => re.test(String(p.title || ''))) || null;
}

/** Read a stored artwork file's raw bytes straight from Caspio Files. */
async function fetchStoredFile(externalKey) {
    if (!isValidFileKey(externalKey)) {
        const err = new Error(`Invalid file key "${externalKey}"`);
        err.code = 'BAD_FILE_KEY';
        throw err;
    }
    const token = await getCaspioAccessToken();
    const resp = await axios({
        method: 'get',
        url: `${caspioV3BaseUrl}/files/${encodeURIComponent(externalKey)}`,
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer',
        timeout: 60000
    });
    return {
        buffer: Buffer.from(resp.data),
        contentType: (resp.headers && resp.headers['content-type']) || 'image/jpeg'
    };
}

/**
 * Push image bytes to Shopify via staged upload.
 *
 * Staged upload rather than handing Shopify a public URL: Steve's Photoshop export
 * reaches the store byte-for-byte. The public `/api/files/:key/sw.jpg` variant caps
 * at 1400px and re-encodes at q80, which is needlessly soft for a retail photo.
 */
async function stageImages(images) {
    if (!images.length) return [];

    const data = await shopify.gql(M_STAGED_UPLOADS, {
        input: images.map((img) => ({
            resource: 'IMAGE',
            filename: img.filename,
            mimeType: img.contentType,
            httpMethod: 'POST',
            fileSize: String(img.buffer.length)
        }))
    });

    const targets = (data.stagedUploadsCreate && data.stagedUploadsCreate.stagedTargets) || [];
    if (targets.length !== images.length) {
        const err = new Error(`Shopify returned ${targets.length} upload targets for ${images.length} images`);
        err.code = 'STAGED_UPLOAD_MISMATCH';
        throw err;
    }

    const staged = [];
    for (let i = 0; i < images.length; i++) {
        const target = targets[i];
        const form = new FormData();
        for (const p of target.parameters) form.append(p.name, p.value);
        form.append('file', images[i].buffer, { filename: images[i].filename, contentType: images[i].contentType });

        await axios.post(target.url, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000
        });
        staged.push({ ...images[i], resourceUrl: target.resourceUrl });
    }
    return staged;
}

/**
 * Wait until every media object is READY.
 *
 * 🔴 THE step that stops the unbound-variant defect recurring. productCreateMedia
 * returns an id immediately while Shopify is still processing the image; binding a
 * variant to media that is not READY fails, and a sequence that pressed on anyway is
 * exactly how 644 variants (and later 7) shipped with no photo.
 */
async function waitForMediaReady(productGid, expectedCount, job) {
    const deadline = Date.now() + MEDIA_POLL_MAX_MS;
    let attempt = 0;

    while (Date.now() < deadline) {
        const data = await shopify.gql(Q_MEDIA_STATUS, { id: productGid }, { isMutation: false });
        const nodes = ((data.product && data.product.media && data.product.media.nodes) || []).filter(Boolean);

        const failed = nodes.filter((m) => m.status === 'FAILED');
        if (failed.length) {
            const err = new Error(
                `Shopify could not process ${failed.length} image(s): ` +
                failed.map((m) => (m.mediaErrors || []).map((e) => e.details || e.message).join('; ')).join(' | ')
            );
            err.code = 'MEDIA_FAILED';
            err.failedMedia = failed.map((m) => m.id);
            throw err;
        }

        const ready = nodes.filter((m) => m.status === 'READY');
        if (job) {
            job.media = nodes.map((m) => ({ id: m.id, status: m.status }));
            beat(job);
        }
        if (ready.length >= expectedCount && nodes.length >= expectedCount) return ready;

        await sleep(MEDIA_POLL_STEPS[Math.min(attempt, MEDIA_POLL_STEPS.length - 1)]);
        attempt++;
    }

    const err = new Error(`Images were still processing after ${MEDIA_POLL_MAX_MS / 1000}s`);
    err.code = 'MEDIA_TIMEOUT';
    throw err;
}

/**
 * Bind every variant to its (Style, Color) image, then PROVE it took.
 * The mutation's own response is not trusted — the product is re-read and
 * `bound === total` asserted, because that is the assertion nobody made twice before.
 */
async function bindVariantMedia(productGid, variants, images, job) {
    const { bindings, unbound } = builder.buildVariantMediaBindings(variants, images);

    if (unbound.length) {
        const err = new Error(
            `${unbound.length} variants have no image: ${unbound.slice(0, 5).map((u) => u.sku || u.key).join(', ')}` +
            (unbound.length > 5 ? ` (+${unbound.length - 5} more)` : '')
        );
        err.code = 'UNBOUND_VARIANTS';
        err.unbound = unbound;
        throw err;
    }

    for (let i = 0; i < bindings.length; i += VARIANT_BIND_BATCH) {
        await shopify.gql(M_BIND_VARIANTS, {
            productId: productGid,
            variants: bindings.slice(i, i + VARIANT_BIND_BATCH)
        });
        if (job) beat(job);
    }

    // Re-read and assert. Do not trust the mutation response.
    const check = await shopify.gql(Q_PRODUCT_FULL, { id: productGid }, { isMutation: false });
    const nodes = (check.product && check.product.variants && check.product.variants.nodes) || [];
    const bound = nodes.filter((v) => v.image && v.image.id).length;
    if (job) job.variantsBound = { bound, total: nodes.length };

    if (bound !== nodes.length) {
        const err = new Error(`After binding, only ${bound}/${nodes.length} variants have an image`);
        err.code = 'BINDING_INCOMPLETE';
        throw err;
    }
    return { bound, total: nodes.length, product: check.product };
}

// ── The sequence ─────────────────────────────────────────────────────────────

async function runCreateSequence(job, payload, cfg) {
    job.status = 'running';
    runningCount++;
    try {
        // 1 — preflight. Refresh the token BEFORE starting so it cannot expire
        // between productSet and the binding, which would strand the product.
        beat(job, 'preflight');
        if (shopify.tokenSecondsRemaining() < 300) {
            shopify.resetTokenCache();
            await shopify.getToken();
        }

        const existing = await findExistingProduct(payload.designNumber);
        if (existing) {
            job.productGid = existing.id;
            job.legacyId = existing.legacyResourceId;
            job.handle = existing.handle;
            job.status = 'exists';
            job.step = 'audit';
            return job;
        }

        const input = builder.buildProductSetInput(payload, cfg);

        // 2 — the product itself, always DRAFT.
        beat(job, 'product');
        const setData = await shopify.gql(M_PRODUCT_SET, { input });
        const product = setData.productSet && setData.productSet.product;
        if (!product || !product.id) {
            const err = new Error('productSet returned no product');
            err.code = 'NO_PRODUCT';
            throw err;
        }
        job.productGid = product.id;
        job.legacyId = product.legacyResourceId;
        job.handle = product.handle;

        // 3 — media, byte-for-byte via staged upload.
        beat(job, 'media');
        const files = [];
        for (const img of payload.images || []) {
            const { buffer, contentType } = await fetchStoredFile(img.externalKey);
            files.push({
                ...img,
                buffer,
                contentType,
                filename: `${input.handle}-${builder.slugify(img.styleOption)}-${builder.slugify(img.catalogColor)}.jpg`
            });
        }
        const staged = await stageImages(files);

        // ONE createMedia call per image, deliberately.
        //
        // Batching would be one round trip instead of ~5, but it forces pairing the
        // returned media ids back to their (Style, Color) BY ARRAY INDEX, and Shopify
        // does not guarantee response order. Alt text can't disambiguate either — the
        // whole set usually shares one alt string, since the rule is "describe the
        // design, not the garment". An off-by-one here binds the hoodie photo to the
        // tee, which is the exact customer-visible symptom that shipped twice. A few
        // extra calls is a trivial price for an unambiguous pairing.
        const withIds = [];
        for (const s of staged) {
            const created = await shopify.gql(M_CREATE_MEDIA, {
                productId: product.id,
                media: [{
                    originalSource: s.resourceUrl,
                    mediaContentType: 'IMAGE',
                    alt: String(s.altText || '').trim()
                }]
            });
            const node = ((created.productCreateMedia && created.productCreateMedia.media) || [])[0];
            if (!node || !node.id) {
                const err = new Error(`Shopify accepted no media for ${s.styleOption} / ${s.catalogColor}`);
                err.code = 'MEDIA_NOT_CREATED';
                throw err;
            }
            withIds.push({ styleOption: s.styleOption, catalogColor: s.catalogColor, mediaId: node.id });
            beat(job);
        }

        // 4 — wait for READY before binding anything.
        beat(job, 'media_ready');
        await waitForMediaReady(product.id, withIds.length, job);

        // 5 — bind, then prove it.
        beat(job, 'binding');
        const variants = (product.variants && product.variants.nodes) || [];
        const { product: bound } = await bindVariantMedia(product.id, variants, withIds, job);

        // 6 — audit the real product, not the payload we hoped for.
        beat(job, 'audit');
        job.audit = auditProduct(bound, { config: cfg, catalogue: null, expectPublished: false });
        job.status = 'awaiting_review';
        if (!job.stepsDone.includes('audit')) job.stepsDone.push('audit');
        job.progress = { done: STEPS.length, total: STEPS.length };
        return job;
    } catch (err) {
        failJob(job, job.step, err);
        return job;
    } finally {
        runningCount--;
        job.heartbeatAt = Date.now();
    }
}

/**
 * Start a create. Returns immediately with a queued job; the sequence runs detached
 * so the HTTP response beats Heroku's 30s router timeout.
 */
function startCreate(payload, cfg, { idempotencyKey, createdBy } = {}) {
    const designNumber = String(payload.designNumber || '').trim();

    // Layer 1 — same Idempotency-Key means the same job, not a second one.
    if (idempotencyKey && idempotencyIndex.has(idempotencyKey)) {
        const existing = jobs.get(idempotencyIndex.get(idempotencyKey));
        if (existing) return { job: decorateStaleness(existing), replay: true };
    }

    // Layer 2 — one in-flight job per design number.
    const current = jobs.get(designNumber);
    if (current && (current.status === 'running' || current.status === 'queued')) {
        return { job: decorateStaleness(current), replay: true };
    }

    if (runningCount >= MAX_CONCURRENT_JOBS) {
        const err = new Error('Two publishes are already running — try again in a moment');
        err.code = 'BUSY';
        throw err;
    }

    const job = newJob(designNumber, idempotencyKey, createdBy);
    jobs.set(designNumber, job);
    if (idempotencyKey) idempotencyIndex.set(idempotencyKey, designNumber);

    setImmediate(() => { runCreateSequence(job, payload, cfg); });
    return { job: decorateStaleness(job), replay: false };
}

/**
 * Where did this get to? Answered from SHOPIFY, with the in-memory job merged in for
 * live progress. Survives a dyno cycle: the local job may be gone, the truth is not.
 */
async function getStatus(designNumber, cfg) {
    const local = jobs.get(String(designNumber).trim());
    const existing = await findExistingProduct(designNumber);

    if (!existing) {
        return local
            ? { ...decorateStaleness(local), shopify: null }
            : { designNumber, status: 'not_started', shopify: null };
    }

    const data = await shopify.gql(Q_PRODUCT_FULL, { id: existing.id }, { isMutation: false });
    const product = data.product;
    const variants = (product.variants && product.variants.nodes) || [];
    const media = ((product.media && product.media.nodes) || []).filter(Boolean);
    const bound = variants.filter((v) => v.image && v.image.id).length;

    const derived = {
        productGid: product.id,
        legacyId: product.legacyResourceId,
        handle: product.handle,
        title: product.title,
        status: product.status,
        publishedAt: product.publishedAt,
        mediaTotal: media.length,
        mediaReady: media.filter((m) => m.status === 'READY').length,
        variantsBound: { bound, total: variants.length },
        storefrontUrl: `${shopify.storefrontOrigin()}/products/${product.handle}`,
        adminUrl: `https://${shopify.shopDomain()}/admin/products/${product.legacyResourceId}`
    };

    return {
        ...(local ? decorateStaleness(local) : { designNumber, status: product.publishedAt ? 'published' : 'awaiting_review' }),
        shopify: derived,
        audit: auditProduct(product, { config: cfg, catalogue: null, expectPublished: Boolean(product.publishedAt) })
    };
}

/**
 * Publish — the separate, human-triggered step.
 *
 * 🔴 `status: ACTIVE` does NOT publish. publishedAt stays null and the storefront
 * 404s (253gear CLAUDE.md gotcha 1). publishablePublish is preferred now that
 * read_publications is granted; the REST call proven in sh.py:65-79 is the fallback.
 * Either way `publishedAt` is re-read and required to be non-null.
 */
async function publish(productGid, cfg, { publicationId } = {}) {
    await shopify.gql(M_PRODUCT_UPDATE_STATUS, { id: productGid, status: 'ACTIVE' });

    let method = 'publishablePublish';
    const pubId = publicationId || (cfg && cfg.publicationId);
    let publishedAt = null;

    if (pubId) {
        try {
            const data = await shopify.gql(M_PUBLISHABLE_PUBLISH, {
                id: productGid, input: [{ publicationId: pubId }]
            });
            publishedAt = data.publishablePublish
                && data.publishablePublish.publishable
                && data.publishablePublish.publishable.publishedAt;
        } catch (e) {
            console.warn('[253gear] publishablePublish failed, falling back to REST:', shopify.redactShopify(e));
            publishedAt = null;
        }
    }

    if (!publishedAt) {
        method = 'rest';
        const legacyId = String(productGid).split('/').pop();
        const r = await shopify.rest(`products/${legacyId}.json`, {
            product: { id: Number(legacyId), published: true, published_scope: 'web' }
        }, 'PUT');
        publishedAt = r && r.product && r.product.published_at;
    }

    // Re-read rather than trusting either call.
    const check = await shopify.gql(Q_PRODUCT_FULL, { id: productGid }, { isMutation: false });
    const product = check.product;
    if (!product.publishedAt) {
        const err = new Error('Product status is ACTIVE but publishedAt is still null — the storefront will 404');
        err.code = 'PUBLISH_INCOMPLETE';
        throw err;
    }

    return {
        publishedAt: product.publishedAt,
        status: product.status,
        method,
        handle: product.handle,
        storefrontUrl: `${shopify.storefrontOrigin()}/products/${product.handle}`
    };
}

/**
 * Cookie-free storefront check. Gotcha 5: the storefront caches hard and a browser
 * will keep 404ing for minutes after a successful publish, so the browser cannot be
 * the witness. Reports rather than throws — the product IS live even if the CDN lags.
 */
async function verifyStorefront(handle, { attempts = 3, waitMs = 5000 } = {}) {
    const url = `${shopify.storefrontOrigin()}/products/${handle}`;
    let last = 0;
    for (let i = 0; i < attempts; i++) {
        try {
            const resp = await axios.get(url, {
                timeout: 15000,
                maxRedirects: 0,
                validateStatus: () => true,
                headers: { 'Cache-Control': 'no-cache' }
            });
            last = resp.status;
            if (resp.status === 200) return { verified: true, httpStatus: 200, url, attempts: i + 1 };
        } catch (e) {
            last = 0;
        }
        if (i < attempts - 1) await sleep(waitMs);
    }
    return { verified: false, httpStatus: last, url, attempts };
}

module.exports = {
    startCreate,
    getStatus,
    publish,
    verifyStorefront,
    findExistingProduct,
    // exported for jest
    fetchStoredFile,
    stageImages,
    waitForMediaReady,
    bindVariantMedia,
    runCreateSequence,
    _jobs: jobs,
    _idempotencyIndex: idempotencyIndex,
    STEPS,
    STALE_JOB_MS
};
