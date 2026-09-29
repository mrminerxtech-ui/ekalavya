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

:: Create .env if not exists
if not exist .env (
    echo [2/5] Creating config file...
    copy .env.example .env >nul
    echo [OK] Config file created: .env
    echo.
    echo ================================================
    echo  IMPORTANT: Edit the .env file before starting
    echo ================================================
    echo.
    echo  Open .env with Notepad and set:
    echo.
    echo  1. MMX_SERVER   = your Railway wss:// URL
    echo  2. AGENT_KEY    = your agent key
    echo  3. FARM_ID      = this farm's ID - must match the app, e.g. Farm_1^&2 for Harz Hydro
    echo  4. FARM_NAME    = name for this farm
    echo  5. LOCAL_SUBNET = your miner network, e.g. 192.168.1.0/24
    echo.
    echo  To find your subnet, your IP is:
    ipconfig | findstr "IPv4"
    echo  Your subnet is the first 3 numbers + .0/24
    echo.
    notepad .env
    echo.
    echo After saving the .env file, press any key to continue.
    pause
) else (
    echo [2/5] Config file already exists
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
echo  If connected, the farm appears in your
echo  Ekalavya dashboard under Farm Agents.
echo.
pause
