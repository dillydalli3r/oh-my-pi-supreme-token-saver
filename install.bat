@echo off
setlocal
where node >nul 2>nul || (
  echo [fail] Node.js 18+ is required on PATH.
  exit /b 1
)
set "ARGS=%*"
if not defined ARGS set "ARGS=install --yes"
node "%~dp0install-omp-addons.js" %ARGS%
exit /b %ERRORLEVEL%
