@echo off
rem Double-click to use M9R Web: starts the local broker (minimized) and opens Claude Code with M9R's web tools.
rem Requires the extension loaded in Chrome/Edge and the sites you want allowed in its panel.
set "M9R_REPO=%~dp0.."
cd /d "%M9R_REPO%"
set ANTHROPIC_API_KEY=
set OPENAI_API_KEY=
start "M9R broker" /min cmd /c node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs scripts/m9r-web-broker.ts
timeout /t 4 /nobreak >nul
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs scripts/m9r-cli.ts launch claude
