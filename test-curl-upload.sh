#!/bin/bash

# Test file upload using curl (similar to Swagger)
echo "Testing file upload to our API endpoint..."
echo "File: Kingfisher Charters Embroidered Cap Catalog Image.png"
echo ""

# Upload the file
curl -X POST \
  'http://localhost:3002/api/files/upload' \
  -H 'accept: application/json' \
  -H 'Content-Type: multipart/form-data' \
  -F 'file=@/mnt/c/Users/erik/Downloads/Kingfisher Charters Embroidered Cap Catalog Image.png;type=image/png' \
  -s | jq .

echo ""
echo "Upload complete!"