#!/bin/bash

# Emergency Rollback Script for Endpoint Migration
# 
# Usage:
#   ./emergency-rollback.sh          # Interactive rollback
#   ./emergency-rollback.sh quick    # Quick rollback to last commit
#   ./emergency-rollback.sh [hash]   # Rollback to specific commit

echo "🚨 EMERGENCY ROLLBACK SCRIPT"
echo "============================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to stop the server
stop_server() {
    echo -e "${YELLOW}Stopping server...${NC}"
    pkill -f "node.*server.js" || true
    sleep 2
}

# Function to start the server
start_server() {
    echo -e "${YELLOW}Starting server...${NC}"
    PORT=3002 node start-server.js &
    sleep 5
    
    # Test if server is running
    if curl -s http://localhost:3002/api/health > /dev/null; then
        echo -e "${GREEN}✅ Server started successfully${NC}"
    else
        echo -e "${RED}❌ Server failed to start!${NC}"
        exit 1
    fi
}

# Function to test critical endpoints
test_critical() {
    echo -e "\n${YELLOW}Testing critical endpoints...${NC}"
    
    # Test staff announcements
    if curl -s http://localhost:3002/api/staff-announcements | grep -q "PK_ID"; then
        echo -e "${GREEN}✅ Staff announcements working${NC}"
    else
        echo -e "${RED}❌ Staff announcements FAILED${NC}"
    fi
    
    # Test order dashboard
    if curl -s http://localhost:3002/api/order-dashboard | grep -q "totalOrders"; then
        echo -e "${GREEN}✅ Order dashboard working${NC}"
    else
        echo -e "${RED}❌ Order dashboard FAILED${NC}"
    fi
}

# Main rollback logic
if [ "$1" == "quick" ]; then
    # Quick rollback to last commit
    echo -e "${YELLOW}Performing quick rollback to last commit...${NC}"
    stop_server
    git reset --hard HEAD~1
    start_server
    test_critical
    
elif [ ! -z "$1" ]; then
    # Rollback to specific commit
    echo -e "${YELLOW}Rolling back to commit: $1${NC}"
    stop_server
    git reset --hard $1
    start_server
    test_critical
    
else
    # Interactive rollback
    echo -e "${YELLOW}Recent commits:${NC}"
    git log --oneline -10
    
    echo -e "\n${YELLOW}Options:${NC}"
    echo "1) Rollback to last commit"
    echo "2) Rollback to before migration started"
    echo "3) Rollback to specific commit"
    echo "4) Just restart server (no rollback)"
    echo "5) Exit"
    
    read -p "Choose option (1-5): " choice
    
    case $choice in
        1)
            stop_server
            git reset --hard HEAD~1
            start_server
            test_critical
            ;;
        2)
            # Find commit before migration
            BEFORE_MIGRATION=$(git log --grep="migration:" --inverse-grep --oneline -1 | awk '{print $1}')
            if [ ! -z "$BEFORE_MIGRATION" ]; then
                echo -e "${YELLOW}Rolling back to: $BEFORE_MIGRATION${NC}"
                stop_server
                git reset --hard $BEFORE_MIGRATION
                start_server
                test_critical
            else
                echo -e "${RED}Could not find pre-migration commit${NC}"
            fi
            ;;
        3)
            read -p "Enter commit hash: " hash
            stop_server
            git reset --hard $hash
            start_server
            test_critical
            ;;
        4)
            stop_server
            start_server
            test_critical
            ;;
        5)
            echo "Exiting without changes"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid option${NC}"
            exit 1
            ;;
    esac
fi

echo -e "\n${GREEN}Rollback complete!${NC}"
echo -e "${YELLOW}Current commit:${NC}"
git log --oneline -1

# Show current server status
echo -e "\n${YELLOW}Server Status:${NC}"
ps aux | grep "node.*server.js" | grep -v grep || echo -e "${RED}Server not running${NC}"

echo -e "\n${YELLOW}Next steps:${NC}"
echo "1. Check the dashboard at your website"
echo "2. Review server logs: tail -f server.log"
echo "3. Run full tests: node test-all-endpoints-before-migration.js"