// Configuration for the Caspio Pricing Proxy

require('dotenv').config();

const config = {
  // Server configuration
  port: process.env.PORT || 3002,
  
  // Caspio configuration
  caspio: {
    domain: process.env.CASPIO_ACCOUNT_DOMAIN,
    clientId: process.env.CASPIO_CLIENT_ID,
    clientSecret: process.env.CASPIO_CLIENT_SECRET,
    tokenUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/oauth/token`,
    apiBaseUrl: `https://${process.env.CASPIO_ACCOUNT_DOMAIN}/integrations/rest/v3`
  },
  
  // Request timeouts
  timeouts: {
    perRequest: 10000,  // 10 seconds per request
    totalPagination: 25000  // 25 seconds total for pagination
  },
  
  // Pagination defaults
  pagination: {
    defaultLimit: 1000,
    maxPages: 10
  }
};

// Validate required configuration
if (!config.caspio.domain || !config.caspio.clientId || !config.caspio.clientSecret) {
  console.error("FATAL ERROR: Caspio environment variables (DOMAIN, CLIENT_ID, CLIENT_SECRET) not set.");
  process.exit(1);
}

module.exports = config;