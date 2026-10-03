@echo off
setlocal
rem ExecutionPolicy applies only to this process; no saved policy is changed.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-m9r.ps1" %*
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
  echo M9R installer exited with code %exitCode%.
  pause
)
exit /b %exitCode%
