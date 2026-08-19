@echo off
title Try and Learn - local server (keep this window open)
cd /d "%~dp0"

echo.
echo   Try and Learn
echo   Starting the local server... it will open in your browser.
echo   KEEP THIS WINDOW OPEN while you chat. Press Ctrl+C to stop.
echo.

start "" http://127.0.0.1:8000/
python server.py

echo.
echo   The server has stopped.
pause
