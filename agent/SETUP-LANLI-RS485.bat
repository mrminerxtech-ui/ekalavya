@echo off
title Ekalavya — Lanli RS485 Setup
color 0B
echo.
echo  ==========================================
echo    LANLI HYDRO RS485 SETUP
echo  ==========================================
echo.
echo  Requirements:
echo   1. USB-RS485 adapter plugged into this PC
echo   2. A+ wire connected to Lanli cabinet A+
echo   3. B- wire connected to Lanli cabinet B-
echo   4. All 3 cabinets on same RS485 bus (daisy chain)
echo.
echo  Step 1: Finding your COM port...
echo.
mode
echo.
echo  Look above for "COM3" or "COM4" etc.
echo  That is your USB-RS485 adapter port.
echo.
echo  Step 2: Installing Modbus library...
cd /d "%~dp0"
call npm install modbus-serial
echo.
echo  Step 3: Update your .env file with:
echo.
echo    LANLI_RS485_PORT=COM3    (use your actual COM port)
echo    LANLI_BAUD=9600
echo    LANLI_SLAVE_IDS=1,2,3
echo    LANLI_NAMES=MY16-542,1to1-535,1to1-288
echo.
echo  Step 4: Slave ID settings on each Lanli cabinet:
echo    Cabinet 1 (MY16-542):  Slave ID = 1
echo    Cabinet 2 (1to1-535):  Slave ID = 2
echo    Cabinet 3 (1to1-288):  Slave ID = 3
echo.
echo  Set slave IDs using the buttons on the cabinet display.
echo.
echo  Step 5: To enable HMI screen sharing (optional):
echo    LANLI_HMI_ENABLED=true
echo    (This PC must be running the Lanli SCADA software)
echo.
echo  After updating .env, restart the agent:
echo    pm2 restart ekl-agent
echo.
pause
