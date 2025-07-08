#!/bin/bash

# This script comments out pricing endpoints in server.js

# Function to comment out an endpoint
comment_endpoint() {
    local endpoint=$1
    local start_line=$2
    local end_line=$3
    local file="server.js"
    
    echo "Commenting out $endpoint (lines $start_line-$end_line)..."
    
    # Add migration comment before the endpoint
    sed -i "${start_line}i\\// MIGRATED to src/routes/pricing.js" "$file"
    
    # Comment out lines
    sed -i "${start_line},${end_line}s/^/\/\/ /" "$file"
}

# Based on the grep results, here are the endpoints to comment:
# Note: These line numbers might shift as we comment out endpoints, so we do them in reverse order

echo "Starting to comment out pricing endpoints..."

# We need to find the exact end lines for each endpoint
# For now, let's use a different approach - comment them one by one manually

echo "Script complete. Please verify the changes."