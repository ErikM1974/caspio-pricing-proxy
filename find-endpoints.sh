#!/bin/bash

# Find all pricing-related endpoints in server.js
echo "=== PRICING ENDPOINTS ==="
grep -n "app.get.*pricing\|app.get.*cost\|app.get.*embroidery\|app.get.*dtg\|app.get.*screenprint" server.js | grep -i "api"

echo -e "\n=== INVENTORY ENDPOINTS ==="
grep -n "app.get.*inventory\|app.get.*size" server.js | grep -i "api"

echo -e "\n=== PRODUCT ENDPOINTS ==="
grep -n "app.get.*product\|app.get.*style\|app.get.*brand\|app.get.*categor" server.js | grep -i "api"

echo -e "\n=== ORDER ENDPOINTS ==="
grep -n "app.get.*order\|app.get.*customer\|app.post.*order\|app.put.*order\|app.delete.*order" server.js | grep -i "api"

echo -e "\n=== CART ENDPOINTS ==="
grep -n "app.get.*cart\|app.post.*cart\|app.put.*cart\|app.delete.*cart" server.js | grep -i "api"