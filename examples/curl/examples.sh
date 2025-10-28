#!/bin/bash

# Caspio Pricing Proxy API - cURL Examples
# 
# These examples demonstrate common API operations using cURL commands.
# You can run these directly in your terminal or adapt them for your needs.

# Configuration
API_BASE_URL="https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api"
# For local development:
# API_BASE_URL="http://localhost:3002/api"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Caspio Pricing Proxy API - cURL Examples${NC}"
echo -e "${BLUE}========================================${NC}\n"

# ============================================
# 1. PRODUCT SEARCH EXAMPLES
# ============================================

echo -e "${GREEN}1. PRODUCT SEARCH EXAMPLES${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Simple product search
echo "Simple search for 'polo':"
curl -X GET "${API_BASE_URL}/products/search?q=polo" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Advanced search with filters
echo "Search with multiple filters:"
curl -X GET "${API_BASE_URL}/products/search" \
  -G \
  --data-urlencode "q=shirt" \
  --data-urlencode "category=T-Shirts" \
  --data-urlencode "brand=Port & Company" \
  --data-urlencode "minPrice=10" \
  --data-urlencode "maxPrice=50" \
  --data-urlencode "includeFacets=true" \
  --data-urlencode "limit=5" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Search with array parameters (multiple categories)
echo "Search with multiple categories:"
curl -X GET "${API_BASE_URL}/products/search" \
  -G \
  --data-urlencode "category[]=T-Shirts" \
  --data-urlencode "category[]=Polos" \
  --data-urlencode "sort=price_asc" \
  --data-urlencode "limit=10" \
  -H "Accept: application/json" | jq '.products[] | {style, title, minPrice}'

echo -e "\n"

# ============================================
# 2. CART SESSION MANAGEMENT
# ============================================

echo -e "${GREEN}2. CART SESSION MANAGEMENT${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Create cart session
echo "Creating cart session:"
SESSION_ID="session_$(date +%s)_$RANDOM"
curl -X POST "${API_BASE_URL}/cart-sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "SessionID": "'${SESSION_ID}'",
    "UserID": null,
    "IsActive": true
  }' | jq '.'

echo -e "\n"

# Add item to cart
echo "Adding item to cart:"
curl -X POST "${API_BASE_URL}/cart-items" \
  -H "Content-Type: application/json" \
  -d '{
    "SessionID": "'${SESSION_ID}'",
    "ProductID": "123",
    "StyleNumber": "PC61",
    "Color": "Navy",
    "PRODUCT_TITLE": "Essential Tee",
    "CartStatus": "Active"
  }' | jq '.'

echo -e "\n"

# Add item sizes
echo "Adding item sizes:"
# Assuming cart item ID is 1 (replace with actual ID from previous response)
curl -X POST "${API_BASE_URL}/cart-item-sizes" \
  -H "Content-Type: application/json" \
  -d '{
    "CartItemID": 1,
    "Size": "M",
    "Quantity": 5,
    "UnitPrice": 12.99
  }' | jq '.'

echo -e "\n"

# Get cart items
echo "Getting cart items for session:"
curl -X GET "${API_BASE_URL}/cart-items?sessionID=${SESSION_ID}" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# ============================================
# 3. ORDER DASHBOARD QUERIES
# ============================================

echo -e "${GREEN}3. ORDER DASHBOARD QUERIES${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Get 7-day dashboard metrics
echo "7-day order dashboard:"
curl -X GET "${API_BASE_URL}/order-dashboard?days=7" \
  -H "Accept: application/json" | jq '.summary'

echo -e "\n"

# Get 30-day dashboard with details
echo "30-day dashboard with details:"
curl -X GET "${API_BASE_URL}/order-dashboard" \
  -G \
  --data-urlencode "days=30" \
  --data-urlencode "includeDetails=true" \
  --data-urlencode "compareYoY=false" \
  -H "Accept: application/json" | jq '{
    totalOrders: .summary.totalOrders,
    totalSales: .summary.totalSales,
    avgOrderValue: .summary.avgOrderValue,
    recentOrdersCount: (.recentOrders | length)
  }'

echo -e "\n"

# Get dashboard with year-over-year comparison
echo "Dashboard with YoY comparison:"
curl -X GET "${API_BASE_URL}/order-dashboard?days=7&compareYoY=true" \
  -H "Accept: application/json" | jq '.yoyComparison'

echo -e "\n"

# Get unshipped orders
echo "Unshipped orders (ODBC):"
curl -X GET "${API_BASE_URL}/order-odbc" \
  -G \
  --data-urlencode "q.where=sts_Invoiced=1 AND sts_Shipped=0" \
  --data-urlencode "q.orderBy=date_OrderPlaced DESC" \
  --data-urlencode "q.limit=5" \
  -H "Accept: application/json" | jq '.[] | {
    ID_Order,
    CompanyName,
    date_OrderPlaced,
    CustomerServiceRep,
    cur_Subtotal
  }'

echo -e "\n"

# ============================================
# 4. PRICING CALCULATIONS
# ============================================

echo -e "${GREEN}4. PRICING CALCULATIONS${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Get pricing tiers for DTG
echo "DTG pricing tiers:"
curl -X GET "${API_BASE_URL}/pricing-tiers?method=DTG" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Get base item costs
echo "Base item costs for PC61:"
curl -X GET "${API_BASE_URL}/base-item-costs?styleNumber=PC61" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Get embroidery cost
echo "Embroidery cost (5000 stitches):"
curl -X GET "${API_BASE_URL}/embroidery-costs" \
  -G \
  --data-urlencode "itemType=Shirt" \
  --data-urlencode "stitchCount=5000" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Get size pricing
echo "Size pricing for PC61 in Ash:"
curl -X GET "${API_BASE_URL}/size-pricing" \
  -G \
  --data-urlencode "styleNumber=PC61" \
  --data-urlencode "color=Ash" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# ============================================
# 5. PRODUCT DETAILS AND INVENTORY
# ============================================

echo -e "${GREEN}5. PRODUCT DETAILS AND INVENTORY${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Get product details
echo "Product details for PC61 in Navy:"
curl -X GET "${API_BASE_URL}/product-details" \
  -G \
  --data-urlencode "styleNumber=PC61" \
  --data-urlencode "color=Navy" \
  -H "Accept: application/json" | jq '{
    style: .STYLE,
    title: .PRODUCT_TITLE,
    brand: .BRAND,
    color: .COLOR_NAME,
    description: .PRODUCT_DESCRIPTION | .[0:100]
  }'

echo -e "\n"

# Get inventory levels
echo "Inventory for PC61 in Navy:"
curl -X GET "${API_BASE_URL}/inventory" \
  -G \
  --data-urlencode "styleNumber=PC61" \
  --data-urlencode "color=Navy" \
  -H "Accept: application/json" | jq '.[] | {
    size: .SIZE,
    available: .QTY_AVAILABLE,
    onHand: .QTY_ON_HAND
  }'

echo -e "\n"

# Get available sizes
echo "Available sizes for PC61 in Navy:"
curl -X GET "${API_BASE_URL}/sizes-by-style-color" \
  -G \
  --data-urlencode "styleNumber=PC61" \
  --data-urlencode "color=Navy" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Get color swatches
echo "Color swatches for PC61:"
curl -X GET "${API_BASE_URL}/color-swatches?styleNumber=PC61" \
  -H "Accept: application/json" | jq '.[] | {
    color: .COLOR_NAME,
    catalog: .CATALOG_COLOR,
    swatch: .COLOR_SWATCH
  }' | head -20

echo -e "\n"

# ============================================
# 6. ART REQUESTS MANAGEMENT
# ============================================

echo -e "${GREEN}6. ART REQUESTS MANAGEMENT${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Get art requests
echo "Get in-progress art requests:"
curl -X GET "${API_BASE_URL}/artrequests" \
  -G \
  --data-urlencode "status=In Progress" \
  --data-urlencode "limit=3" \
  -H "Accept: application/json" | jq '.[] | {
    id: .PK_ID,
    company: .CompanyName,
    status: .Status,
    csr: .CustomerServiceRep,
    priority: .Priority
  }'

echo -e "\n"

# Create art request
echo "Create new art request:"
curl -X POST "${API_BASE_URL}/artrequests" \
  -H "Content-Type: application/json" \
  -d '{
    "CompanyName": "Test Company",
    "Status": "In Progress",
    "CustomerServiceRep": "John Doe",
    "Priority": "High",
    "Mockup": true,
    "GarmentStyle": "PC61",
    "GarmentColor": "Navy",
    "NOTES": "Rush order - need by Friday"
  }' | jq '{
    id: .PK_ID,
    company: .CompanyName,
    status: .Status
  }'

echo -e "\n"

# Update art request (replace ID with actual ID)
echo "Update art request status:"
curl -X PUT "${API_BASE_URL}/artrequests/1279" \
  -H "Content-Type: application/json" \
  -d '{
    "Status": "Completed",
    "Invoiced": true,
    "Invoiced_Date": "'$(date -Iseconds)'"
  }' | jq '{
    id: .PK_ID,
    status: .Status,
    invoiced: .Invoiced
  }'

echo -e "\n"

# ============================================
# 7. PRODUCTION SCHEDULES
# ============================================

echo -e "${GREEN}7. PRODUCTION SCHEDULES${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Get latest production schedules
echo "Latest production schedules:"
curl -X GET "${API_BASE_URL}/production-schedules" \
  -G \
  --data-urlencode "q.orderBy=Date DESC" \
  --data-urlencode "q.limit=2" \
  -H "Accept: application/json" | jq '.[] | {
    date: .Date,
    employee: .Employee,
    dtg: .DTG,
    embroidery: .Embroidery,
    screenprint: .Screenprint
  }'

echo -e "\n"

# Get schedules after specific date
echo "Schedules after August 20, 2021:"
curl -X GET "${API_BASE_URL}/production-schedules" \
  -G \
  --data-urlencode "q.where=Date>'2021-08-20'" \
  --data-urlencode "q.orderBy=Date ASC" \
  --data-urlencode "q.limit=3" \
  -H "Accept: application/json" | jq '.[] | {
    date: .Date,
    dtg: .DTG,
    dtg_comment: .Comment_DTG
  }'

echo -e "\n"

# ============================================
# 8. TRANSFER PRICING
# ============================================

echo -e "${GREEN}8. TRANSFER PRICING${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Get transfer price lookup
echo "Transfer price for Adult, 10 quantity, Regular price:"
curl -X GET "${API_BASE_URL}/transfers/lookup" \
  -G \
  --data-urlencode "size=Adult" \
  --data-urlencode "quantity=10" \
  --data-urlencode "price_type=Regular" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Get transfer pricing matrix
echo "Transfer pricing matrix for Adult size:"
curl -X GET "${API_BASE_URL}/transfers/matrix?size=Adult" \
  -H "Accept: application/json" | jq '.[] | {
    quantity_range: .quantity_range,
    price: .price
  }' | head -10

echo -e "\n"

# Get available transfer sizes
echo "Available transfer sizes:"
curl -X GET "${API_BASE_URL}/transfers/sizes" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# ============================================
# 9. UTILITY ENDPOINTS
# ============================================

echo -e "${GREEN}9. UTILITY ENDPOINTS${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

# Health check
echo "API health check:"
curl -X GET "${API_BASE_URL}/health" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# Get staff announcements
echo "Staff announcements:"
curl -X GET "${API_BASE_URL}/staff-announcements" \
  -H "Accept: application/json" | jq '.[] | {
    title: .Title,
    type: .Type,
    priority: .Priority,
    content: (.Content | .[0:100])
  }'

echo -e "\n"

# Get all brands
echo "Available brands (first 10):"
curl -X GET "${API_BASE_URL}/all-brands" \
  -H "Accept: application/json" | jq '.[:10]'

echo -e "\n"

# Get all categories
echo "Available categories:"
curl -X GET "${API_BASE_URL}/all-categories" \
  -H "Accept: application/json" | jq '.'

echo -e "\n"

# ============================================
# 10. COMPLETE WORKFLOW EXAMPLE
# ============================================

echo -e "${GREEN}10. COMPLETE WORKFLOW EXAMPLE${NC}"
echo -e "${YELLOW}----------------------------${NC}\n"

complete_workflow() {
  echo "Starting complete workflow..."
  
  # 1. Search for products
  echo -e "\n1. Searching for products..."
  PRODUCTS=$(curl -s -X GET "${API_BASE_URL}/products/search?q=polo&limit=1" \
    -H "Accept: application/json")
  
  STYLE=$(echo $PRODUCTS | jq -r '.products[0].style')
  COLOR=$(echo $PRODUCTS | jq -r '.products[0].colors[0]')
  TITLE=$(echo $PRODUCTS | jq -r '.products[0].title')
  
  echo "Found product: $TITLE (Style: $STYLE, Color: $COLOR)"
  
  # 2. Get product details
  echo -e "\n2. Getting product details..."
  DETAILS=$(curl -s -X GET "${API_BASE_URL}/product-details?styleNumber=${STYLE}&color=${COLOR}" \
    -H "Accept: application/json")
  echo "Product brand: $(echo $DETAILS | jq -r '.BRAND')"
  
  # 3. Check inventory
  echo -e "\n3. Checking inventory..."
  INVENTORY=$(curl -s -X GET "${API_BASE_URL}/inventory?styleNumber=${STYLE}&color=${COLOR}" \
    -H "Accept: application/json")
  echo "Available sizes: $(echo $INVENTORY | jq -r '.[].SIZE' | tr '\n' ' ')"
  
  # 4. Get pricing
  echo -e "\n4. Getting pricing..."
  PRICING=$(curl -s -X GET "${API_BASE_URL}/base-item-costs?styleNumber=${STYLE}" \
    -H "Accept: application/json")
  echo "Base costs: $(echo $PRICING | jq -c '.')"
  
  # 5. Create cart session
  echo -e "\n5. Creating cart session..."
  SESSION_ID="workflow_$(date +%s)_$RANDOM"
  SESSION=$(curl -s -X POST "${API_BASE_URL}/cart-sessions" \
    -H "Content-Type: application/json" \
    -d "{\"SessionID\": \"${SESSION_ID}\", \"IsActive\": true}")
  echo "Session created: $SESSION_ID"
  
  # 6. Add to cart
  echo -e "\n6. Adding item to cart..."
  CART_ITEM=$(curl -s -X POST "${API_BASE_URL}/cart-items" \
    -H "Content-Type: application/json" \
    -d "{
      \"SessionID\": \"${SESSION_ID}\",
      \"ProductID\": \"1\",
      \"StyleNumber\": \"${STYLE}\",
      \"Color\": \"${COLOR}\",
      \"PRODUCT_TITLE\": \"${TITLE}\",
      \"CartStatus\": \"Active\"
    }")
  echo "Item added to cart"
  
  # 7. Check production schedule
  echo -e "\n7. Checking production schedules..."
  SCHEDULES=$(curl -s -X GET "${API_BASE_URL}/production-schedules?q.limit=1&q.orderBy=Date%20DESC" \
    -H "Accept: application/json")
  echo "Latest DTG availability: $(echo $SCHEDULES | jq -r '.[0].DTG')"
  
  # 8. Get dashboard metrics
  echo -e "\n8. Getting order dashboard..."
  DASHBOARD=$(curl -s -X GET "${API_BASE_URL}/order-dashboard?days=7" \
    -H "Accept: application/json")
  echo "Weekly orders: $(echo $DASHBOARD | jq -r '.summary.totalOrders')"
  echo "Weekly sales: $$(echo $DASHBOARD | jq -r '.summary.totalSales')"
  
  echo -e "\n${GREEN}Workflow complete!${NC}"
}

# Run the complete workflow
complete_workflow

# ============================================
# 9. NEW PRODUCTS MANAGEMENT EXAMPLES
# ============================================

echo -e "\n${GREEN}9. NEW PRODUCTS MANAGEMENT EXAMPLES${NC}"
echo -e "${YELLOW}-----------------------------------${NC}\n"

# 9a. Add IsNew field (one-time setup, idempotent)
echo -e "${YELLOW}9a. Add IsNew field (one-time setup)${NC}"
curl -X POST "${API_BASE_URL}/admin/products/add-isnew-field" \
  -H "Content-Type: application/json" \
  -w "\nStatus: %{http_code}\n" \
  -s | jq .

echo -e "\n${YELLOW}Press Enter to continue...${NC}"
read

# 9b. Mark products as new (batch update)
echo -e "${YELLOW}9b. Mark products as new (batch update)${NC}"
echo "Marking 15 featured products as new..."
curl -X POST "${API_BASE_URL}/admin/products/mark-as-new" \
  -H "Content-Type: application/json" \
  -d '{
    "styles": [
      "EB120",
      "EB121",
      "EB122",
      "EB123",
      "EB124",
      "EB125",
      "EB130",
      "EB131",
      "OG734",
      "OG735",
      "PC54",
      "PC55",
      "LPC54",
      "ST350",
      "LST350"
    ]
  }' \
  -w "\nStatus: %{http_code}\n" \
  -s | jq .

echo -e "\n${YELLOW}Press Enter to continue...${NC}"
read

# 9c. Query new products (public endpoint)
echo -e "${YELLOW}9c. Query new products (default - 20 products)${NC}"
curl -s "${API_BASE_URL}/products/new" | jq '.count, .cached'

echo -e "\n${YELLOW}Press Enter to continue...${NC}"
read

# 9d. Query new products with limit
echo -e "${YELLOW}9d. Query new products with limit=5${NC}"
curl -s "${API_BASE_URL}/products/new?limit=5" | jq '{count: .count, cached: .cached, firstProduct: .products[0].STYLE}'

echo -e "\n${YELLOW}Press Enter to continue...${NC}"
read

# 9e. Query new products by category
echo -e "${YELLOW}9e. Query new products by category (Sweatshirts/Fleece)${NC}"
curl -s "${API_BASE_URL}/products/new?category=Sweatshirts%2FFleece&limit=3" | jq '{count: .count, products: [.products[].PRODUCT_TITLE]}'

echo -e "\n${YELLOW}Press Enter to continue...${NC}"
read

# 9f. Query new products by brand
echo -e "${YELLOW}9f. Query new products by brand (Eddie Bauer)${NC}"
curl -s "${API_BASE_URL}/products/new?brand=Eddie%20Bauer&limit=5" | jq '{count: .count, products: [.products[] | {style: .STYLE, title: .PRODUCT_TITLE, brand: .BRAND_NAME}]}'

echo -e "\n${YELLOW}Press Enter to continue...${NC}"
read

# 9g. Test caching behavior
echo -e "${YELLOW}9g. Test caching (first request - cache miss)${NC}"
curl -s "${API_BASE_URL}/products/new?limit=3" | jq '{count: .count, cached: .cached}'

echo -e "\n${YELLOW}Wait 2 seconds and query again (cache hit expected)...${NC}"
sleep 2
curl -s "${API_BASE_URL}/products/new?limit=3" | jq '{count: .count, cached: .cached}'

echo -e "\n${GREEN}New Products Management examples completed!${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Quick Reference:${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Public Endpoint:"
echo -e "  GET ${API_BASE_URL}/products/new?limit=10"
echo -e "\nAdmin Endpoints:"
echo -e "  POST ${API_BASE_URL}/admin/products/add-isnew-field"
echo -e "  POST ${API_BASE_URL}/admin/products/mark-as-new"
echo -e "\nDocumentation:"
echo -e "  memory/NEW_PRODUCTS_API.md"
echo -e "${BLUE}========================================${NC}"

echo -e "\n${BLUE}========================================${NC}"
echo -e "${BLUE}All examples completed successfully!${NC}"
echo -e "${BLUE}========================================${NC}"