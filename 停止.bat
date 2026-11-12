@echo off
chcp 65001 >nul
title CodeGuard AI - stop
cd /d "%~dp0"

echo.
echo  Stopping CodeGuard AI ...
echo.

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8848"') do (
  taskkill /f /pid %%p >nul 2>nul
  set FOUND=1
)

if "%FOUND%"=="1" (
  echo  [OK] Server stopped. Now you can close this window.
) else (
  echo  [i] Server was not running. Nothing to stop.
)
echo.
pause
