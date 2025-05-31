// test-server-endpoints.js - Simple test to check if the server is responding to requests
const express = require('express');
const app = express();
const PORT = 3002; // Use a different port to avoid conflicts with the main server

// Simple test endpoint
app.get('/test', (req, res) => {
  res.json({ message: 'Test endpoint is working!' });
});

// Quote Analytics test endpoint
app.get('/api/quote_analytics', (req, res) => {
  res.json({ message: 'Quote Analytics endpoint is working!' });
});

app.listen(PORT, () => {
  console.log(`Test server listening on port ${PORT}`);
});