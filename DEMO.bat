@echo off
cd /d "%~dp0"
title File karaoke - DEMO
echo.
echo   Mode demo : un faux KaraFun integre, pour essayer sans KaraFun.
echo.
"%~dp0node\node.exe" server.js --demo
pause
