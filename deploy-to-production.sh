#!/bin/bash

echo "Deploying Screen Print API fix to production..."
echo "============================================="

# Ensure we're in the right directory
cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy

# Show current status
echo "Current branch:"
git branch --show-current
echo ""

# Push develop to GitHub
echo "Step 1: Pushing develop branch to GitHub..."
git push origin develop

# Switch to main
echo ""
echo "Step 2: Switching to main branch..."
git checkout main

# Merge develop into main
echo ""
echo "Step 3: Merging develop into main..."
git merge develop

# Push main to GitHub
echo ""
echo "Step 4: Pushing main to GitHub..."
git push origin main

# Push to Heroku
echo ""
echo "Step 5: Deploying to Heroku..."
git push heroku main

echo ""
echo "Deployment complete!"
echo "The Screen Print API now returns complete JSON structure for all cases."