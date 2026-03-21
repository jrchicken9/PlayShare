@echo off
echo Starting PlayShare sync server...
echo.
echo   Local:   ws://localhost:8765
echo.
echo   Share the join link from the extension - the server URL is included automatically.
echo   If Windows Firewall prompts, allow Node.js for private networks.
echo.
node server.js
pause
