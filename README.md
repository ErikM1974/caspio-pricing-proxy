# Caspio Pricing Proxy API

A Node.js proxy server providing unified access to Caspio data for Northwest Custom Apparel's pricing, inventory, and product information.

## 🚀 Quick Start

### Production API
```
Base URL: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api
```

### Development Setup
```bash
# Clone and install
git clone [repository-url]
cd caspio-pricing-proxy
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Caspio credentials

# Start server
PORT=3002 node server.js
```

### Your First Request
```bash
# Health check
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/health

# Search products
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?q=polo&limit=5"

# Get DTG bundle (optimized endpoint)
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/dtg/product-bundle?styleNumber=PC54"
```

## 📋 API Documentation

### 📖 **Complete API Reference**
➡️ **[CASPIO_API_TEMPLATE.md](../Pricing%20Index%20File%202025/memory/CASPIO_API_TEMPLATE.md)** ⬅️

**This is the authoritative documentation covering all 54 endpoints:**
- Complete endpoint specifications
- Request/response examples  
- Performance optimizations
- Integration patterns

### 📚 **Additional Resources**
- **[Developer Guide](memory/DEVELOPER_GUIDE.md)** - Best practices, integration patterns, performance tips
- **[API Changelog](memory/API_CHANGELOG.md)** - Version history and breaking changes
- **[OpenAPI Spec](memory/API_SPECIFICATION.yaml)** - Machine-readable API specification

## ⚡ Key Features

### 🚀 **Performance Optimized Endpoints**
- **DTG Bundle**: `/api/dtg/product-bundle` - Consolidates 4 API calls into 1 (~2-3x faster)
- **Enhanced Search**: `/api/products/search` - Smart grouping and faceted filtering  
- **Dashboard API**: `/api/order-dashboard` - Pre-calculated metrics with caching

### 🏗️ **Architecture Highlights**
- **54 Active Endpoints** across 12 modules
- **Modular Route Architecture** (`src/routes/`)
- **Automatic Pagination** handling with `fetchAllCaspioPages`
- **Server-side Caching** for performance
- **Comprehensive Error Handling**

## ⚠️ Critical Developer Notes

### **Pagination Requirement**
```javascript
// ❌ WRONG - Only gets first page
const data = await makeCaspioRequest('/tables/Products/records');

// ✅ CORRECT - Gets ALL records across all pages
const data = await fetchAllCaspioPages('/tables/Products/records');
```

**Always use `fetchAllCaspioPages`** when implementing new endpoints to avoid incomplete data.

### **Date Formatting**
```javascript
// ✅ REQUIRED - Remove milliseconds for Caspio compatibility
const formattedDate = new Date().toISOString().replace(/\.\d{3}Z$/, '');
```

### **Local Testing with WSL**
```bash
# Get WSL IP for Windows testing
hostname -I | awk '{print $1}'

# Use WSL IP in Postman/browsers (not localhost)
http://172.20.132.206:3002/api/health
```

## 📊 API Overview

| Module | Endpoints | Purpose |
|--------|-----------|---------|
| **Products** | 12 | Search, details, colors, variants |
| **Pricing** | 8 | Tiers, costs, calculations |
| **Cart** | 6 | Session and item management |
| **Orders** | 6 | Order processing and dashboard |
| **Quotes** | 6 | Quote generation and analytics |
| **Art** | 4 | Art requests and invoicing |
| **Others** | 12 | Inventory, transfers, utilities |

## 🔧 Environment Configuration

### Required Environment Variables
```bash
# Caspio API Configuration
CASPIO_DOMAIN=your-domain.caspio.com
CASPIO_CLIENT_ID=your-client-id
CASPIO_CLIENT_SECRET=your-client-secret

# Server Configuration  
PORT=3002
NODE_ENV=development
```

## 🚀 Deployment

### Heroku Production
```bash
git push heroku main
```

**Production URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

### Health Monitoring
- **Health Check**: `GET /api/health`
- **Status**: `GET /api/status` 
- **Uptime**: Monitored via Heroku

## 📞 Support

- **API Issues**: Check [CASPIO_API_TEMPLATE.md](../Pricing%20Index%20File%202025/memory/CASPIO_API_TEMPLATE.md) first
- **Integration Help**: See [Developer Guide](memory/DEVELOPER_GUIDE.md)
- **Version History**: [API Changelog](memory/API_CHANGELOG.md)

---

**Need comprehensive API documentation?** ➡️ **[View Complete API Reference](../Pricing%20Index%20File%202025/memory/CASPIO_API_TEMPLATE.md)**