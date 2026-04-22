// Supacolor (Codewolf Control) API client — OAuth2 Client Credentials + thin wrapper.
//
// Pulls job data from https://api.supacolor.com for the NWCA local mirror.
// Replaces the paste-OCR workflow for going-forward sync; paste-OCR stays as fallback.
//
// Auth pattern mirrors src/utils/caspio.js (in-memory token cache, 60s buffer).
// Tokens live ~1 hour; Supacolor recommends caching at 90% of `expires_in`.
//
// Env vars (set on Heroku):
//   SUPACOLOR_CLIENT_ID
//   SUPACOLOR_CLIENT_SECRET
//   SUPACOLOR_API_BASE_URL   (default https://api.supacolor.com)
//   SUPACOLOR_OAUTH_URL      (default US-region Keycloak)

const axios = require('axios');

const DEFAULT_API_BASE = 'https://api.supacolor.com';
const DEFAULT_OAUTH_URL = 'https://keycloak-uswest.codewolf.co.nz/realms/sc/protocol/openid-connect/token';
const APPLICATION_NAME = 'nwca-pricing-index';
const REQUEST_TIMEOUT_MS = 30000;

let supacolorAccessToken = null;
let tokenExpiryTime = 0; // epoch seconds

function getApiBase() {
    return process.env.SUPACOLOR_API_BASE_URL || DEFAULT_API_BASE;
}

function getOAuthUrl() {
    return process.env.SUPACOLOR_OAUTH_URL || DEFAULT_OAUTH_URL;
}

/**
 * Fetch a fresh OAuth2 access token via client-credentials flow.
 * Caches in-memory until ~90% of expires_in has elapsed.
 */
async function getSupacolorToken() {
    const now = Math.floor(Date.now() / 1000);
    const bufferSeconds = 60;

    if (supacolorAccessToken && now < tokenExpiryTime - bufferSeconds) {
        return supacolorAccessToken;
    }

    const clientId = process.env.SUPACOLOR_CLIENT_ID;
    const clientSecret = process.env.SUPACOLOR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Supacolor credentials missing: set SUPACOLOR_CLIENT_ID + SUPACOLOR_CLIENT_SECRET');
    }

    console.log('[Supacolor] Requesting new access token…');
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
    });
    const resp = await axios.post(getOAuthUrl(), body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: REQUEST_TIMEOUT_MS
    });

    if (!resp.data || !resp.data.access_token) {
        throw new Error('Supacolor token response missing access_token');
    }

    supacolorAccessToken = resp.data.access_token;
    const expiresIn = resp.data.expires_in || 3600;
    // Cache at 90% of expires_in (matches Supacolor's recommendation)
    tokenExpiryTime = now + Math.floor(expiresIn * 0.9);
    console.log(`[Supacolor] Got token (expires in ${expiresIn}s, cached until ${new Date(tokenExpiryTime * 1000).toLocaleTimeString()})`);
    return supacolorAccessToken;
}

/**
 * Make an authenticated request against the Supacolor API.
 * Single retry on 401: nulls the token cache and re-fetches once.
 * Does NOT auto-retry POST/PATCH beyond the 401 re-auth path.
 */
async function supacolorRequest(path, { method = 'GET', query, body, headers = {} } = {}) {
    const fullUrl = `${getApiBase()}${path}`;

    async function doRequest() {
        const token = await getSupacolorToken();
        const config = {
            method,
            url: fullUrl,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Application-Name': APPLICATION_NAME,
                ...headers
            },
            timeout: REQUEST_TIMEOUT_MS
        };
        if (query) config.params = query;
        if (body !== undefined) config.data = body;
        return axios(config);
    }

    let resp;
    try {
        resp = await doRequest();
    } catch (err) {
        const status = err.response && err.response.status;
        if (status === 401) {
            console.warn(`[Supacolor] 401 on ${method} ${path} — refreshing token and retrying once.`);
            supacolorAccessToken = null;
            tokenExpiryTime = 0;
            resp = await doRequest();
        } else {
            throw err;
        }
    }

    if (resp.status === 204) return null;
    return resp.data;
}

/**
 * GET /Jobs/active — paginated list of active + (optionally) closed jobs.
 * Cancelled jobs are ALWAYS excluded by Supacolor (per API doc).
 */
async function listActiveJobs({
    page = 1,
    pageSize = 100,
    includeClosedJobs = true,
    searchText,
    sortColumn = 'JobNumber',
    sortDirection = 'Descending'
} = {}) {
    const query = { page, pageSize, includeClosedJobs, sortColumn, sortDirection };
    if (searchText) query.searchText = searchText;
    return await supacolorRequest('/Jobs/active', { query });
}

/**
 * GET /Jobs/{jobNumber} — full detail (lines, shipping, tracking).
 */
async function getJobDetail(jobNumber) {
    return await supacolorRequest(`/Jobs/${encodeURIComponent(jobNumber)}`);
}

/**
 * GET /Jobs/{jobNumber}/history — event timeline.
 */
async function getJobHistory(jobNumber) {
    return await supacolorRequest(`/Jobs/${encodeURIComponent(jobNumber)}/history`);
}

/**
 * Walk all pages of /Jobs/active and return a flat array of job stubs.
 * Terminates on hasNextPage=false. Guards against infinite loops with a hard cap.
 */
async function fetchAllActiveJobs(opts = {}) {
    const pageSize = opts.pageSize || 100;
    const maxPages = opts.maxPages || 50; // 50 × 100 = 5000 jobs — plenty
    const all = [];
    let page = 1;
    while (page <= maxPages) {
        const data = await listActiveJobs({ ...opts, page, pageSize });
        const items = (data && data.items) || [];
        all.push(...items);
        if (!data || !data.hasNextPage) break;
        page++;
    }
    return all;
}

module.exports = {
    getSupacolorToken,
    supacolorRequest,
    listActiveJobs,
    getJobDetail,
    getJobHistory,
    fetchAllActiveJobs
};
