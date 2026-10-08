@echo off
setlocal
rem Starts the game server, creates an LLM-controlled game, and starts the Brain Host.
rem Needs: LM Studio running with its local server on (and a model loaded).
cd /d "%~dp0"
set "LOG=%TEMP%\llmfront-create.log"

echo [1/5] Stopping any old game servers on ports 3000-3002 and 9000...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000,3001,3002,9000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo [2/5] Checking LM Studio...
call npm run brain:check
if errorlevel 1 (
  echo.
  echo LM Studio is not answering. Start its Local Server, load a model, then run this again.
  pause
  exit /b 1
)

if not defined BRAIN_MODEL (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-lmstudio-model.ps1" -Out "%TEMP%\llmfront-model.txt"
  if exist "%TEMP%\llmfront-model.txt" set /p BRAIN_MODEL=<"%TEMP%\llmfront-model.txt"
)
if defined BRAIN_MODEL (echo Using LM Studio model: %BRAIN_MODEL%) else (echo Could not tell which model is loaded; using LM Studio's default.)

echo.
echo Game setup (press Enter to accept the default in brackets)
set "BRAIN_COUNT=" & set "BRAIN_NATIONS=" & set "BRAIN_NAMES="
set /p "BRAIN_NATIONS=Ordinary AI nations (not LLM) [all the rest of the map]: "
set /p "BRAIN_COUNT=LLM-controlled nations [2]: "
set /p "BRAIN_NAMES=Names of the LLM nations, comma separated, from the map's nations [first ones]: "
if "%BRAIN_COUNT%"=="" set "BRAIN_COUNT=2"
echo.

echo [3/5] Starting the game server in a new window...
start "OpenFront server" cmd /k "cd /d %~dp0 && npm run dev"

echo Waiting for the worker on port 3001...
:waitserver
curl.exe -s -o nul http://localhost:3001/
if errorlevel 1 (
  timeout /t 3 /nobreak >nul
  goto waitserver
)

echo [4/5] Creating the game...
if exist "%LOG%" del "%LOG%"
start "Create game" /min cmd /c "cd /d %~dp0 && npm run brain:create -- --map World > "%LOG%" 2>&1"
:waitgame
timeout /t 2 /nobreak >nul
findstr /c:"join:" "%LOG%" >nul 2>&1
if errorlevel 1 goto waitgame

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Select-String -Path '%LOG%' -Pattern 'game ([A-Za-z0-9]+),').Matches[0].Groups[1].Value"`) do set "GAME=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Select-String -Path '%LOG%' -Pattern 'join:\s+(\S+)').Matches[0].Groups[1].Value"`) do set "JOIN=%%i"
echo Game %GAME%
echo Join link %JOIN%

echo [5/5] Starting the Brain Host and opening the game...
start "Brain Host" cmd /k "cd /d %~dp0 && npm run brain:run -- --game %GAME% --server http://localhost:3001"
start "" "%JOIN%"

echo.
echo In the browser: pick a spawn point and play. The game starts a few seconds after you join.
echo Decisions are written to brain.decisions.jsonl. To read them: npm run brain:log
echo Close the "OpenFront server" and "Brain Host" windows to stop.
pause
