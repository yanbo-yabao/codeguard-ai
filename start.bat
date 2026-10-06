@echo off
chcp 65001 >nul
title CodeGuard AI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js not found on this computer.
  echo.
  echo      Please install it first ^(one click, Next...Next^):
  echo          https://nodejs.org/
  echo.
  echo      After installing, close this window and double-click start.bat again.
  echo.
  pause
  exit /b 1
)

echo.
echo  ========================================================
echo     CodeGuard AI  -  starting...
echo  ========================================================
echo.
echo     Open this address in your browser:
echo.
echo         http://127.0.0.1:8848/
echo.
echo     Close this window to stop the server.
echo  ========================================================
echo.

node src/server.js
pause
