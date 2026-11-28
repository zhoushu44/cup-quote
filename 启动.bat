@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 纸杯报价 + 客户跟进，同一个服务。地址：http://localhost:6655
rem 报价单、客户跟进数据、ERP 账号都存在本目录的 data\ 里（不进 git）
set PORT=6655
set DATA=%~dp0data
if not exist "%DATA%" mkdir "%DATA%"
rem 先用系统里的 node；没有就用 DeepSeek Harness 自带的
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:6655
  node server\server.js
) else (
  start "" http://localhost:6655
  "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" server\server.js
)
pause
