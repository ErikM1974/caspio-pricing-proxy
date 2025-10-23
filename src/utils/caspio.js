// Caspio API utilities

const axios = require('axios');
const config = require('../config');

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
      // DELETE operations 
      return { success: true, status: response.status };
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
  let params = { ...initialParams };
  params['q.limit'] = params['q.limit'] || config.pagination.defaultLimit;
  let nextPageUrl = `${config.caspio.apiBaseUrl}${resourcePath}`;

  const defaultOptions = {
    maxPages: config.pagination.maxPages,
    earlyExitCondition: null,
    pageCallback: null,
    totalTimeout: config.timeouts.totalPagination
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
    const token = await getCaspioAccessToken();
    let pageCount = 0;
    let morePages = true;
    let currentRequestParams = { ...params };

    while (morePages && pageCount < mergedOptions.maxPages && !checkTotalTimeout()) {
      pageCount++;
      let currentUrl = nextPageUrl;

      if (pageCount === 1 || !nextPageUrl || !nextPageUrl.includes('@nextpage')) {
        // For v3 API, use q.pageNumber and q.pageSize for pagination
        if (pageCount > 1) {
          currentRequestParams['q.pageNumber'] = pageCount;
          currentRequestParams['q.pageSize'] = params['q.limit'];
        }
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
        const response = await axios(requestConfig);

        if (response.data && response.data.Result) {
          const resultsThisPage = response.data.Result.length;
          allResults = allResults.concat(response.data.Result);

          // Enhanced pagination logging
          console.log(`[Pagination] Page ${pageCount}: Fetched ${resultsThisPage} records`);
          console.log(`[Pagination] Total collected so far: ${allResults.length}`);
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
          const fetchedSoFar = allResults.length;
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
          if (resultsThisPage >= params['q.limit']) {
            console.log(`[Pagination] No NextPageUrl, but got full page (${resultsThisPage} results). Continuing with pageNumber pagination.`);
            // Continue to next page - pageNumber will be set at top of next loop iteration
            nextPageUrl = `${config.caspio.apiBaseUrl}${resourcePath}`;
            morePages = true;
          } else {
            console.log(`[Pagination] Got partial page (${resultsThisPage} < ${params['q.limit']}). This was the last page.`);
            morePages = false;
          }
        }

      } catch (pageError) {
        console.error('Axios error details:', {
          status: pageError.response?.status,
          statusText: pageError.response?.statusText,
          data: pageError.response?.data,
          url: currentUrl,
          params: currentRequestParams
        });
        if (pageError.code === 'ECONNABORTED' || pageError.message.includes('timeout')) {
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

    console.log(`Total records fetched: ${allResults.length} from ${pageCount} page(s) for ${resourcePath}`);
    return allResults;

  } catch (error) {
    console.error(`Error fetching all pages from ${resourcePath}:`, error.message);
    if (allResults.length > 0) {
      console.log(`Returning ${allResults.length} partial results collected before error`);
      return allResults;
    }
    throw error;
  }
}

module.exports = {
  getCaspioAccessToken,
  makeCaspioRequest,
  fetchAllCaspioPages
};
