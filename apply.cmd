@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "HERE=%~dp0"
echo.
echo   DSH-clean 清理
echo   先列出可清理项，你决定清哪几项。全部送进回收站，随时可以还原。
echo.
call "%HERE%dsh-clean.cmd" review
echo.
set "IDS="
set /p IDS=输入要清理的编号（例如 1,3,5；直接回车＝取消）： 
if not defined IDS goto cancelled
call "%HERE%dsh-clean.cmd" apply --ids=%IDS% --yes
echo.
pause
exit /b 0
:cancelled
echo 已取消，什么都没删。
pause
exit /b 0
