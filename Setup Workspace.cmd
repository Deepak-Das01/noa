@echo off
cd /d "%~dp0"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or 24 LTS, reopen this window, and try again.
  pause
  exit /b 1
)
call npm.cmd install
if errorlevel 1 (
  echo Installation failed. Review the error above.
  pause
  exit /b 1
)
echo Setup complete. Run Start Workspace.cmd.
pause
