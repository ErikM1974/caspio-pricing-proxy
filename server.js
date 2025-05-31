// server.js - Caspio API Proxy Server (Refactored)

const express = require('express');
const config = require('./src/config');
const { applyMiddleware, errorHandler } = require('./src/middleware');
const {
  pricingRoutes,
  productsRoutes,
  cartRoutes,
  ordersRoutes,
  inventoryRoutes,
  pricingMatrixRoutes,
  quotesRoutes,
  miscRoutes
} = require('./src/routes');

const app = express();

// Apply middleware
applyMiddleware(app);

// Mount routes
app.use('/api', pricingRoutes);
app.use('/api', productsRoutes);
app.use('/api', cartRoutes);
app.use('/api', ordersRoutes);
app.use('/api', inventoryRoutes);
app.use('/api', pricingMatrixRoutes);
app.use('/api', quotesRoutes);
app.use('/api', miscRoutes);

// Mount misc routes directly on root for status and test endpoints
app.use('/', miscRoutes);

// Error handling middleware (should be last)
app.use(errorHandler);

// Start the server
app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
  console.log(`Caspio domain: ${config.caspio.domain}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});