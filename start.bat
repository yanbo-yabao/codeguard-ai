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
echo     Your browser will open automatically in a few seconds.
echo     If it does NOT open, type this address in the browser
echo     ADDRESS BAR ^(the top bar, NOT the search box^):
echo.
echo         http://127.0.0.1:8848/
echo.
echo     Keep this window OPEN while using the app.
echo     Close this window to stop the server.
echo  ========================================================
echo.

rem Wait 2s for the server to boot, then open the default browser
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8848/'"

node src/server.js
pause
