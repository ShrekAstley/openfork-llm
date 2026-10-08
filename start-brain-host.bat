@echo off
setlocal
rem Attaches the Brain Host (LM Studio) to a lobby you opened in the game's own
rem "Host lobby" screen. In that screen set "LLM nations", then run this.
cd /d "%~dp0"
echo [1/3] Checking LM Studio...
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
set "GAME=%~1"
if "%GAME%"=="" set /p "GAME=Lobby id or join link (shown in the lobby screen): "
echo [2/3] Starting the Brain Host for %GAME% ...
call npm run brain:run -- --game "%GAME%"
echo.
pause
