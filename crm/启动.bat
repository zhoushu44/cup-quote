@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 先用系统里的 node；没有就用 DeepSeek Harness 自带的
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" server.js
)
pause
