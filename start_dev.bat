@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Hosts may preset ELECTRON_RUN_AS_NODE=1, which turns electron.exe
rem into plain Node (app becomes undefined). Clear it before launching.
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron binary not found. Run: npm install
  pause
  exit /b 1
)

rem Launch detached so this window closes immediately after starting the app.
start "" "node_modules\electron\dist\electron.exe" . --no-sandbox --user-data-dir="%~dp0.data-run"

rem Give the process a moment to acquire the single-instance lock, then exit.
exit /b 0
