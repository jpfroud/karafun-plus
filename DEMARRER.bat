@echo off
cd /d "%~dp0"
title File karaoke
echo.
echo   ======================================
echo    File karaoke - pilote la file KaraFun
echo   ======================================
echo.
echo   KaraFun et la file karaoke demarrent ensemble.
echo   Si le code de telecommande a change, saisis-le sur la page du bar.
echo.
if not exist "%~dp0node\node.exe" (
  echo   ERREUR : node\node.exe est introuvable dans ce dossier.
  pause
  exit /b 1
)
"%~dp0node\node.exe" start-evening.js
echo.
if errorlevel 1 pause
