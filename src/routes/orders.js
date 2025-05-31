// Order and customer-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/orders
router.get('/orders', async (req, res) => {
  console.log('GET /api/orders requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.orderID) {
      whereConditions.push(`OrderID=${req.query.orderID}`);
    }
    if (req.query.customerID) {
      whereConditions.push(`CustomerID=${req.query.customerID}`);
    }
    if (req.query.orderStatus) {
      whereConditions.push(`OrderStatus='${req.query.orderStatus}'`);
    }
    if (req.query.paymentStatus) {
      whereConditions.push(`PaymentStatus='${req.query.paymentStatus}'`);
    }
    if (req.query.imprintType) {
      whereConditions.push(`ImprintType='${req.query.imprintType}'`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Orders/records', params);
    console.log(`Orders: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching orders:', error.message);
    res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
  }
});

// POST /api/orders
router.post('/orders', express.json(), async (req, res) => {
  console.log('POST /api/orders requested with body:', req.body);

  try {
    const { CustomerID } = req.body;

    if (!CustomerID) {
      return res.status(400).json({ error: 'CustomerID is required' });
    }

    const orderData = {
      CustomerID,
      OrderNumber: req.body.OrderNumber || `ORD-${Date.now()}`,
      SessionID: req.body.SessionID || null,
      TotalAmount: req.body.TotalAmount || null,
      OrderStatus: req.body.OrderStatus || 'New',
      ImprintType: req.body.ImprintType || null,
      PaymentMethod: req.body.PaymentMethod || null,
      PaymentStatus: req.body.PaymentStatus || 'Pending',
      ShippingMethod: req.body.ShippingMethod || null,
      TrackingNumber: req.body.TrackingNumber || null,
      EstimatedDelivery: req.body.EstimatedDelivery || null,
      Notes: req.body.Notes || null,
      InternalNotes: req.body.InternalNotes || null
    };

    const result = await makeCaspioRequest('post', '/tables/Orders/records', {}, orderData);
    console.log('Order created successfully');
    res.status(201).json({ message: 'Order created successfully', order: result });
  } catch (error) {
    console.error('Error creating order:', error.message);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// PUT /api/orders/:id
router.put('/orders/:id', express.json(), async (req, res) => {
  const orderId = req.params.id;
  console.log(`PUT /api/orders/${orderId} requested with body:`, req.body);

  try {
    const updates = {};
    const allowedFields = [
      'TotalAmount', 'OrderStatus', 'ImprintType', 'PaymentMethod', 
      'PaymentStatus', 'ShippingMethod', 'TrackingNumber', 
      'EstimatedDelivery', 'Notes', 'InternalNotes'
    ];
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Orders/records', 
      { 'q.where': `OrderID=${orderId}` }, 
      updates
    );
    
    console.log('Order updated successfully');
    res.json({ message: 'Order updated successfully', order: result });
  } catch (error) {
    console.error('Error updating order:', error.message);
    res.status(500).json({ error: 'Failed to update order', details: error.message });
  }
});

// DELETE /api/orders/:id
router.delete('/orders/:id', async (req, res) => {
  const orderId = req.params.id;
  console.log(`DELETE /api/orders/${orderId} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Orders/records', 
      { 'q.where': `OrderID=${orderId}` }
    );
    
    console.log('Order deleted successfully');
    res.json({ message: 'Order deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting order:', error.message);
    res.status(500).json({ error: 'Failed to delete order', details: error.message });
  }
});

// GET /api/customers
router.get('/customers', async (req, res) => {
  console.log('GET /api/customers requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.name) {
      whereConditions.push(`Name LIKE '%${req.query.name}%'`);
    }
    if (req.query.email) {
      whereConditions.push(`Email='${req.query.email}'`);
    }
    if (req.query.company) {
      whereConditions.push(`Company LIKE '%${req.query.company}%'`);
    }
    if (req.query.customerID) {
      whereConditions.push(`CustomerID=${req.query.customerID}`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Customer_Info/records', params);
    console.log(`Customers: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching customers:', error.message);
    res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
  }
});

// POST /api/customers
router.post('/customers', express.json(), async (req, res) => {
  console.log('POST /api/customers requested with body:', req.body);

  try {
    const customerData = { ...req.body };

    if (!customerData.Name) {
      if (customerData.FirstName && customerData.LastName) {
        customerData.Name = `${customerData.FirstName} ${customerData.LastName}`;
      } else {
        return res.status(400).json({ error: 'Name is required (or FirstName and LastName)' });
      }
    }

    if (!customerData.Email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await makeCaspioRequest('post', '/tables/Customer_Info/records', {}, customerData);
    console.log('Customer created successfully');
    res.status(201).json({ message: 'Customer created successfully', customer: result });
  } catch (error) {
    console.error('Error creating customer:', error.message);
    res.status(500).json({ error: 'Failed to create customer', details: error.message });
  }
});

// PUT /api/customers/:id
router.put('/customers/:id', express.json(), async (req, res) => {
  const customerId = req.params.id;
  console.log(`PUT /api/customers/${customerId} requested with body:`, req.body);

  try {
    const updates = { ...req.body };
    delete updates.CustomerID;
    delete updates.PK_ID;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Customer_Info/records', 
      { 'q.where': `CustomerID=${customerId}` }, 
      updates
    );
    
    console.log('Customer updated successfully');
    res.json({ message: 'Customer updated successfully', customer: result });
  } catch (error) {
    console.error('Error updating customer:', error.message);
    res.status(500).json({ error: 'Failed to update customer', details: error.message });
  }
});

// DELETE /api/customers/:id
router.delete('/customers/:id', async (req, res) => {
  const customerId = req.params.id;
  console.log(`DELETE /api/customers/${customerId} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Customer_Info/records', 
      { 'q.where': `CustomerID=${customerId}` }
    );
    
    console.log('Customer deleted successfully');
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer:', error.message);
    res.status(500).json({ error: 'Failed to delete customer', details: error.message });
  }
});

module.exports = router;