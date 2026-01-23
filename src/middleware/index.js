// Middleware for the Caspio Pricing Proxy

const express = require('express');

// CORS Middleware - Allow requests from all origins for testing
const corsMiddleware = (req, res, next) => {
  // Allow requests from any origin for testing purposes
  // In production, this should be restricted to specific domains
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
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