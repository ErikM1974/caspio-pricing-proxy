/**
 * NWCA API Client Wrapper
 * 
 * This is a complete API client wrapper for the pricing-index application.
 * Copy this file to your pricing-index project and customize as needed.
 * 
 * Usage:
 * ```javascript
 * import NWCAApiClient from './api-client';
 * 
 * const api = new NWCAApiClient();
 * const products = await api.products.search({ q: 'polo', limit: 10 });
 * ```
 */

class NWCAApiClient {
  constructor(baseUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api') {
    this.baseUrl = baseUrl;
    
    // Initialize API modules
    this.products = new ProductsAPI(this);
    this.cart = new CartAPI(this);
    this.pricing = new PricingAPI(this);
    this.orders = new OrdersAPI(this);
    this.artRequests = new ArtRequestsAPI(this);
    this.quotes = new QuotesAPI(this);
    this.transfers = new TransfersAPI(this);
    this.inventory = new InventoryAPI(this);
    this.pricingMatrix = new PricingMatrixAPI(this);
    this.production = new ProductionAPI(this);
    this.utilities = new UtilitiesAPI(this);
  }

  /**
   * Core request method with error handling
   */
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

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new APIError(
          error.message || `HTTP ${response.status}`,
          response.status,
          error.errorId
        );
      }

      return response.json();
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }
      throw new APIError(`Network error: ${error.message}`, 0);
    }
  }

  /**
   * GET request helper
   */
  async get(endpoint, params = {}) {
    const queryString = this.buildQueryString(params);
    const fullEndpoint = queryString ? `${endpoint}?${queryString}` : endpoint;
    return this.request(fullEndpoint, { method: 'GET' });
  }

  /**
   * POST request helper
   */
  async post(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  /**
   * PUT request helper
   */
  async put(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  /**
   * DELETE request helper
   */
  async delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }

  /**
   * Build query string from params object
   */
  buildQueryString(params) {
    const cleaned = {};
    
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        // Handle arrays (for filters)
        if (Array.isArray(value)) {
          value.forEach(v => {
            if (!cleaned[key]) cleaned[key] = [];
            cleaned[key].push(v);
          });
        } else {
          cleaned[key] = value;
        }
      }
    }

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(cleaned)) {
      if (Array.isArray(value)) {
        value.forEach(v => searchParams.append(`${key}[]`, v));
      } else {
        searchParams.append(key, value);
      }
    }

    return searchParams.toString();
  }
}

/**
 * Custom API Error class
 */
class APIError extends Error {
  constructor(message, status, errorId) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.errorId = errorId;
  }
}

/**
 * Products API Module
 */
class ProductsAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Enhanced product search with faceted filtering
   */
  async search(params = {}) {
    const defaultParams = {
      status: 'Active',
      page: 1,
      limit: 24,
      includeFacets: true
    };
    
    return this.client.get('/products/search', { ...defaultParams, ...params });
  }

  /**
   * Style number autocomplete
   */
  async styleSearch(term, limit = 10) {
    return this.client.get('/stylesearch', { term, limit });
  }

  /**
   * Get product details
   */
  async getDetails(styleNumber, color = null) {
    const params = { styleNumber };
    if (color) params.color = color;
    return this.client.get('/product-details', params);
  }

  /**
   * Get color swatches for a style
   */
  async getColorSwatches(styleNumber) {
    return this.client.get('/color-swatches', { styleNumber });
  }

  /**
   * Get available colors for a style
   */
  async getColors(styleNumber) {
    return this.client.get('/product-colors', { styleNumber });
  }

  /**
   * Get related products
   */
  async getRelated(styleNumber) {
    return this.client.get('/related-products', { styleNumber });
  }

  /**
   * Compare multiple products
   */
  async compare(styleNumbers) {
    const styles = Array.isArray(styleNumbers) 
      ? styleNumbers.join(',') 
      : styleNumbers;
    return this.client.get('/compare-products', { styles });
  }

  /**
   * Get quick view data
   */
  async quickView(styleNumber) {
    return this.client.get('/quick-view', { styleNumber });
  }

  /**
   * Get featured products
   */
  async getFeatured(limit = 10) {
    return this.client.get('/featured-products', { limit });
  }

  /**
   * Get products by brand
   */
  async getByBrand(brand) {
    return this.client.get('/products-by-brand', { brand });
  }

  /**
   * Get products by category
   */
  async getByCategory(category) {
    return this.client.get('/products-by-category', { category });
  }

  /**
   * Get products by subcategory
   */
  async getBySubcategory(subcategory) {
    return this.client.get('/products-by-subcategory', { subcategory });
  }

  /**
   * Filter products by multiple criteria
   */
  async filter(params) {
    return this.client.get('/filter-products', params);
  }
}

/**
 * Cart API Module
 */
class CartAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get cart sessions
   */
  async getSessions(filter = null) {
    const params = {};
    if (filter) params['q.where'] = filter;
    return this.client.get('/cart-sessions', params);
  }

  /**
   * Create new cart session
   */
  async createSession(sessionId = null) {
    const data = {
      SessionID: sessionId || `session_${Date.now()}`,
      IsActive: true,
      CreatedDate: new Date().toISOString()
    };
    return this.client.post('/cart-sessions', data);
  }

  /**
   * Update cart session
   */
  async updateSession(id, data) {
    return this.client.put(`/cart-sessions/${id}`, data);
  }

  /**
   * Delete cart session
   */
  async deleteSession(id) {
    return this.client.delete(`/cart-sessions/${id}`);
  }

  /**
   * Get cart items
   */
  async getItems(sessionId) {
    const filter = `SessionID='${sessionId}' AND CartStatus='Active'`;
    return this.client.get('/cart-items', { 'q.where': filter });
  }

  /**
   * Add item to cart
   */
  async addItem(sessionId, product) {
    const data = {
      SessionID: sessionId,
      StyleNumber: product.styleNumber,
      Color: product.color,
      Method: product.method || 'Blank',
      CartStatus: 'Active',
      CreatedDate: new Date().toISOString()
    };
    return this.client.post('/cart-items', data);
  }

  /**
   * Update cart item
   */
  async updateItem(id, data) {
    return this.client.put(`/cart-items/${id}`, data);
  }

  /**
   * Remove item from cart
   */
  async removeItem(id) {
    return this.client.delete(`/cart-items/${id}`);
  }

  /**
   * Add size/quantity to cart item
   */
  async addItemSize(cartItemId, size, quantity, unitPrice) {
    const data = {
      CartItemID: cartItemId,
      Size: size,
      Quantity: quantity,
      UnitPrice: unitPrice
    };
    return this.client.post('/cart-item-sizes', data);
  }

  /**
   * Update cart item size
   */
  async updateItemSize(id, data) {
    return this.client.put(`/cart-item-sizes/${id}`, data);
  }

  /**
   * Remove size from cart item
   */
  async removeItemSize(id) {
    return this.client.delete(`/cart-item-sizes/${id}`);
  }

  /**
   * Helper: Add complete product with sizes to cart
   */
  async addProductToCart(sessionId, product) {
    // Add the cart item
    const cartItem = await this.addItem(sessionId, product);
    const cartItemId = cartItem.data.ID;

    // Add all sizes/quantities
    if (product.sizes && product.sizes.length > 0) {
      const sizePromises = product.sizes.map(size =>
        this.addItemSize(cartItemId, size.size, size.quantity, size.price)
      );
      await Promise.all(sizePromises);
    }

    return cartItem;
  }
}

/**
 * Pricing API Module
 */
class PricingAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get pricing tiers by method
   */
  async getTiers(method) {
    return this.client.get('/pricing-tiers', { method });
  }

  /**
   * Calculate embroidery cost
   */
  async calculateEmbroidery(stitchCount, quantity) {
    return this.client.get('/embroidery-costs', { stitchCount, quantity });
  }

  /**
   * Get DTG costs
   */
  async getDTGCosts(styleNumber, color, printSize, quantity) {
    return this.client.get('/dtg-costs', {
      styleNumber,
      color,
      printSize,
      quantity
    });
  }

  /**
   * Get screen print costs
   */
  async getScreenPrintCosts(colors, quantity, locations = 1) {
    return this.client.get('/screenprint-costs', {
      colors,
      quantity,
      locations
    });
  }

  /**
   * Get pricing rules
   */
  async getRules() {
    return this.client.get('/pricing-rules');
  }

  /**
   * Get base item costs
   */
  async getBaseCosts(styleNumber) {
    return this.client.get('/base-item-costs', { styleNumber });
  }

  /**
   * Get size-based pricing
   */
  async getSizePricing(styleNumber, size) {
    return this.client.get('/size-pricing', { styleNumber, size });
  }

  /**
   * Get max prices by style
   */
  async getMaxPrices(styleNumber) {
    return this.client.get('/max-prices-by-style', { styleNumber });
  }
}

/**
 * Orders API Module
 */
class OrdersAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get order dashboard metrics
   */
  async getDashboard(days = 7, includeDetails = false, compareYoY = false) {
    return this.client.get('/order-dashboard', {
      days,
      includeDetails,
      compareYoY
    });
  }

  /**
   * List orders
   */
  async list(params = {}) {
    return this.client.get('/orders', params);
  }

  /**
   * Create new order
   */
  async create(orderData) {
    const data = {
      OrderStatus: 'Pending',
      OrderDate: new Date().toISOString(),
      ...orderData
    };
    return this.client.post('/orders', data);
  }

  /**
   * Update order
   */
  async update(id, data) {
    return this.client.put(`/orders/${id}`, data);
  }

  /**
   * Delete order
   */
  async delete(id) {
    return this.client.delete(`/orders/${id}`);
  }

  /**
   * Get detailed order records (ODBC)
   */
  async getODBC(params = {}) {
    return this.client.get('/order-odbc', params);
  }

  /**
   * List customers
   */
  async listCustomers(params = {}) {
    return this.client.get('/customers', params);
  }

  /**
   * Create customer
   */
  async createCustomer(customerData) {
    return this.client.post('/customers', customerData);
  }

  /**
   * Update customer
   */
  async updateCustomer(id, data) {
    return this.client.put(`/customers/${id}`, data);
  }

  /**
   * Delete customer
   */
  async deleteCustomer(id) {
    return this.client.delete(`/customers/${id}`);
  }
}

/**
 * Art Requests API Module
 */
class ArtRequestsAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * List art requests
   */
  async list(params = {}) {
    return this.client.get('/artrequests', params);
  }

  /**
   * Get specific art request
   */
  async get(id) {
    return this.client.get(`/artrequests/${id}`);
  }

  /**
   * Create art request
   */
  async create(requestData) {
    const data = {
      Status: 'In Progress',
      CreatedDate: new Date().toISOString(),
      ...requestData
    };
    return this.client.post('/artrequests', data);
  }

  /**
   * Update art request
   */
  async update(id, data) {
    return this.client.put(`/artrequests/${id}`, data);
  }

  /**
   * Delete art request
   */
  async delete(id) {
    return this.client.delete(`/artrequests/${id}`);
  }

  /**
   * List art invoices
   */
  async listInvoices(params = {}) {
    return this.client.get('/art-invoices', params);
  }

  /**
   * Create art invoice
   */
  async createInvoice(invoiceData) {
    return this.client.post('/art-invoices', invoiceData);
  }

  /**
   * Update art invoice
   */
  async updateInvoice(id, data) {
    return this.client.put(`/art-invoices/${id}`, data);
  }

  /**
   * Delete art invoice
   */
  async deleteInvoice(id) {
    return this.client.delete(`/art-invoices/${id}`);
  }
}

/**
 * Quotes API Module
 */
class QuotesAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * List quote sessions
   */
  async listSessions(params = {}) {
    return this.client.get('/quote_sessions', params);
  }

  /**
   * Create quote session
   */
  async createSession(quoteId, sessionId) {
    const data = {
      QuoteID: quoteId,
      SessionID: sessionId,
      Status: 'Active',
      CreatedDate: new Date().toISOString()
    };
    return this.client.post('/quote_sessions', data);
  }

  /**
   * Update quote session
   */
  async updateSession(id, data) {
    return this.client.put(`/quote_sessions/${id}`, data);
  }

  /**
   * Delete quote session
   */
  async deleteSession(id) {
    return this.client.delete(`/quote_sessions/${id}`);
  }

  /**
   * List quote items
   */
  async listItems(params = {}) {
    return this.client.get('/quote_items', params);
  }

  /**
   * Add item to quote
   */
  async addItem(quoteId, styleNumber, quantity) {
    const data = {
      QuoteID: quoteId,
      StyleNumber: styleNumber,
      Quantity: quantity
    };
    return this.client.post('/quote_items', data);
  }

  /**
   * Update quote item
   */
  async updateItem(id, data) {
    return this.client.put(`/quote_items/${id}`, data);
  }

  /**
   * Delete quote item
   */
  async deleteItem(id) {
    return this.client.delete(`/quote_items/${id}`);
  }

  /**
   * Track quote analytics event
   */
  async trackEvent(sessionId, eventType, quoteId = null) {
    const data = {
      SessionID: sessionId,
      EventType: eventType,
      QuoteID: quoteId,
      Timestamp: new Date().toISOString()
    };
    return this.client.post('/quote_analytics', data);
  }
}

/**
 * Transfers API Module
 */
class TransfersAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Lookup transfer price
   */
  async lookupPrice(size, quantity, priceType = 'Regular') {
    return this.client.get('/transfers/lookup', {
      size,
      quantity,
      price_type: priceType
    });
  }

  /**
   * Get transfer pricing matrix
   */
  async getMatrix(size) {
    return this.client.get('/transfers/matrix', { size });
  }

  /**
   * Get available transfer sizes
   */
  async getSizes() {
    return this.client.get('/transfers/sizes');
  }

  /**
   * List all transfers
   */
  async list(params = {}) {
    return this.client.get('/transfers', params);
  }
}

/**
 * Inventory API Module
 */
class InventoryAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get inventory levels
   */
  async getInventory(styleNumber = null, color = null) {
    const params = {};
    if (styleNumber) params.styleNumber = styleNumber;
    if (color) params.color = color;
    return this.client.get('/inventory', params);
  }

  /**
   * Get available sizes for style/color
   */
  async getSizesByStyleColor(styleNumber, color) {
    return this.client.get('/sizes-by-style-color', { styleNumber, color });
  }

  /**
   * Get product variant sizes with prices
   */
  async getVariantSizes(styleNumber, color) {
    return this.client.get('/product-variant-sizes', { styleNumber, color });
  }

  /**
   * Get prices by style and color
   */
  async getPricesByStyleColor(styleNumber, color) {
    return this.client.get('/prices-by-style-color', { styleNumber, color });
  }
}

/**
 * Pricing Matrix API Module
 */
class PricingMatrixAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * List pricing matrices
   */
  async list(params = {}) {
    return this.client.get('/pricing-matrix', params);
  }

  /**
   * Lookup pricing matrix
   */
  async lookup(method, quantity) {
    return this.client.get('/pricing-matrix/lookup', { method, quantity });
  }

  /**
   * Get specific pricing matrix
   */
  async get(id) {
    return this.client.get(`/pricing-matrix/${id}`);
  }

  /**
   * Create pricing matrix
   */
  async create(matrixData) {
    return this.client.post('/pricing-matrix', matrixData);
  }

  /**
   * Update pricing matrix
   */
  async update(id, data) {
    return this.client.put(`/pricing-matrix/${id}`, data);
  }

  /**
   * Delete pricing matrix
   */
  async delete(id) {
    return this.client.delete(`/pricing-matrix/${id}`);
  }
}

/**
 * Production API Module
 */
class ProductionAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get production schedules
   */
  async getSchedules(params = {}) {
    const defaultParams = {
      'q.orderBy': 'Date DESC',
      'q.limit': 100
    };
    return this.client.get('/production-schedules', { ...defaultParams, ...params });
  }
}

/**
 * Utilities API Module
 */
class UtilitiesAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * Health check
   */
  async health() {
    return this.client.get('/health');
  }

  /**
   * API status
   */
  async status() {
    return this.client.get('/status');
  }

  /**
   * Get all brands
   */
  async getAllBrands() {
    return this.client.get('/all-brands');
  }

  /**
   * Get all categories
   */
  async getAllCategories() {
    return this.client.get('/all-categories');
  }

  /**
   * Get all subcategories
   */
  async getAllSubcategories() {
    return this.client.get('/all-subcategories');
  }

  /**
   * Get subcategories by category
   */
  async getSubcategoriesByCategory(category) {
    return this.client.get('/subcategories-by-category', { category });
  }

  /**
   * Get products by category and subcategory
   */
  async getProductsByCategorySubcategory(category, subcategory) {
    return this.client.get('/products-by-category-subcategory', {
      category,
      subcategory
    });
  }

  /**
   * Get product recommendations
   */
  async getRecommendations(styleNumber) {
    return this.client.get('/recommendations', { styleNumber });
  }

  /**
   * Get staff announcements
   */
  async getAnnouncements() {
    return this.client.get('/staff-announcements');
  }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NWCAApiClient;
} else {
  window.NWCAApiClient = NWCAApiClient;
}