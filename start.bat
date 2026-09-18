@echo off
setlocal enabledelayedexpansion
title Text-to-Video + Prompt Ideas
cd /d "%~dp0"

echo ============================================
echo   Text-to-Video  +  Prompt Ideas - Startup
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node 20+ from https://nodejs.org and try again.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo [0/4] Node !NODEVER!

if not exist "node_modules" (
  echo [1/4] Installing root dependencies...
  call npm install
  if errorlevel 1 goto :installfail
) else (
  echo [1/4] Root dependencies already installed.
)

if not exist "backend\node_modules" (
  echo [2/4] Installing backend dependencies...
  call npm install --prefix backend
  if errorlevel 1 goto :installfail
) else (
  echo [2/4] Backend dependencies already installed.
)

if not exist "frontend\node_modules" (
  echo [3/4] Installing frontend dependencies... ^(this can take a few minutes^)
  call npm install --prefix frontend
  if errorlevel 1 goto :installfail
) else (
  echo [3/4] Frontend dependencies already installed.
)

if not exist "backend\.env" (
  echo [!] backend\.env not found - creating it from .env.example
  copy "backend\.env.example" "backend\.env" >nul
)

findstr /C:"AGNES_API_KEY=your_key_here" "backend\.env" >nul
if not errorlevel 1 (
  echo.
  echo [!] backend\.env still has the placeholder AGNES_API_KEY.
  echo [!] The Text-to-Video page will not work until you set a real key
  echo [!] from https://platform.agnes-ai.com/
  echo.
)

findstr /C:"GEMINI_API_KEY=" "backend\.env" >nul
if errorlevel 1 (
  echo.
  echo [!] backend\.env has no GEMINI_API_KEY line.
  echo [!] The Prompt Ideas page will not work. Get a key from
  echo [!] https://aistudio.google.com/apikey then add:  GEMINI_API_KEY=AQ.xxxx
  echo.
)

findstr /C:"GEMINI_API_KEY=your_gemini_key_here" "backend\.env" >nul
if not errorlevel 1 (
  echo.
  echo [!] backend\.env still has the placeholder GEMINI_API_KEY.
  echo [!] The Prompt Ideas page will not work until you set a real key.
  echo.
)

echo [4/4] Starting both servers...
echo.
echo       Backend        https://ai-blender-video-maker.vercel.app
echo       Text to Video  http://localhost:4200/#/video
echo       Prompt Ideas   http://localhost:4200/#/prompt
echo.
echo       Press Ctrl+C in this window to stop both servers.
echo.
call npm run dev
goto :eof

:installfail
echo.
echo [ERROR] Dependency installation failed. See the output above for details.
echo         Common causes: no internet, or a proxy/firewall blocking npm.
pause
exit /b 1
