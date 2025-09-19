#!/bin/bash

# Get a fresh token
TOKEN=$(curl -s -X POST "https://c3eku948.caspio.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CASPIO_CLIENT_ID" \
  -d "client_secret=$CASPIO_CLIENT_SECRET" | python3 -c "import sys, json; print(json.load(sys.stdin)['access_token'])")

echo "Token obtained: ${TOKEN:0:20}..."

# Upload file directly to Caspio
echo "Uploading directly to Caspio..."
curl -X 'POST' \
  'https://c3eku948.caspio.com/rest/v3/files?externalKey=b91133c3-4413-4cb9-8337-444c730754dd' \
  -H 'accept: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: multipart/form-data' \
  -F 'Files=@/mnt/c/Users/erik/Downloads/Kingfisher Charters Embroidered Cap Catalog Image.png;type=image/png' \
  -s | python3 -m json.tool
