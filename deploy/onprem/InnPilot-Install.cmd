@echo off
rem Double-click to install or upgrade InnPilot on this computer (runs install.ps1 next to this file).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
