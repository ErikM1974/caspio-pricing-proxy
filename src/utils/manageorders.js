// ManageOrders API utilities

const axios = require('axios');
const config = require('../../config');

// Token cache
let manageOrdersToken = null;
let tokenExpiryTime = 0;

/**
 * Authenticates with ManageOrders API and returns auth tokens.
 * Caches the token for 1 hour to prevent excessive authentication requests.
 * @returns {Promise<string>} - The id_token for API requests
 */
async function authenticateManageOrders() {
  const now = Date.now();

  // Return cached token if still valid
  if (manageOrdersToken && now < tokenExpiryTime) {
    console.log("Using cached ManageOrders token");
    return manageOrdersToken;
  }

  console.log("Authenticating with ManageOrders API...");

  try {
    const response = await axios.post(
      `${config.manageOrders.baseUrl}/manageorders/signin`,
      {
        username: config.manageOrders.username,
        password: config.manageOrders.password
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    if (response.data && response.data.id_token) {
      manageOrdersToken = response.data.id_token;
      tokenExpiryTime = now + config.manageOrders.tokenCacheDuration;
      console.log("ManageOrders token obtained. Expires at:", new Date(tokenExpiryTime).toLocaleTimeString());
      return manageOrdersToken;
    } else {
      throw new Error("Invalid response structure from ManageOrders signin endpoint");
    }
  } catch (error) {
    console.error("Error authenticating with ManageOrders:", error.message);
    // Clear invalid token
    manageOrdersToken = null;
    tokenExpiryTime = 0;

    // Never expose credentials in error messages
    if (error.response) {
      throw new Error(`ManageOrders authentication failed: ${error.response.status}`);
    }
    throw new Error("Could not authenticate with ManageOrders API");
  }
}

/**
 * Fetches orders from ManageOrders API within a date range.
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {Promise<Array>} - Array of order objects
 */
async function fetchOrders(startDate, endDate) {
  console.log(`Fetching ManageOrders orders from ${startDate} to ${endDate}...`);

  try {
    const token = await authenticateManageOrders();

    const response = await axios.get(
      `${config.manageOrders.baseUrl}/manageorders/orders`,
      {
        params: {
          date_Ordered_start: startDate,
          date_Ordered_end: endDate
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 seconds for potentially large result sets
      }
    );

    if (response.data && response.data.result) {
      console.log(`Fetched ${response.data.result.length} orders from ManageOrders`);
      return response.data.result;
    } else {
      console.warn("ManageOrders API response did not contain 'result':", response.data);
      return [];
    }
  } catch (error) {
    console.error("Error fetching orders from ManageOrders:", error.message);

    // Never expose credentials in error messages
    if (error.response) {
      throw new Error(`Failed to fetch ManageOrders orders: ${error.response.status}`);
    }
    throw new Error("Could not fetch orders from ManageOrders API");
  }
}

/**
 * Cleans phone numbers by removing common prefixes like "W " and "C".
 * @param {string} phone - Raw phone number
 * @returns {string} - Cleaned phone number
 */
function cleanPhoneNumber(phone) {
  if (!phone) return '';

  let cleaned = phone.trim();

  // Remove "W " prefix (work phone)
  if (cleaned.startsWith('W ')) {
    cleaned = cleaned.substring(2).trim();
  }

  // Remove "C" prefix (cell phone)
  if (cleaned.startsWith('C ')) {
    cleaned = cleaned.substring(2).trim();
  }

  return cleaned;
}

/**
 * Extracts unique customers from orders array.
 * Deduplicates by id_Customer and keeps the most recent order data.
 * @param {Array} orders - Array of order objects
 * @returns {Array} - Array of unique customer objects
 */
function deduplicateCustomers(orders) {
  console.log(`Deduplicating customers from ${orders.length} orders...`);

  const customerMap = new Map();

  for (const order of orders) {
    const customerId = order.id_Customer;

    if (!customerId) continue; // Skip orders without customer ID

    // Extract customer data from order
    const customerData = {
      id_Customer: customerId,
      CustomerName: order.CustomerName || '',
      ContactFirstName: order.ContactFirstName || '',
      ContactLastName: order.ContactLastName || '',
      ContactEmail: order.ContactEmail || '',
      ContactPhone: cleanPhoneNumber(order.ContactPhone || ''),
      ContactDepartment: order.ContactDepartment || '',
      CustomerServiceRep: order.CustomerServiceRep || '',
      lastOrderDate: order.date_Ordered || ''
    };

    // Keep the customer with the most recent order date
    const existing = customerMap.get(customerId);
    if (!existing || order.date_Ordered > existing.lastOrderDate) {
      customerMap.set(customerId, customerData);
    }
  }

  const uniqueCustomers = Array.from(customerMap.values());
  console.log(`Deduplicated to ${uniqueCustomers.length} unique customers`);

  // Sort by customer name for easier browsing
  uniqueCustomers.sort((a, b) =>
    (a.CustomerName || '').localeCompare(b.CustomerName || '')
  );

  return uniqueCustomers;
}

/**
 * Gets the date N days ago in YYYY-MM-DD format.
 * @param {number} daysAgo - Number of days to go back
 * @returns {string} - Date in YYYY-MM-DD format
 */
function getDateDaysAgo(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
}

/**
 * Gets today's date in YYYY-MM-DD format.
 * @returns {string} - Today's date in YYYY-MM-DD format
 */
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

module.exports = {
  authenticateManageOrders,
  fetchOrders,
  deduplicateCustomers,
  cleanPhoneNumber,
  getDateDaysAgo,
  getTodayDate
};
