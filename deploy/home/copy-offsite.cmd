@echo off
rem Daily off-site copy for Windows Task Scheduler (docs/home-staging-runbook.md): runs copy-offsite.mjs from this
rem repository and appends its output, with the time, to %LOCALAPPDATA%\InnPilot\offsite.log.
setlocal
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin;%ProgramFiles%\Docker\Docker\resources\bin;%ProgramFiles%\nodejs"
if not exist "%LOCALAPPDATA%\InnPilot" mkdir "%LOCALAPPDATA%\InnPilot"
cd /d "%~dp0..\.."
echo [%DATE% %TIME%] >> "%LOCALAPPDATA%\InnPilot\offsite.log"
node deploy\home\copy-offsite.mjs >> "%LOCALAPPDATA%\InnPilot\offsite.log" 2>&1
exit /b %ERRORLEVEL%
