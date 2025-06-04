#!/bin/bash

echo "Fetching recent Heroku logs for quote_items errors..."
echo "=================================================="
echo ""

# Fetch the last 100 lines of logs and filter for quote_items related errors
heroku logs --tail -n 100 -a caspio-pricing-proxy | grep -E "(quote_items|Quote_Items|POST /api/quote_items|Error creating quote item)" -A 2 -B 2

echo ""
echo "To see live logs, run: heroku logs --tail -a caspio-pricing-proxy"