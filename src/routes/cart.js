// Cart-related routes - Restored from original implementation

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const config = require('../config');

// GET /api/cart-sessions
router.get('/cart-sessions', async (req, res) => {
    try {
        console.log("Fetching cart sessions information");
        const resource = '/tables/Cart_Sessions/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.sessionID) {
                whereConditions.push(`SessionID='${req.query.sessionID}'`);
            }
            if (req.query.userID) {
                whereConditions.push(`UserID=${req.query.userID}`);
            }
            if (req.query.isActive !== undefined) {
                whereConditions.push(`IsActive=${req.query.isActive}`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'PK_ID ASC';
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} cart session records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching cart sessions information:", error.message);
        res.status(500).json({ error: 'Failed to fetch cart sessions information.' });
    }
});

// POST /api/cart-sessions
router.post('/cart-sessions', express.json(), async (req, res) => {
    try {
        // Validate required fields
        const requiredFields = ['SessionID'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        // Create a new object with only the allowed fields
        const cartSessionData = {
            SessionID: req.body.SessionID,
            UserID: req.body.UserID ? Number(req.body.UserID) : null,
            IPAddress: req.body.IPAddress || null,
            UserAgent: req.body.UserAgent || null,
            IsActive: req.body.IsActive === true
        };
        
        console.log(`Creating new cart session: ${cartSessionData.SessionID}`);
        const resource = '/tables/Cart_Sessions/records';
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartSessionData,
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        console.log(`Cart session created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Cart session created successfully',
            cartSession: response.data
        });
    } catch (error) {
        console.error("Error creating cart session:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create cart session.' });
    }
});

// PUT /api/cart-sessions/:id
router.put('/cart-sessions/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating cart session with ID: ${id}`);
        const resource = `/tables/Cart_Sessions/records?q.where=SessionID='${id}'`;
        
        const cartSessionData = {};
        
        if (req.body.SessionID !== undefined) cartSessionData.SessionID = req.body.SessionID;
        if (req.body.UserID !== undefined) cartSessionData.UserID = req.body.UserID;
        if (req.body.LastActivity !== undefined) cartSessionData.LastActivity = req.body.LastActivity;
        if (req.body.IPAddress !== undefined) cartSessionData.IPAddress = req.body.IPAddress;
        if (req.body.UserAgent !== undefined) cartSessionData.UserAgent = req.body.UserAgent;
        if (req.body.IsActive !== undefined) cartSessionData.IsActive = req.body.IsActive;
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartSessionData,
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        console.log(`Cart session updated successfully: ${response.status}`);
        res.json({
            message: 'Cart session updated successfully',
            cartSession: response.data
        });
    } catch (error) {
        console.error("Error updating cart session:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update cart session.' });
    }
});

// DELETE /api/cart-sessions/:id
router.delete('/cart-sessions/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting cart session with ID: ${id}`);
        const resource = `/tables/Cart_Sessions/records?q.where=SessionID='${id}'`;
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        console.log(`Cart session deleted successfully: ${response.status}`);
        res.json({
            message: 'Cart session deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting cart session:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete cart session.' });
    }
});

// GET /api/cart-items
router.get('/cart-items', async (req, res) => {
    try {
        console.log("Fetching cart items information");
        const resource = '/tables/Cart_Items/records';
        
        const params = {};
        
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            if (req.query.sessionID) {
                whereConditions.push(`SessionID='${req.query.sessionID}'`);
            }
            if (req.query.productID) {
                whereConditions.push(`ProductID='${req.query.productID}'`);
            }
            if (req.query.styleNumber) {
                whereConditions.push(`StyleNumber='${req.query.styleNumber}'`);
            }
            if (req.query.color) {
                whereConditions.push(`Color='${req.query.color}'`);
            }
            if (req.query.cartStatus) {
                whereConditions.push(`CartStatus='${req.query.cartStatus}'`);
            }
            if (req.query.orderID) {
                whereConditions.push(`OrderID=${req.query.orderID}`);
            }
            
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        params['q.orderby'] = 'CartItemID ASC';
        params['q.limit'] = 1000;
        
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} cart item records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching cart items information:", error.message);
        res.status(500).json({ error: 'Failed to fetch cart items information.' });
    }
});

// POST /api/cart-items
router.post('/cart-items', express.json(), async (req, res) => {
    try {
        const requiredFields = ['SessionID', 'ProductID', 'StyleNumber', 'Color'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        const cartItemData = {
            SessionID: req.body.SessionID,
            ProductID: req.body.ProductID,
            StyleNumber: req.body.StyleNumber,
            Color: req.body.Color,
            PRODUCT_TITLE: req.body.PRODUCT_TITLE || null,
            ImprintType: req.body.ImprintType || null,
            CartStatus: req.body.CartStatus || 'Active',
            OrderID: req.body.OrderID || null,
            imageUrl: req.body.imageUrl || null
        };
        
        console.log(`Creating new cart item for product: ${cartItemData.ProductID}, style: ${cartItemData.StyleNumber}`);
        const resource = '/tables/Cart_Items/records';
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemData,
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        console.log(`Cart item created successfully: ${response.status}`);
        
        let cartItem = {};
        if (response.data && response.data.Result && Array.isArray(response.data.Result) && response.data.Result.length > 0) {
            cartItem = response.data.Result[0];
        } else if (response.data && response.data.Result) {
            cartItem = response.data.Result;
        } else if (response.data) {
            cartItem = response.data;
        }
        
        // If no CartItemID, fetch complete record
        if (!cartItem.CartItemID) {
            try {
                const pkId = cartItem.PK_ID || cartItem.pk_id;
                if (pkId) {
                    const fetchResource = `/tables/Cart_Items/records?q.where=PK_ID=${pkId}`;
                    const fetchUrl = `${config.caspio.apiBaseUrl}${fetchResource}`;
                    
                    const fetchConfig = {
                        method: 'get',
                        url: fetchUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15000
                    };
                    
                    const fetchResponse = await axios(fetchConfig);
                    if (fetchResponse.data && fetchResponse.data.Result && Array.isArray(fetchResponse.data.Result) && fetchResponse.data.Result.length > 0) {
                        cartItem = fetchResponse.data.Result[0];
                    }
                }
            } catch (fetchError) {
                console.error("Error fetching complete cart item record:", fetchError.message);
            }
        }
        
        const formattedCartItem = {
            CartItemID: cartItem.CartItemID || cartItem.PK_ID || null,
            SessionID: cartItem.SessionID || req.body.SessionID,
            ProductID: cartItem.ProductID || req.body.ProductID,
            StyleNumber: cartItem.StyleNumber || req.body.StyleNumber,
            Color: cartItem.Color || req.body.Color,
            PRODUCT_TITLE: cartItem.PRODUCT_TITLE || req.body.PRODUCT_TITLE || null,
            ImprintType: cartItem.ImprintType || req.body.ImprintType || null,
            CartStatus: cartItem.CartStatus || req.body.CartStatus || 'Active',
            OrderID: cartItem.OrderID || req.body.OrderID || null,
            DateAdded: cartItem.DateAdded || new Date().toISOString(),
            imageUrl: cartItem.imageUrl || req.body.imageUrl || null
        };
        
        res.status(201).json({
            message: 'Cart item created successfully',
            cartItem: formattedCartItem
        });
    } catch (error) {
        console.error("Error creating cart item:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create cart item.' });
    }
});

// PUT /api/cart-items/:id
router.put('/cart-items/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating cart item with ID: ${id}`);
        
        // First find by CartItemID
        const checkResource = '/tables/Cart_Items/records';
        const checkParams = {
            'q.where': `CartItemID=${id}`,
            'q.select': 'PK_ID,CartItemID,SessionID,ProductID,StyleNumber,Color,CartStatus,OrderID',
            'q.limit': 1
        };
        
        const token = await getCaspioAccessToken();
        const checkResult = await fetchAllCaspioPages(checkResource, checkParams);
        
        if (!checkResult || checkResult.length === 0) {
            return res.status(404).json({ error: `Cart item with ID ${id} not found` });
        }
        
        const pkId = checkResult[0].PK_ID;
        
        const cartItemData = {};
        if (req.body.SessionID !== undefined) cartItemData.SessionID = req.body.SessionID;
        if (req.body.ProductID !== undefined) cartItemData.ProductID = req.body.ProductID;
        if (req.body.StyleNumber !== undefined) cartItemData.StyleNumber = req.body.StyleNumber;
        if (req.body.Color !== undefined) cartItemData.Color = req.body.Color;
        if (req.body.PRODUCT_TITLE !== undefined) cartItemData.PRODUCT_TITLE = req.body.PRODUCT_TITLE;
        if (req.body.ImprintType !== undefined) cartItemData.ImprintType = req.body.ImprintType;
        if (req.body.CartStatus !== undefined) cartItemData.CartStatus = req.body.CartStatus;
        if (req.body.OrderID !== undefined) cartItemData.OrderID = req.body.OrderID;
        if (req.body.imageUrl !== undefined) cartItemData.imageUrl = req.body.imageUrl;
        
        const resource = `/tables/Cart_Items/records?q.where=PK_ID=${pkId}`;
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemData,
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        res.json({
            message: 'Cart item updated successfully',
            cartItem: response.data
        });
    } catch (error) {
        console.error("Error updating cart item:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update cart item.' });
    }
});

// DELETE /api/cart-items/:id
router.delete('/cart-items/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting cart item with ID: ${id}`);
        const resource = `/tables/Cart_Items/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        res.json({
            message: 'Cart item deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting cart item:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete cart item.' });
    }
});

// GET /api/cart-item-sizes
router.get('/cart-item-sizes', async (req, res) => {
    try {
        console.log("Fetching cart item sizes information");
        const resource = '/tables/Cart_Item_Sizes/records';
        
        const params = {};
        
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            const cartItemID = req.query.cartItemID || req.query.CartItemID || req.query.cartitemid;
            if (cartItemID) {
                whereConditions.push(`CartItemID=${cartItemID}`);
            }
            
            if (req.query.size) {
                whereConditions.push(`Size='${req.query.size}'`);
            }
            
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        params['q.orderby'] = 'SizeItemID ASC';
        params['q.limit'] = 1000;
        
        const result = await fetchAllCaspioPages(resource, params, { maxPages: 20 });
        console.log(`Found ${result.length} cart item size records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching cart item sizes information:", error.message);
        res.status(500).json({ error: 'Failed to fetch cart item sizes information.' });
    }
});

// POST /api/cart-item-sizes
router.post('/cart-item-sizes', express.json(), async (req, res) => {
    try {
        const requiredFields = ['CartItemID', 'Size', 'Quantity'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        const cartItemSizeData = {
            CartItemID: req.body.CartItemID,
            Size: req.body.Size,
            Quantity: req.body.Quantity,
            UnitPrice: req.body.UnitPrice || null
        };
        
        console.log(`Creating new cart item size for cart item: ${cartItemSizeData.CartItemID}, size: ${cartItemSizeData.Size}`);
        const resource = '/tables/Cart_Item_Sizes/records';
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemSizeData,
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        let cartItemSize = {};
        if (response.data && response.data.Result && Array.isArray(response.data.Result) && response.data.Result.length > 0) {
            cartItemSize = response.data.Result[0];
        } else if (response.data && response.data.Result) {
            cartItemSize = response.data.Result;
        } else if (response.data) {
            cartItemSize = response.data;
        }
        
        const formattedCartItemSize = {
            SizeItemID: cartItemSize.SizeItemID || cartItemSize.PK_ID || null,
            CartItemID: cartItemSize.CartItemID || req.body.CartItemID,
            Size: cartItemSize.Size || req.body.Size,
            Quantity: cartItemSize.Quantity || parseInt(req.body.Quantity, 10) || 0,
            UnitPrice: cartItemSize.UnitPrice || req.body.UnitPrice || null
        };
        
        res.status(201).json({
            message: 'Cart item size created successfully',
            cartItemSize: formattedCartItemSize
        });
    } catch (error) {
        console.error("Error creating cart item size:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create cart item size.' });
    }
});

// PUT /api/cart-item-sizes/:id
router.put('/cart-item-sizes/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        const resource = `/tables/Cart_Item_Sizes/records?q.where=PK_ID=${id}`;
        
        const cartItemSizeData = {};
        if (req.body.CartItemID !== undefined) cartItemSizeData.CartItemID = req.body.CartItemID;
        if (req.body.Size !== undefined) cartItemSizeData.Size = req.body.Size;
        if (req.body.Quantity !== undefined) cartItemSizeData.Quantity = req.body.Quantity;
        if (req.body.UnitPrice !== undefined) cartItemSizeData.UnitPrice = req.body.UnitPrice;
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemSizeData,
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        res.json({
            message: 'Cart item size updated successfully',
            cartItemSize: response.data
        });
    } catch (error) {
        console.error("Error updating cart item size:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update cart item size.' });
    }
});

// DELETE /api/cart-item-sizes/:id
router.delete('/cart-item-sizes/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        const resource = `/tables/Cart_Item_Sizes/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}${resource}`;
        
        const config_req = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        const response = await axios(config_req);
        
        res.json({
            message: 'Cart item size deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting cart item size:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete cart item size.' });
    }
});

module.exports = router;