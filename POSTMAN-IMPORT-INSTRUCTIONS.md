# Caspio Pricing Proxy - Postman Collection

This repository includes a Postman collection file (`caspio-pricing-proxy-postman-collection.json`) that contains all the API endpoints for the Caspio Pricing Proxy application deployed on Heroku.

## How to Import the Collection into Postman

1. **Open Postman**: Launch the Postman application on your computer.

2. **Import the Collection**:
   - Click on the "Import" button in the top left corner of the Postman interface.
   - In the Import dialog, select the "File" tab.
   - Click "Upload Files" and select the `caspio-pricing-proxy-postman-collection.json` file.
   - Click "Import" to complete the process.

3. **Using the Collection**:
   - The collection will appear in your Postman Collections sidebar.
   - Expand the collection to see all the available API endpoints.
   - Each endpoint is pre-configured with the correct URL and query parameters.
   - You can click on any endpoint to view its details and send a request.

## Available Endpoints

The collection includes the following endpoints:

- **Status**: Simple status check to verify the API is running.
- **Pricing Tiers**: Get pricing tiers for different decoration methods (DTG, ScreenPrint, Embroidery).
- **Embroidery Costs**: Get embroidery costs based on item type and stitch count.
- **DTG Costs**: Get all DTG costs by print location and tier.
- **Screenprint Costs**: Get screenprint costs for primary and additional locations.
- **Pricing Rules**: Get pricing rules for different decoration methods.
- **Base Item Costs**: Get base item costs (max case price per size) for a specific style.
- **Test Sanmar Bulk**: Test endpoint for the Sanmar_Bulk table.
- **Style Search Autocomplete**: Search for styles by partial style number.
- **Product Details**: Get product details including title, description, and images.
- **Color Swatches**: Get color swatches for a specific style.
- **All Inventory Fields**: Get all fields from the Inventory table for a specific style.

## Base URL

All endpoints use the following base URL:
```
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
```

You can update this URL in the collection variables if the application URL changes in the future.