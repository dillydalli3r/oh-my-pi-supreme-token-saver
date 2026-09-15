@echo off
setlocal
set "ARGS=%*"
if not defined ARGS set "ARGS=install --yes"

rem Hold the window only for a double-click (or "cmd /c") launch, where the
rem console vanishes with the script. Launched from an already-open console,
rem from a script, or from CI, %cmdcmdline% does not name this script.
rem The expansion is quoted because %cmdcmdline% is expanded before the pipe is parsed: an unquoted
rem `&` or `|` in the launch path would end the command right there.
set "HOLD="
echo "%cmdcmdline%" | find /i "%~nx0" >nul && set "HOLD=1"

where node >nul 2>nul
if errorlevel 1 (
  echo [fail] Node.js 18+ is required on PATH.
  set "CODE=1"
  goto :hold
)

node "%~dp0install-omp-addons.js" %ARGS%
set "CODE=%ERRORLEVEL%"

:hold
if defined HOLD (
  echo.
  echo Press any key to close this window...
  pause >nul
)
exit /b %CODE%
