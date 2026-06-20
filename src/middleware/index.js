// Middleware for the Caspio Pricing Proxy

const express = require('express');
const { isOriginAllowed } = require('../utils/cors-allowlist');

// CORS Middleware — uses the shared allowlist (see src/utils/cors-allowlist.js).
// NOTE: server.js applies its own inline CORS middleware on the live path; this
// exported one is kept consistent so it can never re-introduce a wide-open '*'.
const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-crm-api-secret');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
};

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
};

// CRM API Secret authentication middleware
// Protects sensitive CRM endpoints - only allows requests from authorized servers
const requireCrmApiSecret = (req, res, next) => {
  const providedSecret = req.headers['x-crm-api-secret'];
  const expectedSecret = process.env.CRM_API_SECRET;

  if (!expectedSecret) {
    console.error('[CRM Auth] CRM_API_SECRET environment variable not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!providedSecret || providedSecret !== expectedSecret) {
    console.warn('[CRM Auth] Unauthorized access attempt to CRM endpoint:', req.originalUrl);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// Apply all middleware to an Express app
const applyMiddleware = (app) => {
  app.use(express.json()); // Parse JSON bodies
  app.use(express.static('.')); // Serve static files from the current directory
  app.use(corsMiddleware);
};

module.exports = {
  corsMiddleware,
  errorHandler,
  applyMiddleware,
  requireCrmApiSecret
};