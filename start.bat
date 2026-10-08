@echo off
rem Double-click to start SyncWave and open it in your browser.
title SyncWave server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
for /f "tokens=2 delims=." %%b in ('node -v') do set NODE_MINOR=%%b
if %NODE_MAJOR% LSS 22 goto oldnode
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 5 goto oldnode

if "%PORT%"=="" set PORT=8080

echo.
echo  SyncWave is starting on http://localhost:%PORT%
echo  Other devices on your Wi-Fi: http://YOUR-PC-IP:%PORT%  (find it with: ipconfig)
echo  Close this window to stop the server.
echo.
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do echo  Your PC's address:%%i
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
node --no-warnings server.js
pause
exit /b 0

:oldnode
echo SyncWave needs Node.js 22.5 or newer. You have:
node -v
echo Get the current LTS version from https://nodejs.org
pause
exit /b 1
