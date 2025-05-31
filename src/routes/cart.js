// Cart-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// Helper function to add product details to cart items
async function addProductDetailsToCartItems(cartItems) {
  if (!cartItems || cartItems.length === 0) {
    return cartItems;
  }

  const styleNumbers = [...new Set(cartItems.map(item => item.StyleNumber))];
  const productDetailsMap = new Map();

  for (const styleNumber of styleNumbers) {
    try {
      const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': `StyleNumber='${styleNumber}'`,
        'q.select': 'StyleNumber, ProductTitle, ImageURL_1',
        'q.limit': 1
      });

      if (records.length > 0) {
        productDetailsMap.set(styleNumber, {
          PRODUCT_TITLE: records[0].ProductTitle || '',
          imageUrl: records[0].ImageURL_1 || ''
        });
      }
    } catch (error) {
      console.error(`Error fetching product details for ${styleNumber}:`, error.message);
    }
  }

  return cartItems.map(item => {
    const details = productDetailsMap.get(item.StyleNumber) || {};
    return {
      ...item,
      ...details
    };
  });
}

// GET /api/cart-sessions
router.get('/cart-sessions', async (req, res) => {
  console.log('GET /api/cart-sessions requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.sessionID) {
      whereConditions.push(`SessionID='${req.query.sessionID}'`);
    }
    if (req.query.userID) {
      whereConditions.push(`UserID=${req.query.userID}`);
    }
    if (req.query.isActive !== undefined) {
      whereConditions.push(`IsActive=${req.query.isActive}`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Cart_Sessions/records', params);
    console.log(`Cart sessions: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching cart sessions:', error.message);
    res.status(500).json({ error: 'Failed to fetch cart sessions', details: error.message });
  }
});

// POST /api/cart-sessions
router.post('/cart-sessions', express.json(), async (req, res) => {
  console.log('POST /api/cart-sessions requested with body:', req.body);

  try {
    const { SessionID, UserID, IPAddress, UserAgent, IsActive } = req.body;

    if (!SessionID) {
      return res.status(400).json({ error: 'SessionID is required' });
    }

    const sessionData = {
      SessionID,
      UserID: UserID || null,
      IPAddress: IPAddress || null,
      UserAgent: UserAgent || null,
      IsActive: IsActive !== undefined ? IsActive : true
    };

    const result = await makeCaspioRequest('post', '/tables/Cart_Sessions/records', {}, sessionData);
    console.log('Cart session created successfully');
    res.status(201).json({ message: 'Cart session created successfully', cartSession: result });
  } catch (error) {
    console.error('Error creating cart session:', error.message);
    res.status(500).json({ error: 'Failed to create cart session', details: error.message });
  }
});

// PUT /api/cart-sessions/:id
router.put('/cart-sessions/:id', express.json(), async (req, res) => {
  const sessionId = req.params.id;
  console.log(`PUT /api/cart-sessions/${sessionId} requested with body:`, req.body);

  try {
    const updates = {};
    const allowedFields = ['UserID', 'IPAddress', 'UserAgent', 'IsActive'];
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Cart_Sessions/records', 
      { 'q.where': `SessionID='${sessionId}'` }, 
      updates
    );
    
    console.log('Cart session updated successfully');
    res.json({ message: 'Cart session updated successfully', cartSession: result });
  } catch (error) {
    console.error('Error updating cart session:', error.message);
    res.status(500).json({ error: 'Failed to update cart session', details: error.message });
  }
});

// DELETE /api/cart-sessions/:id
router.delete('/cart-sessions/:id', async (req, res) => {
  const sessionId = req.params.id;
  console.log(`DELETE /api/cart-sessions/${sessionId} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Cart_Sessions/records', 
      { 'q.where': `SessionID='${sessionId}'` }
    );
    
    console.log('Cart session deleted successfully');
    res.json({ message: 'Cart session deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting cart session:', error.message);
    res.status(500).json({ error: 'Failed to delete cart session', details: error.message });
  }
});

// GET /api/cart-items
router.get('/cart-items', async (req, res) => {
  console.log('GET /api/cart-items requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.sessionID) {
      whereConditions.push(`SessionID='${req.query.sessionID}'`);
    }
    if (req.query.productID) {
      whereConditions.push(`ProductID='${req.query.productID}'`);
    }
    if (req.query.styleNumber) {
      whereConditions.push(`STYLE='${req.query.styleNumber}'`);
    }
    if (req.query.color) {
      whereConditions.push(`COLOR_NAME='${req.query.color}'`);
    }
    if (req.query.cartStatus) {
      whereConditions.push(`CartStatus='${req.query.cartStatus}'`);
    }
    if (req.query.orderID) {
      whereConditions.push(`OrderID=${req.query.orderID}`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Cart_Items/records', params);
    const recordsWithDetails = await addProductDetailsToCartItems(records);
    
    console.log(`Cart items: ${recordsWithDetails.length} record(s) found`);
    res.json(recordsWithDetails);
  } catch (error) {
    console.error('Error fetching cart items:', error.message);
    res.status(500).json({ error: 'Failed to fetch cart items', details: error.message });
  }
});

// POST /api/cart-items
router.post('/cart-items', express.json(), async (req, res) => {
  console.log('POST /api/cart-items requested with body:', req.body);

  try {
    const { SessionID, ProductID, StyleNumber, Color, ImprintType, CartStatus, OrderID } = req.body;

    if (!SessionID || !ProductID || !StyleNumber || !Color) {
      return res.status(400).json({ 
        error: 'SessionID, ProductID, StyleNumber, and Color are required' 
      });
    }

    const cartItemData = {
      SessionID,
      ProductID,
      STYLE: StyleNumber,
      COLOR_NAME: Color,
      ImprintType: ImprintType || null,
      CartStatus: CartStatus || 'Active',
      OrderID: OrderID || null
    };

    const result = await makeCaspioRequest('post', '/tables/Cart_Items/records', {}, cartItemData);
    console.log('Cart item created successfully');
    res.status(201).json({ message: 'Cart item created successfully', cartItem: result });
  } catch (error) {
    console.error('Error creating cart item:', error.message);
    res.status(500).json({ error: 'Failed to create cart item', details: error.message });
  }
});

// PUT /api/cart-items/:id
router.put('/cart-items/:id', express.json(), async (req, res) => {
  const cartItemId = req.params.id;
  console.log(`PUT /api/cart-items/${cartItemId} requested with body:`, req.body);

  try {
    const updates = {};
    const allowedFields = ['COLOR_NAME', 'ImprintType', 'CartStatus', 'OrderID'];
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Cart_Items/records', 
      { 'q.where': `CartItemID=${cartItemId}` }, 
      updates
    );
    
    console.log('Cart item updated successfully');
    res.json({ message: 'Cart item updated successfully', cartItem: result });
  } catch (error) {
    console.error('Error updating cart item:', error.message);
    res.status(500).json({ error: 'Failed to update cart item', details: error.message });
  }
});

// DELETE /api/cart-items/:id
router.delete('/cart-items/:id', async (req, res) => {
  const cartItemId = req.params.id;
  console.log(`DELETE /api/cart-items/${cartItemId} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Cart_Items/records', 
      { 'q.where': `CartItemID=${cartItemId}` }
    );
    
    console.log('Cart item deleted successfully');
    res.json({ message: 'Cart item deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting cart item:', error.message);
    res.status(500).json({ error: 'Failed to delete cart item', details: error.message });
  }
});

// GET /api/cart-item-sizes
router.get('/cart-item-sizes', async (req, res) => {
  console.log('GET /api/cart-item-sizes requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.cartItemID) {
      whereConditions.push(`CartItemID=${req.query.cartItemID}`);
    }
    if (req.query.size) {
      whereConditions.push(`Size='${req.query.size}'`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Cart_Item_Sizes/records', params);
    console.log(`Cart item sizes: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching cart item sizes:', error.message);
    res.status(500).json({ error: 'Failed to fetch cart item sizes', details: error.message });
  }
});

// POST /api/cart-item-sizes
router.post('/cart-item-sizes', express.json(), async (req, res) => {
  console.log('POST /api/cart-item-sizes requested with body:', req.body);

  try {
    const { CartItemID, Size, Quantity, UnitPrice } = req.body;

    if (!CartItemID || !Size || !Quantity) {
      return res.status(400).json({ 
        error: 'CartItemID, Size, and Quantity are required' 
      });
    }

    const sizeData = {
      CartItemID,
      Size,
      Quantity,
      UnitPrice: UnitPrice || null
    };

    const result = await makeCaspioRequest('post', '/tables/Cart_Item_Sizes/records', {}, sizeData);
    console.log('Cart item size created successfully');
    res.status(201).json({ message: 'Cart item size created successfully', cartItemSize: result });
  } catch (error) {
    console.error('Error creating cart item size:', error.message);
    res.status(500).json({ error: 'Failed to create cart item size', details: error.message });
  }
});

// PUT /api/cart-item-sizes/:id
router.put('/cart-item-sizes/:id', express.json(), async (req, res) => {
  const sizeItemId = req.params.id;
  console.log(`PUT /api/cart-item-sizes/${sizeItemId} requested with body:`, req.body);

  try {
    const updates = {};
    const allowedFields = ['Size', 'Quantity', 'UnitPrice'];
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Cart_Item_Sizes/records', 
      { 'q.where': `SizeItemID=${sizeItemId}` }, 
      updates
    );
    
    console.log('Cart item size updated successfully');
    res.json({ message: 'Cart item size updated successfully', cartItemSize: result });
  } catch (error) {
    console.error('Error updating cart item size:', error.message);
    res.status(500).json({ error: 'Failed to update cart item size', details: error.message });
  }
});

// DELETE /api/cart-item-sizes/:id
router.delete('/cart-item-sizes/:id', async (req, res) => {
  const sizeItemId = req.params.id;
  console.log(`DELETE /api/cart-item-sizes/${sizeItemId} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Cart_Item_Sizes/records', 
      { 'q.where': `SizeItemID=${sizeItemId}` }
    );
    
    console.log('Cart item size deleted successfully');
    res.json({ message: 'Cart item size deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting cart item size:', error.message);
    res.status(500).json({ error: 'Failed to delete cart item size', details: error.message });
  }
});

// POST /api/process-checkout
router.post('/process-checkout', express.json(), async (req, res) => {
  console.log('POST /api/process-checkout requested with body:', req.body);

  try {
    const { sessionId, customerId } = req.body;

    if (!sessionId || !customerId) {
      return res.status(400).json({ error: 'sessionId and customerId are required' });
    }

    const cartItems = await fetchAllCaspioPages('/tables/Cart_Items/records', {
      'q.where': `SessionID='${sessionId}' AND CartStatus='Active'`
    });

    if (cartItems.length === 0) {
      return res.status(404).json({ error: 'No active cart items found for this session' });
    }

    const orderId = 'ORD-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    
    const orderData = {
      CustomerID: customerId,
      OrderNumber: orderId,
      SessionID: sessionId,
      OrderStatus: 'New',
      PaymentStatus: 'Pending'
    };

    const orderResult = await makeCaspioRequest('post', '/tables/Orders/records', {}, orderData);
    
    console.log('Order created successfully:', orderId);
    res.status(201).json({
      success: true,
      message: 'Checkout processed successfully',
      orderId: orderId,
      order: orderResult
    });
  } catch (error) {
    console.error('Error processing checkout:', error.message);
    res.status(500).json({ error: 'Failed to process checkout', details: error.message });
  }
});

module.exports = router;