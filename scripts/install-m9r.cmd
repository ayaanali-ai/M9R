@echo off
setlocal
rem Double-click entry point for the no-Node M9R installer. It preserves the
rem current PowerShell execution policy and lets the script show its own plan.
powershell.exe -NoLogo -NoProfile -File "%~dp0install-m9r.ps1" %*
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
  echo M9R installer exited with code %exitCode%.
  pause
)
exit /b %exitCode%
