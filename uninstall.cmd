@echo off
setlocal
call "%~dp0dsh-clean.cmd" uninstall %*
echo.
pause
