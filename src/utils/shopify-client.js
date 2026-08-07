// Shopify Admin API client for 253gear.com (custom app "253Gear Publisher").
//
// Auth pattern mirrors src/utils/supacolor-api.js (in-memory token cache, 90% of
// expires_in, 60s buffer, 401 -> null -> retry once) with one addition it lacks:
// SINGLE-FLIGHT. A cold dyno serving N concurrent requests would otherwise mint N
// tokens. Shopify client_credentials tokens live ~24h, so the steady state is one
// mint per dyno per day.
//
// Deliberately NOT persisted anywhere. The Python reference tool caches to
// shopify/token.json (see Downloads/253gear-ops/shopify/auth.py); that is a
// single-workstation pattern and a live admin write-token at rest is a new secret
// surface for zero benefit on Heroku.
//
// Env vars (proxy only — the app never holds these):
//   SHOPIFY_SHOP_DOMAIN       nw-custom-apparel.myshopify.com
//   SHOPIFY_CLIENT_ID
//   SHOPIFY_CLIENT_SECRET
//   SHOPIFY_API_VERSION       (default 2026-07 — NOT the 2025-01 in the old docs)
//   SHOPIFY_STOREFRONT_ORIGIN (default https://253gear.com)
//
// THREE FAILURE-HANDLING RULES THAT ARE NOT OPTIONAL:
//
//  1. `userErrors` non-empty is a FAILURE even on HTTP 200 + no top-level errors.
//     The reference sh.py:50-52 only checks top-level `errors`, so a productSet
//     that silently rejected half its variants would read as success. gql() walks
//     the whole response for any *userErrors array and throws.
//
//  2. NEVER blind-retry a mutation on 5xx. It may have applied. A retry is how you
//     get two products for one design on a store whose rule is "never delete".
//     classifyShopifyError() returns 'reconcile' for that case; the caller must
//     re-read and converge instead.
//
//  3. The token must never reach a log line, an error message, or a response body.
//     redactShopify() scrubs it and the client secret from any string on the way out.

const axios = require('axios');

// 🔴 NOT 2025-01, despite what Downloads/253gear-ops says.
//
// That reference material was written against 2025-01, but Shopify supports an Admin
// API version for roughly 12 months and it is now August 2026 — so 2025-01 is out of
// support. Confirmed from the Dev Dashboard while creating the 253Gear Publisher app:
// the oldest version it will even offer is 2025-10, and it defaults new apps to
// 2026-07. Calling a retired version fails outright or silently drops fields.
//
// Overridable via SHOPIFY_API_VERSION so a bump is a config change, not a deploy.
const DEFAULT_API_VERSION = '2026-07';
const DEFAULT_STOREFRONT = 'https://253gear.com';
const REQUEST_TIMEOUT_MS = 60000;
const TOKEN_BUFFER_SECONDS = 60;

// Pre-emptive throttle: Shopify's leaky bucket refills at `restoreRate`/sec. Dipping
// below this many points means the next non-trivial query is likely to be throttled,
// so we sleep first — cheaper than eating the error and backing off after.
const THROTTLE_FLOOR = 200;
const MAX_THROTTLE_RETRIES = 5;

let accessToken = null;
let tokenExpiryTime = 0;   // epoch seconds
let inFlightTokenPromise = null;

function shopDomain() { return process.env.SHOPIFY_SHOP_DOMAIN || ''; }
function apiVersion() { return process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION; }
function storefrontOrigin() { return process.env.SHOPIFY_STOREFRONT_ORIGIN || DEFAULT_STOREFRONT; }

/**
 * True when every credential needed to talk to Shopify is present.
 * Routes call this and return 503 { code: 'NOT_CONFIGURED' } rather than throwing —
 * a missing Shopify var must fail ONE route, never boot the whole proxy down.
 */
function isConfigured() {
    return Boolean(shopDomain() && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

function missingConfig() {
    const missing = [];
    if (!shopDomain()) missing.push('SHOPIFY_SHOP_DOMAIN');
    if (!process.env.SHOPIFY_CLIENT_ID) missing.push('SHOPIFY_CLIENT_ID');
    if (!process.env.SHOPIFY_CLIENT_SECRET) missing.push('SHOPIFY_CLIENT_SECRET');
    return missing;
}

/**
 * Scrub secrets out of anything headed for a log or an HTTP response.
 * Belt and braces: the live token, the client secret, and any Bearer/X-Shopify header
 * value that might have been echoed back inside an axios error dump.
 */
function redactShopify(value) {
    let s = typeof value === 'string' ? value : String(value && value.message ? value.message : value);
    const secrets = [accessToken, process.env.SHOPIFY_CLIENT_SECRET, process.env.SHOPIFY_CLIENT_ID]
        .filter((x) => typeof x === 'string' && x.length >= 8);
    for (const secret of secrets) s = s.split(secret).join('[redacted]');
    return s
        .replace(/(X-Shopify-Access-Token['"\s:=]+)[^\s'",}]+/gi, '$1[redacted]')
        .replace(/(Bearer\s+)[^\s'",}]+/gi, '$1[redacted]');
}

/** An Error whose message is already scrubbed, carrying structured context. */
function shopifyError(message, extra = {}) {
    const err = new Error(redactShopify(message));
    Object.assign(err, extra);
    err.isShopifyError = true;
    return err;
}

// ── Token ────────────────────────────────────────────────────────────────────

async function mintToken() {
    const missing = missingConfig();
    if (missing.length) {
        throw shopifyError(`Shopify credentials missing: ${missing.join(', ')}`, { code: 'NOT_CONFIGURED', missing });
    }

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET
    });

    let resp;
    try {
        resp = await axios.post(`https://${shopDomain()}/admin/oauth/access_token`, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: REQUEST_TIMEOUT_MS
        });
    } catch (err) {
        const status = err.response && err.response.status;
        throw shopifyError(`Shopify token request failed (HTTP ${status || '?'})`, { code: 'TOKEN_FAILED', status });
    }

    if (!resp.data || !resp.data.access_token) {
        throw shopifyError('Shopify token response missing access_token', { code: 'TOKEN_FAILED' });
    }

    const now = Math.floor(Date.now() / 1000);
    accessToken = resp.data.access_token;
    const expiresIn = Number(resp.data.expires_in) || 86400;
    tokenExpiryTime = now + Math.floor(expiresIn * 0.9);
    // NOTE: never log the token itself.
    console.log(`[Shopify] New access token (expires_in ${expiresIn}s, cached ${Math.floor(expiresIn * 0.9)}s)`);
    return accessToken;
}

/**
 * Cached token with single-flight. Ten concurrent callers on a cold dyno share one
 * mint; without this each would fire its own OAuth round-trip.
 */
async function getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (accessToken && now < tokenExpiryTime - TOKEN_BUFFER_SECONDS) return accessToken;

    if (inFlightTokenPromise) return inFlightTokenPromise;

    inFlightTokenPromise = mintToken().finally(() => { inFlightTokenPromise = null; });
    return inFlightTokenPromise;
}

function resetTokenCache() {
    accessToken = null;
    tokenExpiryTime = 0;
    inFlightTokenPromise = null;
}

/**
 * Seconds of token life remaining. The orchestrator refreshes BEFORE starting a
 * multi-step create so a token cannot expire between productSet and the variant
 * media binding — a gap there is exactly how a product ends up with unbound variants.
 */
function tokenSecondsRemaining() {
    if (!accessToken) return 0;
    return Math.max(0, tokenExpiryTime - Math.floor(Date.now() / 1000));
}

// ── Errors, throttling ───────────────────────────────────────────────────────

/**
 * How the caller should react.
 *   'retry'     — safe to run the identical call again (throttle, network, 5xx on a READ)
 *   'reconcile' — MAY have applied; re-read state and converge. Never blind-retry.
 *   'auth'      — token rejected; refresh once.
 *   'fatal'     — a bad request or a rejected mutation. Retrying changes nothing.
 */
function classifyShopifyError(err, { isMutation = false } = {}) {
    if (!err) return 'fatal';
    if (err.code === 'THROTTLED') return 'retry';
    if (err.code === 'USER_ERRORS' || err.code === 'GRAPHQL_ERRORS') return 'fatal';
    if (err.code === 'NOT_CONFIGURED' || err.code === 'TOKEN_FAILED') return 'fatal';

    const status = err.status || (err.response && err.response.status);
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'retry';
    if (status >= 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
        // RULE 2. A read is idempotent, so replaying it is free. A mutation may have
        // landed before the connection died — replaying it risks a duplicate product,
        // and this store forbids deletion, so the duplicate would be permanent.
        return isMutation ? 'reconcile' : 'retry';
    }
    if (status >= 400) return 'fatal';
    return 'retry';
}

/**
 * Milliseconds to wait before retrying a throttled GraphQL call.
 * Shopify's bucket refills at restoreRate points/second, so waiting for the
 * shortfall is exact rather than guessed.
 */
function computeThrottleWaitMs(cost, throttleStatus) {
    const requested = Number((cost && cost.requestedQueryCost) || 0);
    const available = Number((throttleStatus && throttleStatus.currentlyAvailable) || 0);
    const restoreRate = Number((throttleStatus && throttleStatus.restoreRate) || 0) || 50;
    const shortfall = requested - available;
    if (shortfall <= 0) return 0;
    return Math.min(10000, Math.ceil(shortfall / restoreRate) * 1000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Walk a GraphQL data payload for any non-empty *userErrors array.
 * Generic on purpose: productSet returns `userErrors`, productCreateMedia returns
 * `mediaUserErrors`, and future mutations will invent their own name. Naming them
 * one by one guarantees the next one is missed.
 */
function collectUserErrors(node, path = [], found = []) {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
        node.forEach((item, i) => collectUserErrors(item, path.concat(i), found));
        return found;
    }
    for (const [key, value] of Object.entries(node)) {
        if (/userErrors$/i.test(key) && Array.isArray(value) && value.length) {
            value.forEach((ue) => found.push({ at: path.concat(key).join('.'), ...ue }));
        } else {
            collectUserErrors(value, path.concat(key), found);
        }
    }
    return found;
}

// ── Transport ────────────────────────────────────────────────────────────────

async function rawRequest(url, { method = 'GET', data, headers = {} } = {}) {
    const token = await getToken();
    return axios({
        method,
        url,
        data,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...headers },
        // Resolve on any status so we classify centrally rather than through axios throws.
        validateStatus: () => true
    });
}

/**
 * Execute a GraphQL query or mutation.
 * Throws on: top-level `errors`, ANY non-empty *userErrors, or a non-2xx status.
 * Retries: throttling (with the exact computed wait) and a single 401 re-auth.
 * Never retries a mutation on 5xx — see RULE 2.
 */
async function gql(query, variables = {}, options = {}) {
    if (!isConfigured()) {
        throw shopifyError('Shopify not configured', { code: 'NOT_CONFIGURED', missing: missingConfig() });
    }

    const isMutation = options.isMutation !== undefined
        ? options.isMutation
        : /^\s*mutation\b/.test(query);
    const url = `https://${shopDomain()}/admin/api/${apiVersion()}/graphql.json`;

    let authRetried = false;
    for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
        const resp = await rawRequest(url, { method: 'POST', data: { query, variables } });

        if (resp.status === 401 && !authRetried) {
            authRetried = true;
            resetTokenCache();
            continue;
        }

        if (resp.status >= 400) {
            const err = shopifyError(
                `Shopify GraphQL HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 600)}`,
                { code: 'HTTP_ERROR', status: resp.status }
            );
            err.disposition = classifyShopifyError(err, { isMutation });
            throw err;
        }

        const payload = resp.data || {};

        // Throttled: Shopify returns 200 with an error carrying the bucket state.
        const throttled = Array.isArray(payload.errors)
            && payload.errors.some((e) => e && e.extensions && e.extensions.code === 'THROTTLED');
        if (throttled && attempt < MAX_THROTTLE_RETRIES) {
            const cost = (payload.extensions && payload.extensions.cost) || {};
            const wait = computeThrottleWaitMs(cost, cost.throttleStatus) || 1000;
            console.warn(`[Shopify] Throttled — waiting ${wait}ms (attempt ${attempt + 1}/${MAX_THROTTLE_RETRIES})`);
            await sleep(wait);
            continue;
        }

        if (Array.isArray(payload.errors) && payload.errors.length) {
            throw shopifyError(
                `Shopify GraphQL errors: ${JSON.stringify(payload.errors).slice(0, 600)}`,
                { code: throttled ? 'THROTTLED' : 'GRAPHQL_ERRORS', graphqlErrors: payload.errors }
            );
        }

        // RULE 1 — a 200 with userErrors is a failure.
        const userErrors = collectUserErrors(payload.data);
        if (userErrors.length) {
            throw shopifyError(
                `Shopify rejected the request: ${userErrors.map((e) => `${e.at}: ${e.message}`).join(' | ').slice(0, 600)}`,
                { code: 'USER_ERRORS', userErrors }
            );
        }

        // Pre-emptive backoff so the NEXT call in a create sequence isn't throttled.
        const cost = (payload.extensions && payload.extensions.cost) || null;
        if (cost && cost.throttleStatus && Number(cost.throttleStatus.currentlyAvailable) < THROTTLE_FLOOR) {
            const restoreRate = Number(cost.throttleStatus.restoreRate) || 50;
            await sleep(Math.min(3000, Math.ceil((THROTTLE_FLOOR / restoreRate)) * 1000));
        }

        return payload.data;
    }

    throw shopifyError('Shopify still throttled after maximum retries', { code: 'THROTTLED' });
}

/**
 * REST call, path relative to /admin/api/<version>/ — e.g. 'products/123.json'.
 * Kept because publishing has a REST fallback: setting status ACTIVE via GraphQL
 * leaves publishedAt null and the storefront 404s, and publishablePublish needs
 * read_publications. See Downloads/253gear-ops/shopify/sh.py:65-79.
 * NOTE: REST is a SEPARATE rate-limit bucket signalled by 429 + Retry-After —
 * the GraphQL cost math does not apply here.
 */
async function rest(path, body = null, method = 'GET') {
    if (!isConfigured()) {
        throw shopifyError('Shopify not configured', { code: 'NOT_CONFIGURED', missing: missingConfig() });
    }

    const url = `https://${shopDomain()}/admin/api/${apiVersion()}/${path.replace(/^\//, '')}`;
    const isMutation = method !== 'GET' && method !== 'HEAD';

    let authRetried = false;
    for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
        const resp = await rawRequest(url, { method, data: body === null ? undefined : body });

        if (resp.status === 401 && !authRetried) {
            authRetried = true;
            resetTokenCache();
            continue;
        }

        if (resp.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
            const retryAfter = Number(resp.headers && resp.headers['retry-after']) || 2;
            console.warn(`[Shopify] REST 429 — honouring Retry-After ${retryAfter}s`);
            await sleep(retryAfter * 1000);
            continue;
        }

        if (resp.status >= 400) {
            const err = shopifyError(
                `Shopify REST HTTP ${resp.status} on ${method} ${path}: ${JSON.stringify(resp.data).slice(0, 400)}`,
                { code: 'HTTP_ERROR', status: resp.status }
            );
            err.disposition = classifyShopifyError(err, { isMutation });
            throw err;
        }

        return resp.data;
    }

    throw shopifyError('Shopify REST still rate-limited after maximum retries', { code: 'THROTTLED' });
}

module.exports = {
    gql,
    rest,
    getToken,
    isConfigured,
    missingConfig,
    apiVersion,
    shopDomain,
    storefrontOrigin,
    tokenSecondsRemaining,
    // exported for jest
    resetTokenCache,
    redactShopify,
    classifyShopifyError,
    computeThrottleWaitMs,
    collectUserErrors
};
