@echo off
rem AgentCraft Control: double-click to start. Dashboard on http://127.0.0.1:8045
rem (it starts the Foreman, and Minecraft when you ask it to). Close this window to stop.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22+ is required: https://nodejs.org & pause & exit /b 1)
if not exist "tools\node_modules\ws" (
  echo Installing dependencies ...
  call npm ci --prefix tools --no-audit --no-fund || (pause & exit /b 1)
)
node tools\control.mjs %*
if errorlevel 1 pause
