/**
 * ManageOrders Tracking PUSH/PULL API - Client Module
 *
 * Handles tracking number push/pull operations with ManageOrders API:
 * - Push tracking numbers to OnSite via ManageOrders
 * - Verify tracking was received
 * - Retrieve tracking data for pushed orders
 *
 * API Endpoints:
 * - POST /onsite/track-push - Send tracking TO ManageOrders
 * - GET /onsite/track-pull - Retrieve tracking data
 */

const axios = require('axios');
const { getToken, MANAGEORDERS_PUSH_BASE_URL } = require('./manageorders-push-auth');

/**
 * Transform tracking data to ManageOrders TrackingJson format
 *
 * @param {Object} trackingData - Tracking data from external system
 * @returns {Object} Transformed tracking in ManageOrders format
 */
function transformTracking(trackingData) {
  if (!trackingData.extOrderId) {
    throw new Error('extOrderId is required');
  }
  if (!trackingData.trackingNumber) {
    throw new Error('trackingNumber is required');
  }

  return {
    ExtOrderID: trackingData.extOrderId,
    ExtShipID: trackingData.extShipId || '',
    TrackingNumber: trackingData.trackingNumber,
    ShippingMethod: trackingData.shippingMethod || '',
    Cost: trackingData.cost || 0,
    Weight: trackingData.weight || 0,
    CustomField01: trackingData.customField01 || '',
    CustomField02: trackingData.customField02 || '',
    CustomField03: trackingData.customField03 || '',
    CustomField04: trackingData.customField04 || '',
    CustomField05: trackingData.customField05 || ''
  };
}

/**
 * Push tracking information to ManageOrders PUSH API
 *
 * @param {Object|Array} trackingData - Single tracking object or array of tracking objects
 * @returns {Promise<Object>} Push result with success status
 * @throws {Error} If push fails
 *
 * @example Single tracking:
 * pushTracking({
 *   extOrderId: 'NWCA-12345',
 *   trackingNumber: '1Z999AA10123456784',
 *   shippingMethod: 'UPS Ground',
 *   cost: 12.95,
 *   weight: 2.5
 * })
 *
 * @example Multiple tracking (array):
 * pushTracking([
 *   { extOrderId: 'NWCA-12345', trackingNumber: '1Z999AA10123456784', ... },
 *   { extOrderId: 'NWCA-12346', trackingNumber: '1Z999AA10123456785', ... }
 * ])
 */
async function pushTracking(trackingData) {
  console.log('[ManageOrders Tracking] Starting tracking push...');

  // Handle single object or array
  const trackingArray = Array.isArray(trackingData) ? trackingData : [trackingData];

  // Validate and transform each tracking record
  const transformedTracking = trackingArray.map((item, index) => {
    try {
      return transformTracking(item);
    } catch (error) {
      throw new Error(`Tracking item ${index + 1}: ${error.message}`);
    }
  });

  console.log(`[ManageOrders Tracking] Pushing ${transformedTracking.length} tracking record(s)...`);

  try {
    // Get authentication token
    const token = await getToken();

    // Push tracking to ManageOrders
    const response = await axios.post(
      `${MANAGEORDERS_PUSH_BASE_URL}/track-push`,
      transformedTracking,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    console.log('[ManageOrders Tracking] Tracking pushed successfully');

    return {
      success: true,
      trackingCount: transformedTracking.length,
      trackingNumbers: transformedTracking.map(t => t.TrackingNumber),
      extOrderIds: transformedTracking.map(t => t.ExtOrderID),
      response: response.data,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    if (error.response) {
      console.error('[ManageOrders Tracking] API error:', error.response.status, error.response.data);
      throw new Error(`ManageOrders API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error('[ManageOrders Tracking] No response from server');
      throw new Error('No response from ManageOrders server. Check network connection.');
    } else {
      console.error('[ManageOrders Tracking] Error:', error.message);
      throw error;
    }
  }
}

/**
 * Pull/retrieve tracking data from ManageOrders by date range
 *
 * @param {Object} options - Query options
 * @param {string} options.dateFrom - Start date (YYYY-MM-DD) - Required
 * @param {string} options.dateTo - End date (YYYY-MM-DD) - Required
 * @param {string} [options.timeFrom] - Start time (HH-MM-SS) - Optional
 * @param {string} [options.timeTo] - End time (HH-MM-SS) - Optional
 * @param {string} [options.apiSource] - Filter by source ("all", "none", or specific) - Optional
 * @returns {Promise<Object>} Tracking data
 *
 * @example
 * pullTracking({
 *   dateFrom: '2025-01-10',
 *   dateTo: '2025-01-11',
 *   apiSource: 'NWCA'
 * })
 */
async function pullTracking(options = {}) {
  const { dateFrom, dateTo, timeFrom, timeTo, apiSource } = options;

  if (!dateFrom || !dateTo) {
    throw new Error('dateFrom and dateTo are required');
  }

  console.log(`[ManageOrders Tracking] Pulling tracking data from ${dateFrom} to ${dateTo}...`);

  try {
    const token = await getToken();

    // Build query parameters
    const params = new URLSearchParams({
      date_from: dateFrom,
      date_to: dateTo
    });

    if (timeFrom) params.append('time_from', timeFrom);
    if (timeTo) params.append('time_to', timeTo);
    if (apiSource) params.append('api_source', apiSource);

    const response = await axios.get(
      `${MANAGEORDERS_PUSH_BASE_URL}/track-pull?${params.toString()}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        timeout: 15000 // 15 second timeout
      }
    );

    const trackingRecords = response.data || [];
    console.log(`[ManageOrders Tracking] Retrieved ${trackingRecords.length} tracking record(s)`);

    return {
      success: true,
      count: trackingRecords.length,
      dateRange: { from: dateFrom, to: dateTo },
      tracking: trackingRecords,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    if (error.response) {
      console.error('[ManageOrders Tracking] API error:', error.response.status, error.response.data);
      throw new Error(`ManageOrders API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error('[ManageOrders Tracking] No response from server');
      throw new Error('No response from ManageOrders server. Check network connection.');
    } else {
      console.error('[ManageOrders Tracking] Error:', error.message);
      throw error;
    }
  }
}

/**
 * Verify tracking was pushed for a specific order (convenience method)
 *
 * @param {string} extOrderId - External order ID to check
 * @param {string} [dateFrom] - Start date (defaults to today)
 * @param {string} [dateTo] - End date (defaults to today)
 * @returns {Promise<Object>} Verification result
 */
async function verifyTracking(extOrderId, dateFrom, dateTo) {
  if (!extOrderId) {
    throw new Error('extOrderId is required');
  }

  // Default to today if dates not provided
  const today = new Date().toISOString().split('T')[0];
  const startDate = dateFrom || today;
  const endDate = dateTo || today;

  console.log(`[ManageOrders Tracking] Verifying tracking for order: ${extOrderId}`);

  try {
    const result = await pullTracking({
      dateFrom: startDate,
      dateTo: endDate,
      apiSource: 'NWCA'
    });

    // Search for matching order
    const matchingTracking = result.tracking.filter(
      t => t.ExtOrderID === extOrderId
    );

    if (matchingTracking.length > 0) {
      console.log(`[ManageOrders Tracking] Found ${matchingTracking.length} tracking record(s) for order`);
      return {
        success: true,
        found: true,
        extOrderId,
        trackingCount: matchingTracking.length,
        tracking: matchingTracking,
        timestamp: new Date().toISOString()
      };
    } else {
      console.log(`[ManageOrders Tracking] No tracking found for order: ${extOrderId}`);
      return {
        success: true,
        found: false,
        extOrderId,
        message: 'No tracking found for this order in the specified date range',
        dateRange: { from: startDate, to: endDate },
        timestamp: new Date().toISOString()
      };
    }

  } catch (error) {
    return {
      success: false,
      found: false,
      extOrderId,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  pushTracking,
  pullTracking,
  verifyTracking,
  transformTracking
};
