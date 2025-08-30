# API Client Guide for Pricing-Index Application

This guide is for developers working on the **pricing-index** application, explaining how to consume the Caspio Pricing Proxy API.

## API Base URL

```javascript
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api';
```

## Authentication

The API currently does not require authentication. All endpoints are publicly accessible.

## Core API Patterns

### 1. Product Search & Display

#### Enhanced Product Search
The primary search endpoint for product catalogs:

```javascript
// Search with filters and facets
async function searchProducts(params) {
  const queryParams = new URLSearchParams({
    q: params.searchQuery || '',
    category: params.category || '',
    brand: params.brand || '',
    minPrice: params.minPrice || '',
    maxPrice: params.maxPrice || '',
    page: params.page || 1,
    limit: params.limit || 24,
    includeFacets: true,
    sort: params.sort || 'name_asc'
  });

  const response = await fetch(`${API_BASE_URL}/products/search?${queryParams}`);
  return response.json();
}

// Response includes:
// - products: Array of grouped products (by style)
// - facets: Available filters with counts
// - pagination: Page info
```

#### Product Details
Get complete product information:

```javascript
async function getProductDetails(styleNumber, color) {
  const params = new URLSearchParams({ 
    styleNumber, 
    color 
  });
  
  const response = await fetch(`${API_BASE_URL}/product-details?${params}`);
  return response.json();
}
```

#### Product Variant Sizes
Get available sizes and prices for a style/color:

```javascript
async function getProductSizes(styleNumber, color) {
  const params = new URLSearchParams({ 
    styleNumber, 
    color 
  });
  
  const response = await fetch(`${API_BASE_URL}/product-variant-sizes?${params}`);
  return response.json();
}
```

### 2. Shopping Cart Management

#### Create Cart Session
Initialize a new cart:

```javascript
async function createCart() {
  const sessionId = `session_${Date.now()}`;
  
  const response = await fetch(`${API_BASE_URL}/cart-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      SessionID: sessionId,
      IsActive: true,
      CreatedDate: new Date().toISOString()
    })
  });
  
  return response.json();
}
```

#### Add Item to Cart
Add a product to the cart:

```javascript
async function addToCart(sessionId, product) {
  const response = await fetch(`${API_BASE_URL}/cart-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      SessionID: sessionId,
      StyleNumber: product.styleNumber,
      Color: product.color,
      Method: product.decorationMethod,
      CartStatus: 'Active',
      CreatedDate: new Date().toISOString()
    })
  });
  
  const cartItem = await response.json();
  
  // Add sizes/quantities
  for (const sizeQty of product.sizes) {
    await fetch(`${API_BASE_URL}/cart-item-sizes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CartItemID: cartItem.data.ID,
        Size: sizeQty.size,
        Quantity: sizeQty.quantity,
        UnitPrice: sizeQty.price
      })
    });
  }
  
  return cartItem;
}
```

#### Get Cart Items
Retrieve all items in a cart:

```javascript
async function getCartItems(sessionId) {
  const params = new URLSearchParams({
    'q.where': `SessionID='${sessionId}' AND CartStatus='Active'`
  });
  
  const response = await fetch(`${API_BASE_URL}/cart-items?${params}`);
  return response.json();
}
```

### 3. Pricing Calculations

#### Get Pricing Tiers
Get pricing for decoration methods:

```javascript
async function getPricingTiers(method) {
  const params = new URLSearchParams({ method });
  const response = await fetch(`${API_BASE_URL}/pricing-tiers?${params}`);
  return response.json();
}
```

#### Calculate Embroidery Cost
Calculate embroidery pricing:

```javascript
async function calculateEmbroideryCost(stitchCount, quantity) {
  const params = new URLSearchParams({ 
    stitchCount, 
    quantity 
  });
  
  const response = await fetch(`${API_BASE_URL}/embroidery-costs?${params}`);
  return response.json();
}
```

#### Get DTG Costs
Get Direct-to-Garment printing costs:

```javascript
async function getDTGCosts(styleNumber, color, printSize, quantity) {
  const params = new URLSearchParams({ 
    styleNumber, 
    color, 
    printSize, 
    quantity 
  });
  
  const response = await fetch(`${API_BASE_URL}/dtg-costs?${params}`);
  return response.json();
}
```

### 4. Order Management

#### Create Order
Convert cart to order:

```javascript
async function createOrder(cartSession, customer) {
  const response = await fetch(`${API_BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      CustomerID: customer.id,
      SessionID: cartSession.SessionID,
      TotalAmount: cartSession.totalAmount,
      OrderStatus: 'Pending',
      PaymentMethod: customer.paymentMethod,
      ShippingAddress: customer.shippingAddress,
      BillingAddress: customer.billingAddress,
      OrderDate: new Date().toISOString()
    })
  });
  
  return response.json();
}
```

#### Get Order Dashboard
Get order metrics for dashboard:

```javascript
async function getOrderDashboard(days = 7) {
  const params = new URLSearchParams({
    days,
    includeDetails: true,
    compareYoY: true
  });
  
  const response = await fetch(`${API_BASE_URL}/order-dashboard?${params}`);
  return response.json();
}
```

### 5. Art Requests

#### Create Art Request
Submit a new art request:

```javascript
async function createArtRequest(request) {
  const response = await fetch(`${API_BASE_URL}/artrequests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      CompanyName: request.company,
      Status: 'In Progress',
      CustomerServiceRep: request.rep,
      Priority: request.priority,
      Mockup: request.needsMockup,
      GarmentStyle: request.styleNumber,
      GarmentColor: request.color,
      NOTES: request.notes,
      CreatedDate: new Date().toISOString()
    })
  });
  
  return response.json();
}
```

## Error Handling

All API endpoints return consistent error responses:

```javascript
async function apiCall(url, options = {}) {
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    
    return response.json();
  } catch (error) {
    console.error('API Error:', error);
    
    // Handle specific error types
    if (error.message.includes('Network')) {
      // Handle network errors
      showNotification('Connection error. Please check your internet.');
    } else if (error.message.includes('404')) {
      // Handle not found
      showNotification('Item not found.');
    } else {
      // Generic error
      showNotification('An error occurred. Please try again.');
    }
    
    throw error;
  }
}
```

## Caching Strategies

### Product Data Caching
Products change infrequently, cache for longer:

```javascript
const productCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getCachedProduct(styleNumber) {
  const key = `product_${styleNumber}`;
  const cached = productCache.get(key);
  
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  
  const data = await getProductDetails(styleNumber);
  productCache.set(key, {
    data,
    timestamp: Date.now()
  });
  
  return data;
}
```

### Dashboard Data Caching
Dashboard data is already cached server-side (60 seconds), but you can add client-side caching:

```javascript
let dashboardCache = null;
let dashboardCacheTime = 0;

async function getCachedDashboard(days) {
  const now = Date.now();
  const cacheKey = `dashboard_${days}`;
  
  if (dashboardCache?.key === cacheKey && 
      now - dashboardCacheTime < 30000) { // 30 seconds
    return dashboardCache.data;
  }
  
  const data = await getOrderDashboard(days);
  dashboardCache = { key: cacheKey, data };
  dashboardCacheTime = now;
  
  return data;
}
```

## Common UI Patterns

### Product Search with Filters
```javascript
class ProductSearch {
  constructor() {
    this.filters = {
      category: [],
      brand: [],
      color: [],
      size: [],
      priceRange: { min: null, max: null }
    };
    this.searchQuery = '';
    this.currentPage = 1;
    this.sort = 'name_asc';
  }

  async search() {
    const params = {
      q: this.searchQuery,
      page: this.currentPage,
      limit: 24,
      sort: this.sort,
      includeFacets: true
    };

    // Add array filters
    if (this.filters.category.length) {
      params.category = this.filters.category;
    }
    if (this.filters.brand.length) {
      params.brand = this.filters.brand;
    }
    
    // Add price range
    if (this.filters.priceRange.min) {
      params.minPrice = this.filters.priceRange.min;
    }
    if (this.filters.priceRange.max) {
      params.maxPrice = this.filters.priceRange.max;
    }

    const results = await searchProducts(params);
    
    // Update UI with products and facets
    this.updateProductGrid(results.products);
    this.updateFilterCounts(results.facets);
    this.updatePagination(results.pagination);
  }

  updateFilter(type, value, checked) {
    if (checked) {
      this.filters[type].push(value);
    } else {
      const index = this.filters[type].indexOf(value);
      if (index > -1) {
        this.filters[type].splice(index, 1);
      }
    }
    this.currentPage = 1; // Reset to first page
    this.search();
  }
}
```

### Cart Management
```javascript
class CartManager {
  constructor() {
    this.sessionId = localStorage.getItem('cartSessionId');
    this.items = [];
  }

  async initialize() {
    if (!this.sessionId) {
      const cart = await createCart();
      this.sessionId = cart.data.SessionID;
      localStorage.setItem('cartSessionId', this.sessionId);
    }
    await this.loadItems();
  }

  async loadItems() {
    const response = await getCartItems(this.sessionId);
    this.items = response.data || [];
    this.updateUI();
  }

  async addProduct(product) {
    await addToCart(this.sessionId, product);
    await this.loadItems();
    showNotification('Product added to cart');
  }

  async removeItem(itemId) {
    await fetch(`${API_BASE_URL}/cart-items/${itemId}`, {
      method: 'DELETE'
    });
    await this.loadItems();
  }

  async checkout() {
    // Convert cart to order
    const customer = await this.getCustomerInfo();
    const order = await createOrder(
      { SessionID: this.sessionId, totalAmount: this.getTotal() },
      customer
    );
    
    // Clear cart
    localStorage.removeItem('cartSessionId');
    this.sessionId = null;
    this.items = [];
    
    return order;
  }

  getTotal() {
    return this.items.reduce((sum, item) => {
      return sum + item.sizes.reduce((itemSum, size) => {
        return itemSum + (size.Quantity * size.UnitPrice);
      }, 0);
    }, 0);
  }
}
```

## Performance Best Practices

1. **Batch Requests**: When loading multiple related resources, use parallel requests:
   ```javascript
   const [products, categories, brands] = await Promise.all([
     searchProducts({ limit: 10 }),
     fetch(`${API_BASE_URL}/all-categories`).then(r => r.json()),
     fetch(`${API_BASE_URL}/all-brands`).then(r => r.json())
   ]);
   ```

2. **Pagination**: Always paginate large result sets:
   ```javascript
   const PAGE_SIZE = 24;
   let currentPage = 1;
   
   async function loadMore() {
     const results = await searchProducts({
       page: currentPage++,
       limit: PAGE_SIZE
     });
     appendProducts(results.products);
     
     if (currentPage > results.pagination.totalPages) {
       hideLoadMoreButton();
     }
   }
   ```

3. **Debounce Search**: Prevent excessive API calls during typing:
   ```javascript
   let searchTimeout;
   
   function handleSearchInput(event) {
     clearTimeout(searchTimeout);
     searchTimeout = setTimeout(() => {
       performSearch(event.target.value);
     }, 300);
   }
   ```

4. **Lazy Loading**: Load details only when needed:
   ```javascript
   async function showProductModal(styleNumber) {
     showLoadingSpinner();
     
     const [details, sizes, related] = await Promise.all([
       getProductDetails(styleNumber),
       getProductSizes(styleNumber),
       fetch(`${API_BASE_URL}/related-products?styleNumber=${styleNumber}`)
         .then(r => r.json())
     ]);
     
     renderProductModal(details, sizes, related);
   }
   ```

## Testing Your Integration

Use these test patterns to verify your API integration:

```javascript
// Test connectivity
async function testConnection() {
  const response = await fetch(`${API_BASE_URL}/health`);
  console.assert(response.ok, 'API health check failed');
}

// Test search
async function testSearch() {
  const results = await searchProducts({ q: 'polo', limit: 5 });
  console.assert(results.products?.length > 0, 'Search returned no results');
  console.assert(results.pagination, 'Missing pagination data');
}

// Test cart flow
async function testCartFlow() {
  // Create session
  const cart = await createCart();
  console.assert(cart.data.SessionID, 'Failed to create cart');
  
  // Add item
  const item = await addToCart(cart.data.SessionID, {
    styleNumber: 'PC54',
    color: 'Red',
    decorationMethod: 'DTG',
    sizes: [{ size: 'L', quantity: 1, price: 12.99 }]
  });
  console.assert(item.data.ID, 'Failed to add item');
  
  // Get items
  const items = await getCartItems(cart.data.SessionID);
  console.assert(items.data.length > 0, 'Cart is empty');
  
  console.log('✅ Cart flow test passed');
}
```

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| CORS errors | Ensure you're using the production URL, not localhost |
| Empty responses | Check if you're using correct query parameter names |
| 404 errors | Verify the endpoint path matches the API documentation |
| Slow responses | Implement caching and pagination |
| Cart items disappearing | Store sessionId in localStorage |

## Next Steps

1. Copy this guide to your pricing-index project
2. Use the `endpoints.json` file for endpoint discovery
3. Implement the API client wrapper for cleaner code
4. Add proper error handling and retry logic
5. Implement comprehensive caching strategy

## Support

For API issues or questions:
- Check the [API Documentation](../memory/API_DOCUMENTATION.md)
- Review the [Postman Collection](../docs/NWCA-API.postman_collection.json)
- Test endpoints with `node test-endpoints.js` in the API project