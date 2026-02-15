/**
 * Shared test helpers for Jest integration tests.
 * Usage: const { api, delay, testId, trackForCleanup, cleanupAll } = require('./setup');
 */
const axios = require('axios');

const BASE_URL = process.env.TEST_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Axios instance — never throws on HTTP errors so we can assert status codes
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 25000,
  validateStatus: () => true, // Don't throw on 4xx/5xx
});

// Retry interceptor for 429 rate limits
api.interceptors.response.use(async (response) => {
  if (response.status === 429 && !response.config._retried) {
    response.config._retried = true;
    await delay(5000);
    return api.request(response.config);
  }
  return response;
});

/** Sleep helper for rate-limit spacing */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Generate a unique test ID with timestamp */
function testId(prefix = 'JEST') {
  return `TEST-${prefix}-${Date.now()}`;
}

// Track resources for cleanup
const _tracked = [];

/**
 * Register a resource for cleanup in afterAll.
 * @param {'session'|'item'} type
 * @param {string|number} id - PK_ID or QuoteID
 */
function trackForCleanup(type, id) {
  _tracked.push({ type, id });
}

/**
 * Delete all tracked resources. Call in afterAll().
 * Silently ignores failures (resource may already be deleted).
 */
async function cleanupAll() {
  for (const { type, id } of _tracked) {
    try {
      if (type === 'session') {
        await api.delete(`/api/quote_sessions/${id}`);
      } else if (type === 'item') {
        await api.delete(`/api/quote_items/${id}`);
      }
      await delay(500);
    } catch (_) {
      // Ignore — resource may already be deleted by the test
    }
  }
  _tracked.length = 0;
}

module.exports = { api, delay, testId, trackForCleanup, cleanupAll, BASE_URL };
