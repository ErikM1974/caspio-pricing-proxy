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

// Token cache
let cachedToken = null;
let tokenExpiresAt = null;

/**
 * Sign in to ManageOrders PUSH API and get authentication token
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
  clearTokenCache,
  testAuth,
  MANAGEORDERS_PUSH_BASE_URL
};
