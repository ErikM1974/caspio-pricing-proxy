#!/bin/bash
# Start the server and log output
node server.js > server.log 2>&1 &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"
sleep 3
if ps -p $SERVER_PID > /dev/null; then
  echo "Server is running"
  tail -5 server.log
else
  echo "Server failed to start"
  cat server.log
fi