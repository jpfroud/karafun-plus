@echo off
cd /d "%~dp0"
title Arreter la file karaoke
if not exist "%~dp0node\node.exe" (
  echo ERREUR : node\node.exe est introuvable.
  pause
  exit /b 1
)
"%~dp0node\node.exe" stop.js
pause
