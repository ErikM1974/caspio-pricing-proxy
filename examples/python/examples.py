"""
Caspio Pricing Proxy API - Python Examples

These examples demonstrate common API operations using the requests library.
Install requirements: pip install requests
"""

import requests
import json
from typing import Dict, List, Optional, Any
from datetime import datetime
import time

# Configuration
API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api'
# For local development:
# API_BASE_URL = 'http://localhost:3002/api'


# ============================================
# 1. PRODUCT SEARCH WITH FILTERS
# ============================================

def search_products(query: str, **filters) -> Dict[str, Any]:
    """
    Search for products with optional filters.
    
    Args:
        query: Search term
        **filters: Additional filters (category, brand, minPrice, maxPrice, etc.)
    
    Returns:
        Dict containing products and optional facets
    """
    params = {'q': query, **filters}
    
    try:
        response = requests.get(f'{API_BASE_URL}/products/search', params=params)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f'Product search failed: {e}')
        raise


def product_search_examples():
    """Demonstrate various product search scenarios."""
    
    # Simple search
    results = search_products('polo')
    print(f"Found {len(results['products'])} polo products")
    
    # Advanced search with filters
    results = search_products(
        'shirt',
        category='T-Shirts',
        brand='Port & Company',
        minPrice=10,
        maxPrice=50,
        includeFacets=True
    )
    print(f"Filtered search found {len(results['products'])} products")
    
    if results.get('facets'):
        print("Available filters:")
        for facet_type, facets in results['facets'].items():
            print(f"  {facet_type}: {len(facets)} options")
    
    # Search with multiple categories
    results = search_products(
        '',
        category=['T-Shirts', 'Polos'],
        sort='price_asc',
        limit=10
    )
    print(f"Multi-category search: {len(results['products'])} products")
    
    return results


# ============================================
# 2. CART SESSION MANAGEMENT
# ============================================

class CartManager:
    """Manage cart sessions and items."""
    
    def __init__(self, base_url: str = API_BASE_URL):
        self.base_url = base_url
        self.session_id = None
    
    def create_session(self, user_id: Optional[int] = None) -> Dict[str, Any]:
        """Create a new cart session."""
        session_id = f"session_{int(time.time())}_{hash(datetime.now())}"
        
        data = {
            'SessionID': session_id,
            'UserID': user_id,
            'IsActive': True
        }
        
        response = requests.post(
            f'{self.base_url}/cart-sessions',
            json=data
        )
        response.raise_for_status()
        
        session = response.json()
        self.session_id = session['SessionID']
        return session
    
    def add_item(self, product_id: str, style_number: str, 
                 color: str, title: str) -> Dict[str, Any]:
        """Add an item to the cart."""
        if not self.session_id:
            self.create_session()
        
        data = {
            'SessionID': self.session_id,
            'ProductID': product_id,
            'StyleNumber': style_number,
            'Color': color,
            'PRODUCT_TITLE': title,
            'CartStatus': 'Active'
        }
        
        response = requests.post(
            f'{self.base_url}/cart-items',
            json=data
        )
        response.raise_for_status()
        return response.json()
    
    def add_item_size(self, cart_item_id: int, size: str, 
                      quantity: int, unit_price: Optional[float] = None) -> Dict[str, Any]:
        """Add size and quantity for a cart item."""
        data = {
            'CartItemID': cart_item_id,
            'Size': size,
            'Quantity': quantity
        }
        if unit_price:
            data['UnitPrice'] = unit_price
        
        response = requests.post(
            f'{self.base_url}/cart-item-sizes',
            json=data
        )
        response.raise_for_status()
        return response.json()
    
    def get_cart_items(self) -> List[Dict[str, Any]]:
        """Get all items in the current cart session."""
        if not self.session_id:
            return []
        
        response = requests.get(
            f'{self.base_url}/cart-items',
            params={'sessionID': self.session_id}
        )
        response.raise_for_status()
        return response.json()
    
    def complete_cart_example(self):
        """Demonstrate complete cart workflow."""
        # Create session
        session = self.create_session()
        print(f'Created cart session: {session["SessionID"]}')
        
        # Add a product
        cart_item = self.add_item('123', 'PC61', 'Navy', 'Essential Tee')
        print(f'Added item to cart: {cart_item}')
        
        # Add sizes
        cart_item_id = cart_item['PK_ID']
        self.add_item_size(cart_item_id, 'M', 5, 12.99)
        self.add_item_size(cart_item_id, 'L', 3, 12.99)
        self.add_item_size(cart_item_id, 'XL', 2, 13.99)
        
        # Get all cart items
        items = self.get_cart_items()
        print(f'Cart contains {len(items)} items')
        
        return {'session': session, 'items': items}


# ============================================
# 3. ORDER DASHBOARD QUERIES
# ============================================

class OrderDashboard:
    """Access order dashboard metrics and records."""
    
    def __init__(self, base_url: str = API_BASE_URL):
        self.base_url = base_url
    
    def get_metrics(self, days: int = 7, include_details: bool = False,
                   compare_yoy: bool = False) -> Dict[str, Any]:
        """Get dashboard metrics for specified period."""
        params = {
            'days': days,
            'includeDetails': include_details,
            'compareYoY': compare_yoy
        }
        
        response = requests.get(
            f'{self.base_url}/order-dashboard',
            params=params
        )
        response.raise_for_status()
        return response.json()
    
    def get_order_records(self, where: Optional[str] = None,
                         order_by: Optional[str] = None,
                         limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Get order ODBC records with filtering."""
        params = {}
        if where:
            params['q.where'] = where
        if order_by:
            params['q.orderBy'] = order_by
        if limit:
            params['q.limit'] = limit
        
        response = requests.get(
            f'{self.base_url}/order-odbc',
            params=params
        )
        response.raise_for_status()
        return response.json()
    
    def dashboard_examples(self):
        """Demonstrate dashboard queries."""
        # Get 7-day summary
        week_summary = self.get_metrics(7)
        print('Weekly Summary:')
        print(f'  Total Orders: {week_summary["summary"]["totalOrders"]}')
        print(f'  Total Sales: ${week_summary["summary"]["totalSales"]:,.2f}')
        print(f'  Today: {week_summary["todayStats"]["ordersToday"]} orders')
        
        # Get 30-day summary with details and YoY
        month_summary = self.get_metrics(30, True, True)
        print('\nMonthly Summary:')
        print(f'  Orders: {month_summary["summary"]["totalOrders"]}')
        
        if month_summary.get('yoyComparison'):
            yoy = month_summary['yoyComparison']
            print(f'  YoY Sales Growth: {yoy.get("salesGrowthPercent", 0):.1f}%')
        
        if month_summary.get('recentOrders'):
            print(f'  Recent Orders: {len(month_summary["recentOrders"])}')
        
        # Get unshipped orders
        unshipped = self.get_order_records(
            where='sts_Invoiced=1 AND sts_Shipped=0',
            order_by='date_OrderPlaced DESC',
            limit=50
        )
        print(f'\nUnshipped Orders: {len(unshipped)}')
        
        # Get orders for specific customer
        customer_orders = self.get_order_records(
            where='id_Customer=11824',
            order_by='date_OrderPlaced DESC'
        )
        print(f'Customer 11824 Orders: {len(customer_orders)}')
        
        return {
            'week_summary': week_summary,
            'month_summary': month_summary,
            'unshipped': unshipped
        }


# ============================================
# 4. PRICING CALCULATIONS
# ============================================

class PricingCalculator:
    """Calculate pricing for orders."""
    
    def __init__(self, base_url: str = API_BASE_URL):
        self.base_url = base_url
    
    def get_pricing_tiers(self, method: str) -> List[Dict[str, Any]]:
        """Get pricing tiers for decoration method."""
        response = requests.get(
            f'{self.base_url}/pricing-tiers',
            params={'method': method}
        )
        response.raise_for_status()
        return response.json()
    
    def get_base_item_costs(self, style_number: str) -> Dict[str, float]:
        """Get base costs for each size of a style."""
        response = requests.get(
            f'{self.base_url}/base-item-costs',
            params={'styleNumber': style_number}
        )
        response.raise_for_status()
        return response.json()
    
    def get_embroidery_cost(self, item_type: str, stitch_count: int) -> Dict[str, float]:
        """Get embroidery cost for item type and stitch count."""
        response = requests.get(
            f'{self.base_url}/embroidery-costs',
            params={
                'itemType': item_type,
                'stitchCount': stitch_count
            }
        )
        response.raise_for_status()
        return response.json()
    
    def calculate_order_price(self, style_number: str, decoration_type: str,
                            quantity: int, stitch_count: Optional[int] = None) -> Dict[str, Any]:
        """Calculate total price for an order."""
        # Get base item costs
        base_costs = self.get_base_item_costs(style_number)
        print(f'Base costs per size: {base_costs}')
        
        # Get decoration pricing tiers
        pricing_tiers = self.get_pricing_tiers(decoration_type)
        
        # Find applicable tier for quantity
        applicable_tier = None
        for tier in pricing_tiers:
            if tier['minQuantity'] <= quantity <= tier['maxQuantity']:
                applicable_tier = tier
                break
        
        print(f'Applicable pricing tier: {applicable_tier}')
        
        # Calculate decoration cost
        decoration_cost = applicable_tier['price'] if applicable_tier else 0
        
        if decoration_type == 'Embroidery' and stitch_count:
            embroidery_result = self.get_embroidery_cost('Shirt', stitch_count)
            decoration_cost = embroidery_result['cost']
            print(f'Embroidery cost: {decoration_cost}')
        
        # Calculate total (simplified)
        avg_base_cost = sum(base_costs.values()) / len(base_costs) if base_costs else 0
        total_cost = (avg_base_cost + decoration_cost) * quantity
        
        return {
            'baseCostPerItem': avg_base_cost,
            'decorationCostPerItem': decoration_cost,
            'quantity': quantity,
            'totalCost': total_cost
        }
    
    def pricing_examples(self):
        """Demonstrate pricing calculations."""
        # DTG pricing for 50 shirts
        dtg_price = self.calculate_order_price('PC61', 'DTG', 50)
        print(f'\nDTG Order (50 units):')
        print(f'  Base cost: ${dtg_price["baseCostPerItem"]:.2f}')
        print(f'  Decoration: ${dtg_price["decorationCostPerItem"]:.2f}')
        print(f'  Total: ${dtg_price["totalCost"]:.2f}')
        
        # Screen print pricing for 100 shirts
        screen_price = self.calculate_order_price('PC61', 'ScreenPrint', 100)
        print(f'\nScreen Print Order (100 units):')
        print(f'  Total: ${screen_price["totalCost"]:.2f}')
        
        # Embroidery pricing for 25 shirts with 5000 stitches
        embroidery_price = self.calculate_order_price('PC61', 'Embroidery', 25, 5000)
        print(f'\nEmbroidery Order (25 units, 5000 stitches):')
        print(f'  Total: ${embroidery_price["totalCost"]:.2f}')
        
        return {
            'dtg': dtg_price,
            'screen': screen_price,
            'embroidery': embroidery_price
        }


# ============================================
# 5. PRODUCT DETAILS AND INVENTORY
# ============================================

def get_product_with_inventory(style_number: str, color: str) -> Dict[str, Any]:
    """Get product details with inventory information."""
    try:
        # Get product details
        details_response = requests.get(
            f'{API_BASE_URL}/product-details',
            params={
                'styleNumber': style_number,
                'color': color
            }
        )
        details_response.raise_for_status()
        product_details = details_response.json()
        
        # Get inventory levels
        inventory_response = requests.get(
            f'{API_BASE_URL}/inventory',
            params={
                'styleNumber': style_number,
                'color': color
            }
        )
        inventory_response.raise_for_status()
        inventory = inventory_response.json()
        
        # Get available sizes
        sizes_response = requests.get(
            f'{API_BASE_URL}/sizes-by-style-color',
            params={
                'styleNumber': style_number,
                'color': color
            }
        )
        sizes_response.raise_for_status()
        sizes = sizes_response.json()
        
        return {
            'product': product_details,
            'inventory': inventory,
            'available_sizes': sizes
        }
        
    except requests.exceptions.RequestException as e:
        print(f'Failed to get product with inventory: {e}')
        raise


# ============================================
# 6. API CLIENT WITH ERROR HANDLING
# ============================================

class APIClient:
    """API client with error handling and convenience methods."""
    
    def __init__(self, base_url: str = API_BASE_URL):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update({'Content-Type': 'application/json'})
    
    def request(self, method: str, endpoint: str, **kwargs) -> Any:
        """Make API request with error handling."""
        url = f'{self.base_url}{endpoint}'
        
        try:
            response = self.session.request(method, url, **kwargs)
            response.raise_for_status()
            
            # Handle empty responses
            if response.text:
                return response.json()
            return {}
            
        except requests.exceptions.HTTPError as e:
            error_msg = f'HTTP {e.response.status_code}: {e.response.reason}'
            try:
                error_data = e.response.json()
                if 'message' in error_data:
                    error_msg = error_data['message']
            except:
                pass
            print(f'API Request failed for {endpoint}: {error_msg}')
            raise
        except requests.exceptions.RequestException as e:
            print(f'API Request failed for {endpoint}: {e}')
            raise
    
    def get(self, endpoint: str, params: Optional[Dict] = None) -> Any:
        """GET request."""
        return self.request('GET', endpoint, params=params)
    
    def post(self, endpoint: str, data: Optional[Dict] = None) -> Any:
        """POST request."""
        return self.request('POST', endpoint, json=data)
    
    def put(self, endpoint: str, data: Optional[Dict] = None) -> Any:
        """PUT request."""
        return self.request('PUT', endpoint, json=data)
    
    def delete(self, endpoint: str) -> Any:
        """DELETE request."""
        return self.request('DELETE', endpoint)


# ============================================
# 7. ART REQUESTS MANAGEMENT
# ============================================

class ArtRequestManager:
    """Manage art requests and invoices."""
    
    def __init__(self, base_url: str = API_BASE_URL):
        self.client = APIClient(base_url)
    
    def get_art_requests(self, **filters) -> List[Dict[str, Any]]:
        """Get art requests with optional filters."""
        return self.client.get('/artrequests', params=filters)
    
    def create_art_request(self, company_name: str, status: str = 'In Progress',
                          **additional_fields) -> Dict[str, Any]:
        """Create a new art request."""
        data = {
            'CompanyName': company_name,
            'Status': status,
            **additional_fields
        }
        return self.client.post('/artrequests', data)
    
    def update_art_request(self, request_id: int, **updates) -> Dict[str, Any]:
        """Update an existing art request."""
        return self.client.put(f'/artrequests/{request_id}', updates)
    
    def art_request_workflow(self):
        """Demonstrate art request workflow."""
        # Get existing requests
        requests = self.get_art_requests(
            status='In Progress',
            limit=5
        )
        print(f'Found {len(requests)} in-progress art requests')
        
        # Create new request
        new_request = self.create_art_request(
            company_name='Test Company',
            status='In Progress',
            CustomerServiceRep='John Doe',
            Priority='High',
            Mockup=True,
            GarmentStyle='PC61',
            GarmentColor='Navy',
            NOTES='Rush order - need by Friday'
        )
        print(f'Created art request ID: {new_request.get("PK_ID")}')
        
        # Update request
        if new_request.get('PK_ID'):
            updated = self.update_art_request(
                new_request['PK_ID'],
                Status='Completed',
                Invoiced=True,
                Invoiced_Date=datetime.now().isoformat()
            )
            print('Updated art request to completed status')
        
        return new_request


# ============================================
# 8. COMPLETE WORKFLOW EXAMPLE
# ============================================

def complete_workflow_example():
    """Demonstrate complete API workflow."""
    api = APIClient()
    
    try:
        print('=== Starting Complete Workflow Example ===\n')
        
        # 1. Search for products
        print('1. Searching for polo shirts...')
        search_results = api.get('/products/search', params={
            'q': 'polo',
            'category': 'Polos',
            'limit': 5
        })
        print(f'Found {len(search_results["products"])} polo products\n')
        
        if not search_results['products']:
            print('No products found, exiting...')
            return
        
        # 2. Get details for first product
        first_product = search_results['products'][0]
        print(f'2. Getting details for: {first_product["style"]}')
        product_details = api.get('/product-details', params={
            'styleNumber': first_product['style'],
            'color': first_product['colors'][0] if first_product['colors'] else 'White'
        })
        print(f'Product: {product_details.get("PRODUCT_TITLE", "Unknown")}\n')
        
        # 3. Check inventory
        print('3. Checking inventory...')
        inventory = api.get('/inventory', params={
            'styleNumber': first_product['style'],
            'color': first_product['colors'][0] if first_product['colors'] else 'White'
        })
        if inventory:
            sizes_available = [f'{item["SIZE"]}: {item.get("QTY_AVAILABLE", 0)}' 
                             for item in inventory]
            print(f'Available sizes: {", ".join(sizes_available)}\n')
        
        # 4. Get pricing
        print('4. Getting pricing information...')
        base_costs = api.get('/base-item-costs', params={
            'styleNumber': first_product['style']
        })
        print(f'Base costs: {base_costs}\n')
        
        # 5. Create cart and add item
        print('5. Creating cart session...')
        cart = CartManager(API_BASE_URL)
        session = cart.create_session()
        print(f'Cart session created: {session["SessionID"]}')
        
        cart_item = cart.add_item(
            '1',
            first_product['style'],
            first_product['colors'][0] if first_product['colors'] else 'White',
            first_product['title']
        )
        print('Added item to cart\n')
        
        # 6. Check production schedule
        print('6. Checking production schedules...')
        schedules = api.get('/production-schedules', params={
            'q.orderBy': 'Date DESC',
            'q.limit': 1
        })
        if schedules:
            latest = schedules[0]
            print('Latest production availability:')
            print(f'  DTG: {latest.get("DTG", "N/A")}')
            print(f'  Screen Print: {latest.get("Screenprint", "N/A")}')
            print(f'  Embroidery: {latest.get("Embroidery", "N/A")}\n')
        
        # 7. Get dashboard metrics
        print('7. Getting order dashboard metrics...')
        dashboard = api.get('/order-dashboard', params={'days': 7})
        summary = dashboard.get('summary', {})
        print('Weekly order summary:')
        print(f'  Total Orders: {summary.get("totalOrders", 0)}')
        print(f'  Total Sales: ${summary.get("totalSales", 0):,.2f}')
        print(f'  Average Order Value: ${summary.get("avgOrderValue", 0):.2f}')
        
        print('\n=== Workflow Complete ===')
        
    except Exception as e:
        print(f'Workflow failed: {e}')


# ============================================
# MAIN EXECUTION
# ============================================

if __name__ == '__main__':
    # Run complete workflow example
    complete_workflow_example()
    
    # Or run individual examples:
    # product_search_examples()
    # cart = CartManager()
    # cart.complete_cart_example()
    # dashboard = OrderDashboard()
    # dashboard.dashboard_examples()
    # pricing = PricingCalculator()
    # pricing.pricing_examples()