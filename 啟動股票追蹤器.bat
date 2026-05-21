@echo off
cd /d "%~dp0"
echo 正在啟動股票追蹤器...
echo 啟動後請開啟瀏覽器前往 http://localhost:3000
echo 此視窗請保持開啟，關閉即停止服務。
echo.
node server.js
pause
