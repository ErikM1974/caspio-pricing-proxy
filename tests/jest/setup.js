/**
 * Shared test helpers for Jest integration tests.
 * Usage: const { api, delay, testId, trackForCleanup, cleanupAll } = require('./setup');
 */
const axios = require('axios');

// Load .env so CRM_API_SECRET is available when jest runs outside the server
// process (dotenv is a server dependency; harmless if the file is absent).
require('dotenv').config();

const BASE_URL = process.env.TEST_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// The quote data plane is secret-gated since 2026-08-27 (QUOTE_PLANE_GATE=
// enforce — sessions/items/analytics/change_log/sequence/push all 401 without
// X-CRM-API-Secret). Send the secret so these tests exercise the routes as a
// legitimate caller; without it every quote_* suite fails with 401 BY DESIGN.
// The header is harmless on ungated routes.
//
// 🔴 SAY SO WHEN THE SECRET IS MISSING. Falling back to no header is right — the ungated
// suites must still run — but dropping it SILENTLY turns one config problem into fourteen
// unexplained 401s across three suites, which reads like a broken gate or a broken API.
// That is exactly how it presented on 2026-08-26 and it cost real time to attribute.
// Warn, never throw: almost every suite here needs no secret at all.
if (!process.env.CRM_API_SECRET) {
  console.warn(
    '[tests/setup] CRM_API_SECRET is not set (no .env?). The quote data plane is gated, so '
    + 'quote-sessions / quote-items / quote-sequence WILL fail with 401 — that is configuration, '
    + 'not a regression. Every other suite is unaffected.'
  );
}

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 25000,
  validateStatus: () => true, // Don't throw on 4xx/5xx
  headers: process.env.CRM_API_SECRET
    ? { 'X-CRM-API-Secret': process.env.CRM_API_SECRET }
    : {},
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
