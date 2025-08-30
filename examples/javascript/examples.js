/**
 * Caspio Pricing Proxy API - JavaScript/Node.js Examples
 * 
 * These examples demonstrate common API operations using both
 * the native fetch API and the popular axios library.
 */

// Configuration
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api';
// For local development:
// const API_BASE_URL = 'http://localhost:3002/api';

// ============================================
// 1. PRODUCT SEARCH WITH FILTERS
// ============================================

// Using Fetch API
async function searchProducts(query, filters = {}) {
  const params = new URLSearchParams({
    q: query,
    ...filters
  });

  try {
    const response = await fetch(`${API_BASE_URL}/products/search?${params}`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Product search failed:', error);
    throw error;
  }
}

// Using Axios
const axios = require('axios');

async function searchProductsAxios(query, filters = {}) {
  try {
    const response = await axios.get(`${API_BASE_URL}/products/search`, {
      params: {
        q: query,
        ...filters
      }
    });
    return response.data;
  } catch (error) {
    console.error('Product search failed:', error.response?.data || error.message);
    throw error;
  }
}

// Example usage:
async function productSearchExample() {
  // Simple search
  const results1 = await searchProducts('polo');
  console.log(`Found ${results1.products.length} polo products`);

  // Advanced search with filters
  const results2 = await searchProducts('shirt', {
    category: 'T-Shirts',
    brand: 'Port & Company',
    minPrice: 10,
    maxPrice: 50,
    includeFacets: true
  });
  console.log('Filtered results:', results2);

  // Search with multiple categories
  const results3 = await searchProductsAxios('', {
    category: ['T-Shirts', 'Polos'],
    sort: 'price_asc',
    limit: 10
  });
  console.log('Multi-category results:', results3);
}

// ============================================
// 2. CART SESSION MANAGEMENT
// ============================================

class CartManager {
  constructor(baseUrl = API_BASE_URL) {
    this.baseUrl = baseUrl;
    this.sessionId = null;
  }

  // Create a new cart session
  async createSession(userId = null) {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const response = await fetch(`${this.baseUrl}/cart-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SessionID: sessionId,
        UserID: userId,
        IsActive: true
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create cart session: ${response.statusText}`);
    }

    const session = await response.json();
    this.sessionId = session.SessionID;
    return session;
  }

  // Add item to cart
  async addItem(productId, styleNumber, color, title) {
    if (!this.sessionId) {
      await this.createSession();
    }

    const response = await fetch(`${this.baseUrl}/cart-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SessionID: this.sessionId,
        ProductID: productId,
        StyleNumber: styleNumber,
        Color: color,
        PRODUCT_TITLE: title,
        CartStatus: 'Active'
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to add cart item: ${response.statusText}`);
    }

    return await response.json();
  }

  // Add size and quantity for a cart item
  async addItemSize(cartItemId, size, quantity, unitPrice = null) {
    const response = await fetch(`${this.baseUrl}/cart-item-sizes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CartItemID: cartItemId,
        Size: size,
        Quantity: quantity,
        UnitPrice: unitPrice
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to add item size: ${response.statusText}`);
    }

    return await response.json();
  }

  // Get cart items for current session
  async getCartItems() {
    if (!this.sessionId) {
      return [];
    }

    const response = await fetch(`${this.baseUrl}/cart-items?sessionID=${this.sessionId}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get cart items: ${response.statusText}`);
    }

    return await response.json();
  }

  // Complete cart workflow example
  async completeCartExample() {
    // Create session
    const session = await this.createSession();
    console.log('Created cart session:', session.SessionID);

    // Add a product
    const cartItem = await this.addItem('123', 'PC61', 'Navy', 'Essential Tee');
    console.log('Added item to cart:', cartItem);

    // Add sizes
    await this.addItemSize(cartItem.PK_ID, 'M', 5, 12.99);
    await this.addItemSize(cartItem.PK_ID, 'L', 3, 12.99);
    await this.addItemSize(cartItem.PK_ID, 'XL', 2, 13.99);

    // Get all cart items
    const items = await this.getCartItems();
    console.log('Cart contains', items.length, 'items');

    return { session, items };
  }
}

// ============================================
// 3. ORDER DASHBOARD QUERIES
// ============================================

class OrderDashboard {
  constructor(baseUrl = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  // Get dashboard metrics
  async getMetrics(days = 7, includeDetails = false, compareYoY = false) {
    const params = new URLSearchParams({
      days,
      includeDetails,
      compareYoY
    });

    const response = await fetch(`${this.baseUrl}/order-dashboard?${params}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get dashboard metrics: ${response.statusText}`);
    }

    return await response.json();
  }

  // Get order ODBC records with filtering
  async getOrderRecords(filters = {}) {
    const params = new URLSearchParams();
    
    if (filters.where) params.append('q.where', filters.where);
    if (filters.orderBy) params.append('q.orderBy', filters.orderBy);
    if (filters.limit) params.append('q.limit', filters.limit);

    const response = await fetch(`${this.baseUrl}/order-odbc?${params}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get order records: ${response.statusText}`);
    }

    return await response.json();
  }

  // Dashboard examples
  async dashboardExamples() {
    // Get 7-day summary
    const weekSummary = await this.getMetrics(7);
    console.log('Weekly Summary:', weekSummary.summary);
    console.log('Today\'s Stats:', weekSummary.todayStats);

    // Get 30-day summary with details and YoY comparison
    const monthSummary = await this.getMetrics(30, true, true);
    console.log('Monthly orders:', monthSummary.summary.totalOrders);
    console.log('YoY Growth:', monthSummary.yoyComparison?.salesGrowthPercent + '%');
    console.log('Recent orders:', monthSummary.recentOrders?.length);

    // Get unshipped orders
    const unshippedOrders = await this.getOrderRecords({
      where: 'sts_Invoiced=1 AND sts_Shipped=0',
      orderBy: 'date_OrderPlaced DESC',
      limit: 50
    });
    console.log('Unshipped orders:', unshippedOrders.length);

    // Get orders for specific customer
    const customerOrders = await this.getOrderRecords({
      where: 'id_Customer=11824',
      orderBy: 'date_OrderPlaced DESC'
    });
    console.log('Customer orders:', customerOrders.length);

    return { weekSummary, monthSummary, unshippedOrders };
  }
}

// ============================================
// 4. PRICING CALCULATIONS
// ============================================

class PricingCalculator {
  constructor(baseUrl = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  // Get pricing tiers for decoration method
  async getPricingTiers(method) {
    const response = await fetch(`${this.baseUrl}/pricing-tiers?method=${method}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get pricing tiers: ${response.statusText}`);
    }

    return await response.json();
  }

  // Get base item costs
  async getBaseItemCosts(styleNumber) {
    const response = await fetch(`${this.baseUrl}/base-item-costs?styleNumber=${styleNumber}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get base costs: ${response.statusText}`);
    }

    return await response.json();
  }

  // Get embroidery cost
  async getEmbroideryCost(itemType, stitchCount) {
    const params = new URLSearchParams({
      itemType,
      stitchCount
    });

    const response = await fetch(`${this.baseUrl}/embroidery-costs?${params}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get embroidery cost: ${response.statusText}`);
    }

    return await response.json();
  }

  // Calculate total price for an order
  async calculateOrderPrice(styleNumber, decorationType, quantity, stitchCount = null) {
    // Get base item costs
    const baseCosts = await this.getBaseItemCosts(styleNumber);
    console.log('Base costs per size:', baseCosts);

    // Get decoration pricing tiers
    const pricingTiers = await this.getPricingTiers(decorationType);
    
    // Find applicable tier for quantity
    const applicableTier = pricingTiers.find(tier => 
      quantity >= tier.minQuantity && quantity <= tier.maxQuantity
    );
    
    console.log('Applicable pricing tier:', applicableTier);

    // Calculate embroidery cost if applicable
    let decorationCost = applicableTier ? applicableTier.price : 0;
    
    if (decorationType === 'Embroidery' && stitchCount) {
      const embroideryResult = await this.getEmbroideryCost('Shirt', stitchCount);
      decorationCost = embroideryResult.cost;
      console.log('Embroidery cost:', decorationCost);
    }

    // Example calculation (simplified)
    const avgBaseCost = Object.values(baseCosts).reduce((a, b) => a + b, 0) / Object.values(baseCosts).length;
    const totalCost = (avgBaseCost + decorationCost) * quantity;

    return {
      baseCostPerItem: avgBaseCost,
      decorationCostPerItem: decorationCost,
      quantity: quantity,
      totalCost: totalCost
    };
  }

  // Pricing example
  async pricingExample() {
    // DTG pricing for 50 shirts
    const dtgPrice = await this.calculateOrderPrice('PC61', 'DTG', 50);
    console.log('DTG Order (50 units):', dtgPrice);

    // Screen print pricing for 100 shirts
    const screenPrintPrice = await this.calculateOrderPrice('PC61', 'ScreenPrint', 100);
    console.log('Screen Print Order (100 units):', screenPrintPrice);

    // Embroidery pricing for 25 shirts with 5000 stitches
    const embroideryPrice = await this.calculateOrderPrice('PC61', 'Embroidery', 25, 5000);
    console.log('Embroidery Order (25 units, 5000 stitches):', embroideryPrice);

    return { dtgPrice, screenPrintPrice, embroideryPrice };
  }
}

// ============================================
// 5. PRODUCT DETAILS AND INVENTORY
// ============================================

async function getProductWithInventory(styleNumber, color) {
  try {
    // Get product details
    const detailsResponse = await fetch(
      `${API_BASE_URL}/product-details?styleNumber=${styleNumber}&color=${encodeURIComponent(color)}`
    );
    const productDetails = await detailsResponse.json();

    // Get inventory levels
    const inventoryResponse = await fetch(
      `${API_BASE_URL}/inventory?styleNumber=${styleNumber}&color=${encodeURIComponent(color)}`
    );
    const inventory = await inventoryResponse.json();

    // Get available sizes
    const sizesResponse = await fetch(
      `${API_BASE_URL}/sizes-by-style-color?styleNumber=${styleNumber}&color=${encodeURIComponent(color)}`
    );
    const sizes = await sizesResponse.json();

    return {
      product: productDetails,
      inventory: inventory,
      availableSizes: sizes
    };
  } catch (error) {
    console.error('Failed to get product with inventory:', error);
    throw error;
  }
}

// ============================================
// 6. ERROR HANDLING WRAPPER
// ============================================

class APIClient {
  constructor(baseUrl = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      // Handle different response statuses
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      // Handle empty responses
      const text = await response.text();
      return text ? JSON.parse(text) : {};
      
    } catch (error) {
      console.error(`API Request failed for ${endpoint}:`, error.message);
      throw error;
    }
  }

  // Convenience methods
  get(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullEndpoint = queryString ? `${endpoint}?${queryString}` : endpoint;
    return this.request(fullEndpoint, { method: 'GET' });
  }

  post(endpoint, data) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  put(endpoint, data) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }
}

// ============================================
// 7. COMPLETE WORKFLOW EXAMPLE
// ============================================

async function completeWorkflowExample() {
  const api = new APIClient();
  
  try {
    console.log('=== Starting Complete Workflow Example ===\n');

    // 1. Search for products
    console.log('1. Searching for polo shirts...');
    const searchResults = await api.get('/products/search', {
      q: 'polo',
      category: 'Polos',
      limit: 5
    });
    console.log(`Found ${searchResults.products.length} polo products\n`);

    if (searchResults.products.length === 0) {
      console.log('No products found, exiting...');
      return;
    }

    // 2. Get details for first product
    const firstProduct = searchResults.products[0];
    console.log('2. Getting details for:', firstProduct.style);
    const productDetails = await api.get('/product-details', {
      styleNumber: firstProduct.style,
      color: firstProduct.colors[0]
    });
    console.log('Product:', productDetails.PRODUCT_TITLE, '\n');

    // 3. Check inventory
    console.log('3. Checking inventory...');
    const inventory = await api.get('/inventory', {
      styleNumber: firstProduct.style,
      color: firstProduct.colors[0]
    });
    console.log('Available sizes:', inventory.map(i => `${i.SIZE}: ${i.QTY_AVAILABLE}`).join(', '), '\n');

    // 4. Get pricing
    console.log('4. Getting pricing information...');
    const baseCosts = await api.get('/base-item-costs', {
      styleNumber: firstProduct.style
    });
    console.log('Base costs:', baseCosts, '\n');

    // 5. Create cart and add item
    console.log('5. Creating cart session...');
    const cart = new CartManager(API_BASE_URL);
    const session = await cart.createSession();
    console.log('Cart session created:', session.SessionID);

    const cartItem = await cart.addItem(
      '1',
      firstProduct.style,
      firstProduct.colors[0],
      firstProduct.title
    );
    console.log('Added item to cart\n');

    // 6. Check production schedule
    console.log('6. Checking production schedules...');
    const schedules = await api.get('/production-schedules', {
      'q.orderBy': 'Date DESC',
      'q.limit': 1
    });
    if (schedules.length > 0) {
      const latest = schedules[0];
      console.log('Latest production availability:');
      console.log('- DTG:', latest.DTG);
      console.log('- Screen Print:', latest.Screenprint);
      console.log('- Embroidery:', latest.Embroidery, '\n');
    }

    // 7. Get dashboard metrics
    console.log('7. Getting order dashboard metrics...');
    const dashboard = await api.get('/order-dashboard', { days: 7 });
    console.log('Weekly order summary:');
    console.log('- Total Orders:', dashboard.summary.totalOrders);
    console.log('- Total Sales: $', dashboard.summary.totalSales);
    console.log('- Average Order Value: $', dashboard.summary.avgOrderValue.toFixed(2));

    console.log('\n=== Workflow Complete ===');

  } catch (error) {
    console.error('Workflow failed:', error.message);
  }
}

// ============================================
// EXPORTS (for Node.js modules)
// ============================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    searchProducts,
    searchProductsAxios,
    CartManager,
    OrderDashboard,
    PricingCalculator,
    getProductWithInventory,
    APIClient,
    completeWorkflowExample
  };
}

// Run examples if executed directly
if (require.main === module) {
  completeWorkflowExample().catch(console.error);
}