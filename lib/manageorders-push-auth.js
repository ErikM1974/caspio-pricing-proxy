/**
 * ManageOrders PUSH API - Authentication Module
 *
 * Handles authentication with ManageOrders PUSH API:
 * - Token acquisition via signin
 * - Token caching with expiration
 * - Auto-refresh on token expiry
 *
 * Environment Variables Required:
 * - MANAGEORDERS_USERNAME
 * - MANAGEORDERS_PASSWORD
 */

const axios = require('axios');

const MANAGEORDERS_PUSH_BASE_URL = 'https://manageordersapi.com/onsite';
const TOKEN_CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour (tokens expire after 1 hour)

// Token cache — per-endpoint Map for multi-integration support
// Key: base URL, Value: { token, expiresAt }
const tokenCacheByUrl = new Map();

// Legacy single-endpoint cache (backward compat for getToken())
let cachedToken = null;
let tokenExpiresAt = null;

/**
 * Sign in to a specific ManageOrders endpoint and get authentication token
 *
 * @param {string} baseUrl - Base URL of the ManageOrders integration (e.g., '/onsite' or '/embroidery')
 * @returns {Promise<Object>} Authentication response with id_token, access_token, refresh_token
 * @throws {Error} If authentication fails
 */
async function signinForEndpoint(baseUrl) {
  const username = process.env.MANAGEORDERS_USERNAME;
  const password = process.env.MANAGEORDERS_PASSWORD;

  if (!username || !password) {
    throw new Error('ManageOrders credentials not configured. Set MANAGEORDERS_USERNAME and MANAGEORDERS_PASSWORD environment variables.');
  }

  const signinUrl = `${baseUrl}/signin`;
  try {
    console.log(`[ManageOrders PUSH] Authenticating against ${signinUrl}...`);

    const response = await axios.post(
      signinUrl,
      { username, password },
      {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 10000
      }
    );

    if (response.data.status === 'success' && response.data.id_token) {
      console.log(`[ManageOrders PUSH] Authentication successful for ${baseUrl}`);
      return response.data;
    } else {
      throw new Error(`Authentication response missing id_token from ${signinUrl}`);
    }
  } catch (error) {
    if (error.response) {
      console.error(`[ManageOrders PUSH] Auth failed for ${baseUrl}:`, error.response.status, error.response.data);
      throw new Error(`Authentication failed: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error(`[ManageOrders PUSH] No response from ${signinUrl}`);
      throw new Error(`No response from ManageOrders authentication server at ${signinUrl}. Check network connection.`);
    } else {
      console.error(`[ManageOrders PUSH] Auth error for ${baseUrl}:`, error.message);
      throw error;
    }
  }
}

/**
 * Get a valid authentication token for a specific ManageOrders endpoint
 * Tokens are cached per base URL with 1-hour expiration.
 *
 * @param {string} baseUrl - Base URL of the ManageOrders integration
 * @param {boolean} forceRefresh - Force token refresh even if cached token is valid
 * @returns {Promise<string>} Valid id_token for API requests
 * @throws {Error} If authentication fails
 */
async function getTokenForEndpoint(baseUrl, forceRefresh = false) {
  const now = Date.now();
  const cached = tokenCacheByUrl.get(baseUrl);

  if (!forceRefresh && cached && cached.expiresAt && now < cached.expiresAt) {
    const minutesRemaining = Math.floor((cached.expiresAt - now) / 60000);
    console.log(`[ManageOrders PUSH] Using cached token for ${baseUrl} (expires in ${minutesRemaining} min)`);
    return cached.token;
  }

  console.log(`[ManageOrders PUSH] Token expired or missing for ${baseUrl}, refreshing...`);
  const authResponse = await signinForEndpoint(baseUrl);

  tokenCacheByUrl.set(baseUrl, {
    token: authResponse.id_token,
    expiresAt: now + TOKEN_CACHE_DURATION_MS,
  });

  return authResponse.id_token;
}

/**
 * Sign in to ManageOrders PUSH API and get authentication token
 * (Legacy — uses default /onsite endpoint)
 *
 * @returns {Promise<Object>} Authentication response with id_token, access_token, refresh_token
 * @throws {Error} If authentication fails
 */
async function signin() {
  const username = process.env.MANAGEORDERS_USERNAME;
  const password = process.env.MANAGEORDERS_PASSWORD;

  if (!username || !password) {
    throw new Error('ManageOrders credentials not configured. Set MANAGEORDERS_USERNAME and MANAGEORDERS_PASSWORD environment variables.');
  }

  try {
    console.log('[ManageOrders PUSH] Authenticating...');

    const response = await axios.post(
      `${MANAGEORDERS_PUSH_BASE_URL}/signin`,
      {
        username,
        password
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 10000 // 10 second timeout
      }
    );

    if (response.data.status === 'success' && response.data.id_token) {
      console.log('[ManageOrders PUSH] Authentication successful');
      return response.data;
    } else {
      throw new Error('Authentication response missing id_token');
    }
  } catch (error) {
    if (error.response) {
      console.error('[ManageOrders PUSH] Authentication failed:', error.response.status, error.response.data);
      throw new Error(`Authentication failed: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error('[ManageOrders PUSH] No response from authentication server');
      throw new Error('No response from ManageOrders authentication server. Check network connection.');
    } else {
      console.error('[ManageOrders PUSH] Authentication error:', error.message);
      throw error;
    }
  }
}

/**
 * Get a valid authentication token (from cache or by signing in)
 *
 * @param {boolean} forceRefresh - Force token refresh even if cached token is valid
 * @returns {Promise<string>} Valid id_token for API requests
 * @throws {Error} If authentication fails
 */
async function getToken(forceRefresh = false) {
  const now = Date.now();

  // Return cached token if still valid
  if (!forceRefresh && cachedToken && tokenExpiresAt && now < tokenExpiresAt) {
    const minutesRemaining = Math.floor((tokenExpiresAt - now) / 60000);
    console.log(`[ManageOrders PUSH] Using cached token (expires in ${minutesRemaining} minutes)`);
    return cachedToken;
  }

  // Token expired or doesn't exist - get a new one
  console.log('[ManageOrders PUSH] Token expired or missing, refreshing...');
  const authResponse = await signin();

  // Cache the new token
  cachedToken = authResponse.id_token;
  tokenExpiresAt = now + TOKEN_CACHE_DURATION_MS;

  return cachedToken;
}

/**
 * Clear cached token (useful for testing or forcing re-authentication)
 */
function clearTokenCache() {
  console.log('[ManageOrders PUSH] Clearing token cache');
  cachedToken = null;
  tokenExpiresAt = null;
  tokenCacheByUrl.clear();
}

/**
 * Test authentication credentials
 *
 * @returns {Promise<Object>} Test result with success status and token info
 */
async function testAuth() {
  try {
    const token = await getToken(true); // Force fresh token

    return {
      success: true,
      message: 'Authentication successful',
      tokenExpires: new Date(tokenExpiresAt).toISOString(),
      tokenLength: token.length
    };
  } catch (error) {
    return {
      success: false,
      message: 'Authentication failed',
      error: error.message
    };
  }
}

module.exports = {
  signin,
  getToken,
  getTokenForEndpoint,
  clearTokenCache,
  testAuth,
  MANAGEORDERS_PUSH_BASE_URL
};
