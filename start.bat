@echo off
cd /d "%~dp0"

start "Proxy" powershell -NoExit -Command "cd '%~dp0'; npm run proxy"
start "Dev Server" powershell -NoExit -Command "cd '%~dp0'; npm run dev"
start "Simulator" powershell -NoExit -Command "cd '%~dp0'; Start-Sleep -Seconds 5; evenhub-simulator http://localhost:5175"
