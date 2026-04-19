@echo off
echo =====================================================
echo   EduVault Backend - Setup Script
echo =====================================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed!
    echo.
    echo Please install Node.js first:
    echo   1. Run the installer: C:\Users\%USERNAME%\Downloads\node-v24.14.1-x64.msi
    echo   OR download from: https://nodejs.org/en/download
    echo   2. IMPORTANT: Restart your terminal after installing!
    echo   3. Run this script again.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found: 
node --version

echo.
echo Installing backend dependencies...
npm install

IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo [OK] Dependencies installed!
echo.
echo =====================================================
echo   Starting EduVault Backend Server...
echo =====================================================
echo.
echo The server will start at: http://localhost:3001
echo Health check: http://localhost:3001/api/health
echo.
echo IMPORTANT: Keep this window open while using the app!
echo Press Ctrl+C to stop the server.
echo.
npm start
