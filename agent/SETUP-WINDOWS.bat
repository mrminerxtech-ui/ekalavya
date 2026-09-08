@echo off
title Ekalavya Farm Agent - Windows Setup
color 0B

echo.
echo  ==========================================
echo    EKALAVYA FARM AGENT — Windows Setup
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

:: Install dependencies
echo [1/4] Installing dependencies...
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
    echo [2/4] Creating config file...
    copy .env.example .env
    echo [OK] Config file created: .env
    echo.
    echo ================================================
    echo  IMPORTANT: Edit the .env file before starting
    echo ================================================
    echo.
    echo  Open .env with Notepad and set:
    echo.
    echo  1. MMX_SERVER  = your Railway wss:// URL
    echo  2. AGENT_KEY   = your agent key
    echo  3. FARM_NAME   = name for this farm
    echo  4. LOCAL_SUBNET = your miner network (e.g. 192.168.1.0/24)
    echo.
    echo  To find your subnet, your IP is:
    ipconfig | findstr "IPv4"
    echo  Your subnet is the first 3 numbers + .0/24
    echo.
    notepad .env
    echo.
    echo After saving the .env file, press any key to start the agent.
    pause
) else (
    echo [2/4] Config file already exists
)
echo.

:: Install PM2 for auto-start
echo [3/4] Installing PM2 (background service)...
call npm install -g pm2 >nul 2>&1
call npm install -g pm2-windows-startup >nul 2>&1
echo [OK] PM2 installed
echo.

:: Start agent with PM2
echo [4/4] Starting Ekalavya Farm Agent...
call pm2 delete ekl-agent >nul 2>&1
call pm2 start agent.js --name ekl-agent
call pm2-startup install
call pm2 save

echo.
echo  ==========================================
echo    Ekalavya Agent is running!
echo  ==========================================
echo.
echo  The agent will:
echo   - Auto-start when Windows boots
echo   - Auto-reconnect if internet drops
echo   - Poll your miners every 30 seconds
echo.
echo  Check status:  pm2 status
echo  View logs:     pm2 logs ekl-agent
echo  Stop agent:    pm2 stop ekl-agent
echo.
echo  If connected, the farm appears in your
echo  Ekalavya dashboard under Farm Agents.
echo.
pause
