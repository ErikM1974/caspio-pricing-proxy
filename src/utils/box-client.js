// Box API client helpers — shared across route files.
//
// Extracts the token + request helpers from box-upload.js (2026-04-24) so that
// new routes (e.g., transfer-orders.js analyze-link) don't duplicate auth logic
// or maintain a parallel token cache.
//
// Auth: Box Client Credentials Grant (SanMar Inventory Import app).
// Env: BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID.
//
// Exports:
//   getBoxAccessToken()              — cached OAuth token (60s buffer)
//   boxRequest(method, url, data, extraHeaders)
//   boxGetFileInfo(fileId, fields)   — GET /files/:id metadata
//   boxFetchFileBytes(fileId, opts)  — GET /files/:id/content (optional Range)
//   boxResolveSharedLink(sharedUrl)  — GET /shared_items (resolves /s/… URLs)
//   parseBoxFileUrl(url)             — extracts {fileId | sharedToken | sharedUrl} from an input URL

const axios = require('axios');

const BOX_API_BASE = 'https://api.box.com/2.0';
const BOX_OAUTH_URL = 'https://api.box.com/oauth2/token';

const BOX_CLIENT_ID = process.env.BOX_CLIENT_ID;
const BOX_CLIENT_SECRET = process.env.BOX_CLIENT_SECRET;
const BOX_ENTERPRISE_ID = process.env.BOX_ENTERPRISE_ID;

// ── Token Cache ────────────────────────────────────────────────────────
let boxAccessToken = null;
let boxTokenExpiry = 0;

async function getBoxAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (boxAccessToken && now < (boxTokenExpiry - 60)) {
        return boxAccessToken;
    }

    console.log('Box: Requesting new access token (Client Credentials Grant)...');
    const resp = await axios.post(BOX_OAUTH_URL, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: BOX_CLIENT_ID,
        client_secret: BOX_CLIENT_SECRET,
        box_subject_type: 'enterprise',
        box_subject_id: BOX_ENTERPRISE_ID
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    boxAccessToken = resp.data.access_token;
    boxTokenExpiry = now + resp.data.expires_in;
    console.log('Box: Token obtained, expires in', resp.data.expires_in, 'seconds');
    return boxAccessToken;
}

// ── Generic Request Helper ─────────────────────────────────────────────

async function boxRequest(method, url, data, extraHeaders) {
    const token = await getBoxAccessToken();
    const headers = {
        'Authorization': `Bearer ${token}`,
        ...extraHeaders
    };
    return axios({ method, url, data, headers, timeout: 30000 });
}

// ── File Metadata ──────────────────────────────────────────────────────

/**
 * Fetch file info (name, size, extension, parent, etc.).
 * @param {string} fileId
 * @param {string[]} [fields] - Box fields to return (default: name + size + extension)
 * @param {string} [sharedLink] - Optional shared-link URL; adds the `BoxApi` header
 *   so we can read files the enterprise user wouldn't otherwise see.
 */
async function boxGetFileInfo(fileId, fields, sharedLink) {
    const fieldsParam = (fields && fields.length)
        ? '?fields=' + encodeURIComponent(fields.join(','))
        : '?fields=name,size,extension,type';
    const url = `${BOX_API_BASE}/files/${fileId}${fieldsParam}`;
    const extraHeaders = sharedLink ? { 'BoxApi': `shared_link=${sharedLink}` } : {};
    const resp = await boxRequest('get', url, null, extraHeaders);
    return resp.data;
}

// ── File Content (with optional Range) ─────────────────────────────────

/**
 * Fetch file bytes from /files/:id/content. When `rangeBytes` is supplied,
 * adds `Range: bytes=0-<N-1>` so we only download the first N bytes
 * (useful for image-size parsing — we don't need full 167KB PNGs for dims).
 *
 * Returns a Node Buffer. Box sometimes ignores the Range for small files and
 * returns the whole body — that's fine, we get what we get and slice later
 * if the caller cares about exact size.
 *
 * @param {string} fileId
 * @param {object} [opts]
 * @param {number} [opts.rangeBytes]  - if set, only the first N bytes
 * @param {string} [opts.sharedLink]  - if the file is only accessible via a
 *   shared link URL (files outside the service account's scope), pass the
 *   full shared URL here.
 * @returns {Promise<Buffer>}
 */
async function boxFetchFileBytes(fileId, opts) {
    opts = opts || {};
    const url = `${BOX_API_BASE}/files/${fileId}/content`;
    const headers = {};
    if (opts.rangeBytes && opts.rangeBytes > 0) {
        headers['Range'] = `bytes=0-${opts.rangeBytes - 1}`;
    }
    if (opts.sharedLink) {
        headers['BoxApi'] = `shared_link=${opts.sharedLink}`;
    }

    const token = await getBoxAccessToken();
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}`, ...headers },
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 5,
        // Box redirects /content → a pre-signed URL; axios handles the follow
        // automatically, but we also explicitly accept partial content.
        validateStatus: (s) => s === 200 || s === 206
    });
    return Buffer.from(resp.data);
}

// ── Shared Link Resolution ─────────────────────────────────────────────

/**
 * Given a shared-link URL like https://northwestcustomapparel.app.box.com/s/abc123xyz,
 * resolve it to the underlying file metadata (including id + name).
 *
 * Uses /shared_items with the required `BoxApi: shared_link=<url>` header —
 * per Box docs, the header is MANDATORY for this endpoint, and a missing
 * header returns 404 even if the link is valid.
 *
 * @param {string} sharedUrl - full /s/… URL (not the bare token)
 * @returns {Promise<{id: string, name: string, type: string, size: number}>}
 */
async function boxResolveSharedLink(sharedUrl) {
    const url = `${BOX_API_BASE}/shared_items`;
    const resp = await boxRequest('get', url, null, {
        'BoxApi': `shared_link=${sharedUrl}`
    });
    return resp.data; // { id, name, type, size, ... }
}

// ── URL Parsing ────────────────────────────────────────────────────────

/**
 * Crack a user-pasted Box URL into actionable bits.
 *
 * Handles three known shapes:
 *   1. Direct file:        https://ANY.app.box.com/file/1815321
 *   2. Shared file:        https://ANY.app.box.com/s/abc123xyz
 *   3. Shared with folder: https://ANY.app.box.com/folder/378173?s=abc123xyz
 *   4. "shared_link=" raw: https://ANY.app.box.com/shared/static/abc123xyz.png
 *
 * Returns null when the URL doesn't match any known pattern. Callers should
 * treat null as "not a Box link" and surface the error to the user.
 */
function parseBoxFileUrl(input) {
    if (!input || typeof input !== 'string') return null;
    const url = input.trim();

    // Must be a Box URL (any *.box.com subdomain)
    if (!/\bbox\.com\//i.test(url)) return null;

    // Shape 1: /file/<numeric id>
    const directMatch = url.match(/\/file\/(\d+)/);
    if (directMatch) {
        return { kind: 'direct', fileId: directMatch[1] };
    }

    // Shape 2: /s/<token> (file or folder — we'll find out via /shared_items)
    const sharedMatch = url.match(/\/s\/([A-Za-z0-9]+)/);
    if (sharedMatch) {
        // Preserve the URL as-is (without query string) for the BoxApi header
        const cleanUrl = url.split('?')[0];
        return { kind: 'shared', sharedToken: sharedMatch[1], sharedUrl: cleanUrl };
    }

    // Shape 3: /folder/<id>?s=<token> — treat as shared (we need the folder,
    // but analyze-link is for files, so this flag lets callers reject folders
    // with a friendly message)
    const folderWithSharedMatch = url.match(/\/folder\/(\d+)\?s=([A-Za-z0-9]+)/);
    if (folderWithSharedMatch) {
        return {
            kind: 'folder',
            folderId: folderWithSharedMatch[1],
            sharedToken: folderWithSharedMatch[2]
        };
    }

    // Shape 4: /shared/static/<token>.<ext> — direct CDN link
    const staticMatch = url.match(/\/shared\/static\/([A-Za-z0-9]+)/);
    if (staticMatch) {
        return { kind: 'static', sharedToken: staticMatch[1] };
    }

    return null;
}

module.exports = {
    BOX_API_BASE,
    getBoxAccessToken,
    boxRequest,
    boxGetFileInfo,
    boxFetchFileBytes,
    boxResolveSharedLink,
    parseBoxFileUrl
};
