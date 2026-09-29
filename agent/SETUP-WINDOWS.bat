@echo off
title Ekalavya Farm Agent - Windows Setup
color 0B
:: Always work in this script's own folder (Run as administrator starts in System32)
cd /d "%~dp0"

echo.
echo  ==========================================
echo    EKALAVYA FARM AGENT - Windows Setup
echo  ==========================================
echo.

:: Check Node.js installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo.
    echo Please download and install Node.js from:
    echo   https://nodejs.org
    echo.
    echo Choose the LTS version, run the installer,
    echo then run this script again.
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js found:
node --version
echo.

:: All agent files present?
for %%F in (agent.js update-check.js agent-guard.js) do (
    if not exist "%%F" (
        echo [ERROR] %%F is missing from this folder - download the complete agent folder again.
        pause
        exit /b 1
    )
)

:: Install dependencies
echo [1/5] Installing dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
)
echo [OK] Dependencies installed
echo.

:: No settings file needed: the farm is chosen in the app, and the agent
:: finds this PC's networks itself. An existing .env (PCs set up the old
:: way) is kept and still works.
if exist .env (
    echo [2/5] Keeping the existing .env settings
) else (
    echo [2/5] No settings needed - farm and networks are set in the app
)
echo.

:: Install PM2 for auto-start
echo [3/5] Installing PM2 - background service...
call npm install -g pm2 >nul 2>&1
call npm install -g pm2-windows-startup >nul 2>&1
echo [OK] PM2 installed
echo.

:: Only ONE agent per PC - stop every other copy first
:: (older background agents, agent windows, copies in other folders)
echo [4/5] Making sure no other Ekalavya agent is running on this PC...
node agent-guard.js --stop-others
echo.

:: Start the updater (it runs agent.js and keeps it up to date) with PM2
echo [5/5] Starting Ekalavya Farm Agent...
call pm2 delete ekl-agent >nul 2>&1
call pm2 start update-check.js --name ekl-agent
call pm2-startup install
call pm2 save
echo.
echo Waiting for the agent to start...
timeout /t 10 /nobreak >nul
node agent-guard.js --status

echo.
echo  ==========================================
echo    Ekalavya Agent is running!
echo  ==========================================
echo.
echo  The agent will:
echo   - Auto-start when Windows boots
echo   - Update itself automatically
echo   - Auto-reconnect if internet drops
echo   - Poll your miners every 30 seconds
echo   - Refuse to start a second copy on this PC
echo.
echo  Check status:  pm2 status
echo  View logs:     pm2 logs ekl-agent
echo  Stop agent:    pm2 stop ekl-agent
echo.
echo  Do NOT also open START.bat on this PC - the agent
echo  already runs in the background.
echo.
echo  ------------------------------------------------
echo   LAST STEP - in the Ekalavya app:
echo   Remote Access - New agents - "%COMPUTERNAME%"
echo   - choose its farm, or type a new farm name.
echo   A PC that already had a farm continues by itself.
echo  ------------------------------------------------
echo.
pause
