@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "HERE=%~dp0"
echo.
echo   DSH-clean 收尾
echo   历史报告只留最近 10 份，安装目录里遗留的旧状态文件一并收走。
echo   全部送进回收站，随时可以还原。
echo.
call "%HERE%dsh-clean.cmd" prune --dry-run
echo.
set "GO="
set /p GO=确认收尾吗？直接回车＝执行；输入 n＝取消： 
if /i "%GO%"=="n" goto cancelled
call "%HERE%dsh-clean.cmd" prune
echo.
pause
exit /b 0
:cancelled
echo 已取消，什么都没动。
pause
exit /b 0
