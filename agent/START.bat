@echo off
title Ekalavya Farm Agent
color 0B
cd /d "%~dp0"

:: One agent per PC - don't start a second copy
node agent-guard.js --status >nul 2>&1
if not errorlevel 1 (
    echo.
    echo  An Ekalavya agent is already running on this PC:
    echo.
    node agent-guard.js --status
    echo.
    echo  Nothing to start. If it runs in the background, see its log with:
    echo    pm2 logs ekl-agent
    echo.
    pause
    exit /b 0
)

echo Starting Ekalavya Farm Agent - with auto-update...
node update-check.js
pause
