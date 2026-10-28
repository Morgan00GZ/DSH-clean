@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "HERE=%~dp0"

if defined DSH_DESKTOP_NODE_EXECUTABLE goto use_dsh
where node >nul 2>nul && goto use_path_node
goto use_ps

:use_dsh
set "ELECTRON_RUN_AS_NODE=1"
set "DSH_CLEAN_DESKTOP_EXE=%DSH_DESKTOP_NODE_EXECUTABLE%"
"%DSH_DESKTOP_NODE_EXECUTABLE%" "%HERE%dsh-clean.mjs" %*
exit /b %ERRORLEVEL%

:use_path_node
node "%HERE%dsh-clean.mjs" %*
exit /b %ERRORLEVEL%

:use_ps
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%lib\launch.ps1" -Script "%HERE%dsh-clean.mjs" %*
exit /b %ERRORLEVEL%
