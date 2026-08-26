// Caspio API utilities

const axios = require('axios');
const config = require('../config');
// LOAD-BEARING even though nothing here calls it: requiring api-tracker is what
// installs the global axios interceptor that meters every Caspio call. This
// module is required at boot by nearly every route, which is what guarantees the
// interceptor is attached before the first request. Do NOT drop this as an
// unused import.
require('./api-tracker');

// Token cache
let caspioAccessToken = null;
let tokenExpiryTime = 0;

/**
 * Gets a valid Caspio Access Token, requesting a new one if needed.
 * Uses simple in-memory cache.
 */
async function getCaspioAccessToken() {
  const now = Math.floor(Date.now() / 1000); // Time in seconds
  const bufferSeconds = 60; // Refresh token if it expires within 60 seconds

  if (caspioAccessToken && now < (tokenExpiryTime - bufferSeconds)) {
    return caspioAccessToken;
  }

  console.log("Requesting new Caspio access token...");
  try {
    const response = await axios.post(config.caspio.tokenUrl, new URLSearchParams({
      'grant_type': 'client_credentials',
      'client_id': config.caspio.clientId,
      'client_secret': config.caspio.clientSecret
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: config.timeouts.perRequest
    });

    if (response.data && response.data.access_token) {
      caspioAccessToken = response.data.access_token;
      tokenExpiryTime = now + response.data.expires_in;
      console.log("New Caspio token obtained. Expires around:", new Date(tokenExpiryTime * 1000).toLocaleTimeString());
      return caspioAccessToken;
    } else {
      throw new Error("Invalid response structure from token endpoint.");
    }
  } catch (error) {
    console.error("Error getting Caspio access token:", error.response ? JSON.stringify(error.response.data) : error.message);
    caspioAccessToken = null;
    tokenExpiryTime = 0;
    throw new Error("Could not obtain Caspio access token.");
  }
}

/**
 * Makes an authenticated request to the Caspio API.
 * @deprecated Use fetchAllCaspioPages instead to handle Caspio pagination properly
 */
async function makeCaspioRequest(method, resourcePath, params = {}, data = null) {
  try {
    const token = await getCaspioAccessToken();
    const url = `${config.caspio.apiBaseUrl}${resourcePath}`;
    console.log(`Making Caspio Request: ${method.toUpperCase()} ${url} PARAMS: ${JSON.stringify(params)}`);

    const requestConfig = {
      method: method,
      url: url,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: params,
      data: data,
      timeout: config.timeouts.perRequest
    };

    console.log(`Request config: ${JSON.stringify(requestConfig, (key, value) =>
      key === 'Authorization' ? '***REDACTED***' : value)}`);

    const response = await axios(requestConfig);
    console.log(`Response status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);

    // NOTE: no trackCall here. Metering moved to the global axios interceptor in
    // utils/api-tracker.js (2026-07-26) so the ~236 direct-axios call sites and
    // the token fetches get counted too. Counting here as well would double-count.

    // Handle different response types based on HTTP method and status
    if (method.toLowerCase() === 'post' && response.status === 201) {
      // POST operations return 201 with empty body or location header
      return { 
        success: true, 
        status: response.status,
        location: response.headers.location,
        PK_ID: response.headers.location ? response.headers.location.split('/').pop() : null
      };
    } else if (method.toLowerCase() === 'delete' && (response.status === 200 || response.status === 204)) {
      // DELETE — Caspio answers 200 {"RecordsAffected": N} even when q.where
      // matched nothing (N=0). Pass the body through so callers can tell a real
      // delete from a no-op; discarding it here used to make every delete
      // handler report recordsAffected: 0 regardless of outcome (2026-07-08).
      const body = (response.data && typeof response.data === 'object') ? response.data : {};
      return { ...body, success: true, status: response.status };
    } else if (response.data) {
      // GET and PUT operations with data
      return response.data.Result || response.data;
    } else {
      // Empty response but successful status
      console.log("Caspio API response was empty but successful");
      return { success: true, status: response.status };
    }
  } catch (error) {
    console.error(`Error making Caspio request to ${resourcePath}:`, error.response ? JSON.stringify(error.response.data) : error.message);
    throw new Error(`Failed to make request to Caspio resource: ${resourcePath}. Status: ${error.response?.status}. Details: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
  }
}

/**
 * IMPORTANT: Caspio API uses pagination. This function fetches ALL records
 * from a Caspio resource, handling pagination.
 */
async function fetchAllCaspioPages(resourcePath, initialParams = {}, options = {}) {
  let allResults = [];
  let fetchedCount = 0; // counts rows even when discardResults skips accumulation
  let params = { ...initialParams };
  // 🔴 ONE PAGING MODEL, FROM PAGE 1. Do not go back to q.limit-then-q.pageNumber.
  //
  // This used to request page 1 with `q.limit` and pages 2+ with `q.pageSize`+`q.pageNumber`,
  // on the theory that q.limit is "universally compatible" for the first page. They are two
  // DIFFERENT paging models and Caspio does not agree between them about which rows are the
  // first N. Measured live on SanMar_Shipments (1,626 rows) 2026-08-26:
  //
  //     q.limit=1000                    -> 1000 rows, PK 1119..1271
  //     q.pageSize=1000&q.pageNumber=1  -> 1000 rows, PK    6..1005
  //     q.pageSize=1000&q.pageNumber=2  ->  626 rows, PK 1006..1631
  //
  // Page 2 therefore continued from a baseline page 1 never delivered: the call returned
  // 1,626 rows of which 326 were DUPLICATES, while 326 real rows were never returned at all.
  // Silent, and only on result sets larger than one page — so it hid behind every query with
  // a narrow q.where. Found while backfilling Ship_To, where it made the target count read
  // 202 instead of the true 165.
  //
  // Caspio rejects q.pageSize < 5 with IncorrectQueryParameter, and 51 call sites pass
  // `q.limit: 1` as an existence check. Those keep q.limit and are treated as SINGLE PAGE —
  // which is also what they always were in practice, just expensively: page 1 succeeded,
  // the fallback saw a "full" page and asked for q.pageSize=1&q.pageNumber=2, Caspio 400'd,
  // the 400-handler burned a token refresh and retried, and it 400'd again. Measured: FOUR
  // Caspio requests to read one row. Now it is one.
  const CASPIO_MIN_PAGE_SIZE = 5;   // below this Caspio rejects q.pageSize outright
  const pageSize = params['q.limit'] || params['q.pageSize'] || config.pagination.defaultLimit;
  const pageable = pageSize >= CASPIO_MIN_PAGE_SIZE;
  delete params['q.limit'];
  delete params['q.pageSize'];
  delete params['q.pageNumber'];
  if (pageable) {
    params['q.pageSize'] = pageSize;
    params['q.pageNumber'] = 1;
  } else {
    // Too small for Caspio to page. Ask once, return what comes back.
    params['q.limit'] = pageSize;
  }
  let nextPageUrl = `${config.caspio.apiBaseUrl}${resourcePath}`;

  const defaultOptions = {
    maxPages: config.pagination.maxPages,
    earlyExitCondition: null,
    pageCallback: null,
    totalTimeout: config.timeouts.totalPagination,
    // strict: throw instead of returning a silently-truncated page cap. See the
    // truncation guard at the end of this function.
    strict: false,
    // discardResults: stream-only mode — rows reach pageCallback but are never
    // accumulated, so a 150k-row scan doesn't hold the whole table in dyno
    // memory. The return value is []; earlyExitCondition's second argument
    // stays empty too. Callers must consume via pageCallback.
    discardResults: false
  };
  const mergedOptions = { ...defaultOptions, ...options };

  const startTime = Date.now();
  const checkTotalTimeout = () => {
    if (Date.now() - startTime > mergedOptions.totalTimeout) {
      console.log(`Total timeout reached for ${resourcePath} after ${Date.now() - startTime}ms`);
      return true;
    }
    return false;
  };

  try {
    let token = await getCaspioAccessToken();
    let pageCount = 0;
    let morePages = true;
    let currentRequestParams = { ...params };

    while (morePages && pageCount < mergedOptions.maxPages && !checkTotalTimeout()) {
      pageCount++;
      let currentUrl = nextPageUrl;

      if (pageCount === 1 || !nextPageUrl || !nextPageUrl.includes('@nextpage')) {
        // A FRESH object per page. This used to mutate one shared params object in place,
        // so every request alias-shared the same reference — harmless in production but it
        // made the outgoing params unobservable after the fact (a test reading axios's
        // recorded calls saw the LAST page number on all of them). Same model as page 1,
        // only the page number advances.
        currentRequestParams = pageable
          ? { ...params, 'q.pageNumber': pageCount }
          : { ...params };
        currentUrl = `${config.caspio.apiBaseUrl}${resourcePath}`;
      } else {
        currentRequestParams = undefined;
      }

      const requestConfig = {
        method: 'get',
        url: currentUrl,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        params: currentRequestParams,
        timeout: config.timeouts.perRequest
      };

      // Debug logging
      console.log(`Caspio Request URL: ${currentUrl}`);
      console.log(`Caspio Request Params:`, JSON.stringify(currentRequestParams));

      try {
        // Per-page auth retry: Caspio sometimes returns 400 "IncorrectQueryParameter"
        // (not 401) when the access token is stale mid-request — likely a cache-flip
        // race between concurrent requests. Null the token cache and retry once with
        // a fresh token. Benefits ALL routes using this helper, not just rosters.
        let authRetried = false;
        let response;
        while (!response) {
          try {
            response = await axios(requestConfig);
          } catch (axiosErr) {
            const errStatus = axiosErr.response?.status;
            if ((errStatus === 400 || errStatus === 401) && !authRetried) {
              console.warn(`[Caspio] ${errStatus} on ${resourcePath} page ${pageCount} — refreshing token and retrying once.`);
              caspioAccessToken = null;
              tokenExpiryTime = 0;
              token = await getCaspioAccessToken();
              requestConfig.headers.Authorization = `Bearer ${token}`;
              authRetried = true;
              continue; // retry inner loop with fresh token
            }
            throw axiosErr; // bubble to the normal 429/timeout/error handling below
          }
        }

        // NOTE: no trackCall here — the global axios interceptor in
        // utils/api-tracker.js counts every page (and the 400-retry's extra
        // request, which this spot never saw). See that file's header.

        if (response.data && response.data.Result) {
          const resultsThisPage = response.data.Result.length;
          fetchedCount += resultsThisPage;
          if (!mergedOptions.discardResults) {
            allResults = allResults.concat(response.data.Result);
          }

          // Enhanced pagination logging
          console.log(`[Pagination] Page ${pageCount}: Fetched ${resultsThisPage} records`);
          console.log(`[Pagination] Total collected so far: ${fetchedCount}`);
          console.log(`[Pagination] Has NextPageUrl: ${!!response.data.NextPageUrl}`);
          console.log(`[Pagination] TotalRecords: ${response.data.TotalRecords || 'N/A'}`);

          if (mergedOptions.pageCallback) {
            mergedOptions.pageCallback(response.data.Result, pageCount);
          }

          if (mergedOptions.earlyExitCondition && mergedOptions.earlyExitCondition(response.data.Result, allResults)) {
            console.log(`Early exit condition met for ${resourcePath} at page ${pageCount}`);
            morePages = false;
            break;
          }
        }

        if (response.data && response.data.TotalRecords !== undefined) {
          const totalRecords = response.data.TotalRecords;
          const fetchedSoFar = fetchedCount;
          console.log(`Page ${pageCount}: Fetched ${fetchedSoFar}/${totalRecords} records for ${resourcePath}`);
          if (fetchedSoFar >= totalRecords) {
            morePages = false;
          }
        }

        if (response.data && response.data.NextPageUrl) {
          nextPageUrl = response.data.NextPageUrl;
        } else {
          // Fallback pagination for Caspio v3 API
          const resultsThisPage = response.data.Result ? response.data.Result.length : 0;
          if (!pageable) {
            // q.limit-only mode: Caspio cannot page at this size, so a "full" page is the
            // whole answer. Continuing here is what cost three wasted calls per lookup.
            console.log(`[Pagination] q.limit=${pageSize} (< ${CASPIO_MIN_PAGE_SIZE}) — single page by design.`);
            morePages = false;
          } else if (resultsThisPage >= pageSize) {
            console.log(`[Pagination] No NextPageUrl, but got full page (${resultsThisPage} results). Continuing with pageNumber pagination.`);
            // Continue to next page - pageNumber will be set at top of next loop iteration
            nextPageUrl = `${config.caspio.apiBaseUrl}${resourcePath}`;
            morePages = true;
          } else {
            console.log(`[Pagination] Got partial page (${resultsThisPage} < ${pageSize}). This was the last page.`);
            morePages = false;
          }
        }

      } catch (pageError) {
        const status = pageError.response?.status;
        console.error('Axios error details:', {
          status,
          statusText: pageError.response?.statusText,
          data: pageError.response?.data,
          url: currentUrl,
          params: currentRequestParams
        });
        if (status === 429) {
          console.warn(`[Caspio] Rate limited on ${resourcePath} (page ${pageCount}). Returning ${allResults.length} partial results.`);
          const error = new Error('Caspio API rate limit exceeded');
          error.statusCode = 429;
          throw error;
        } else if (pageError.code === 'ECONNABORTED' || pageError.message.includes('timeout')) {
          console.log(`Timeout on page ${pageCount} for ${resourcePath}, continuing with collected data`);
          morePages = false;
        } else {
          throw pageError;
        }
      }
    }

    if (checkTotalTimeout()) {
      console.log(`Returning ${allResults.length} results collected before timeout for ${resourcePath}`);
    }

    // Truncation guard (opt-in, 2026-07-26). Hitting the page cap while Caspio
    // still has more rows returns a SILENTLY INCOMPLETE array — the caller cannot
    // tell 20,000-of-20,000 from 20,000-of-47,000. That has already bitten twice
    // (the 27k-row thumbnail table re-uploading "missing" rows; the unfiltered
    // Quote_Sessions scan). Opt in with { strict: true } on any query whose
    // correctness depends on completeness; the default stays permissive so the
    // ~600 existing call sites are unaffected.
    if (mergedOptions.strict && morePages && pageCount >= mergedOptions.maxPages) {
      const error = new Error(
        `Caspio pagination truncated: hit maxPages=${mergedOptions.maxPages} ` +
        `(${fetchedCount} rows) on ${resourcePath} with more rows available. ` +
        `Raise maxPages or narrow the query — a partial result here would be wrong, not just slow.`
      );
      error.code = 'CASPIO_PAGINATION_TRUNCATED';
      throw error;
    }

    console.log(`Total records fetched: ${fetchedCount} from ${pageCount} page(s) for ${resourcePath}`);
    return allResults;

  } catch (error) {
    console.error(`Error fetching all pages from ${resourcePath}:`, error.message);
    // A strict-mode truncation must reach the caller — the partial-return
    // below is exactly the silent incompleteness strict:true opts out of.
    if (error.code === 'CASPIO_PAGINATION_TRUNCATED') {
      throw error;
    }
    if (allResults.length > 0) {
      console.log(`Returning ${allResults.length} partial results collected before error`);
      return allResults;
    }
    throw error;
  }
}

/**
 * Caspio PUT that PRESERVES RecordsAffected. makeCaspioRequest returns
 * `data.Result || data` — when Caspio answers {"RecordsAffected":N,"Result":[]}
 * the empty-but-truthy [] wins and callers can't tell a real update from a
 * no-match (found 2026-07-11 on Sample_Checkout_Items; same latent bug in any
 * PUT that checks RecordsAffected). Returns the raw response body.
 */
async function putWithRecordsAffected(resourcePath, where, data) {
  const token = await getCaspioAccessToken();
  const response = await axios({
    method: 'put',
    url: `${config.caspio.apiBaseUrl}${resourcePath}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    params: { 'q.where': where },
    data,
    timeout: config.timeouts.perRequest
  });
  return response.data || {};
}

module.exports = {
  getCaspioAccessToken,
  makeCaspioRequest,
  fetchAllCaspioPages,
  putWithRecordsAffected
};
