@echo off
chcp 65001 >nul
setlocal
call "%~dp0dsh-clean.cmd" install %*
echo.
pause
