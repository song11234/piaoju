@echo off
title Invoice System - Local Server
cd /d "%~dp0"

rem Load user-level settings when this batch file is launched from Explorer.
if not defined OPENAI_API_KEY (
  for /f "tokens=1,2,*" %%A in ('reg query HKCU\Environment /v OPENAI_API_KEY 2^>nul') do if /I "%%A"=="OPENAI_API_KEY" set "OPENAI_API_KEY=%%C"
)
if not defined OPENAI_BASE_URL (
  for /f "tokens=1,2,*" %%A in ('reg query HKCU\Environment /v OPENAI_BASE_URL 2^>nul') do if /I "%%A"=="OPENAI_BASE_URL" set "OPENAI_BASE_URL=%%C"
)
if not defined OPENAI_REVIEW_MODEL (
  for /f "tokens=1,2,*" %%A in ('reg query HKCU\Environment /v OPENAI_REVIEW_MODEL 2^>nul') do if /I "%%A"=="OPENAI_REVIEW_MODEL" set "OPENAI_REVIEW_MODEL=%%C"
)
if not defined OPENAI_BASE_URL set "OPENAI_BASE_URL=https://ergouzi.life/v1"
if not defined OPENAI_REVIEW_MODEL set "OPENAI_REVIEW_MODEL=gpt-5.4-mini"

if /I "%~1"=="--check-ai" (
  if defined OPENAI_API_KEY (
    echo AI review configuration: ready
    echo Base URL: %OPENAI_BASE_URL%
    echo Model: %OPENAI_REVIEW_MODEL%
    exit /b 0
  )
  echo AI review configuration: OPENAI_API_KEY is missing
  exit /b 1
)

if defined OPENAI_API_KEY (
  echo AI review configuration: ready
) else (
  echo Warning: OPENAI_API_KEY is not configured. AI review will be unavailable.
)

where node >nul 2>&1
if errorlevel 1 goto node_missing

if not exist "node_modules" (
  echo Installing project dependencies. Please wait...
  call npm install
  if errorlevel 1 goto install_failed
)

set "PORT=3100"
:find_free_port
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  set /a PORT+=1
  goto find_free_port
)

echo.
echo Starting the local invoice system...
echo Keep this window open while using the system.
echo Browser address: http://localhost:%PORT%
echo.
start "" "http://localhost:%PORT%"
node server.js

echo.
echo The local server has stopped. Read the message above for the reason.
pause
exit /b 1

:node_missing
echo Node.js was not found. Please install Node.js first.
pause
exit /b 1

:install_failed
echo Dependency installation failed. Check the network and try again.
pause
exit /b 1
