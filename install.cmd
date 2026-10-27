@echo off
setlocal
call "%~dp0dsh-clean.cmd" install %*
echo.
pause
