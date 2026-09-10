@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart Workspace.ps1"
if errorlevel 1 pause
