#!/bin/bash
# Ultra-fast server restart script

echo "⚡ Fast restarting server..."
kill $(lsof -t -i:3002) 2>/dev/null
sleep 0.5
cd "$(dirname "$0")"
exec node start-server.js