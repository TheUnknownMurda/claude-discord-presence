@echo off
setlocal
title Claude Discord Presence

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js n'est pas installe ou n'est pas dans le PATH.
    echo Telecharge-le sur https://nodejs.org (version 16 ou plus recente^).
    pause
    exit /b 1
)

set "CFG=%APPDATA%\claude-discord-presence\config.json"
if not exist "%CFG%" (
    echo Aucun config.json trouve, lancement de la configuration...
    node bin\cli.js setup
    if errorlevel 1 (
        echo [ERREUR] La configuration a echoue.
        pause
        exit /b 1
    )
)

echo Demarrage de Claude Discord Presence... (Ctrl+C pour arreter^)
echo.
node bin\cli.js start --foreground %*
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" echo [ERREUR] Arret avec le code %EXITCODE%.
pause
exit /b %EXITCODE%
