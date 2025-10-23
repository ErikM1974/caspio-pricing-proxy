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
    perRequest: 20000,      // 20 seconds per request (increased for large queries)
    totalPagination: 90000, // 90 seconds total for pagination (allows 4-5 pages)
    tokenBuffer: 60         // 60 seconds buffer for token refresh
  },
  
  // Pagination defaults
  pagination: {
    defaultLimit: 1000,
    maxPages: 20  // Increased to handle brands with many products (e.g., Port & Company has 114 styles)
  },

  // CORS settings
  cors: {
    origin: '*', // Allow all origins for testing (restrict in production)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  },

  // Logging
  logging: {
    enabled: true,
    level: process.env.LOG_LEVEL || 'info'
  }
};

// Validate required configuration
if (!config.caspio.domain || !config.caspio.clientId || !config.caspio.clientSecret) {
  console.error("FATAL ERROR: Caspio environment variables (DOMAIN, CLIENT_ID, CLIENT_SECRET) not set.");
  process.exit(1);
}

module.exports = config;