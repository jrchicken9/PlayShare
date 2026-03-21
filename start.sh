#!/bin/bash
# PlayShare Server Startup Script (Mac / Linux)
echo "Starting PlayShare sync server..."
echo ""
echo "  Local:   ws://localhost:8765"
echo ""
echo "  Share the join link from the extension - the server URL is included automatically."
echo ""
node server.js
