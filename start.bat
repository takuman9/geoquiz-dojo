@echo off
rem GeoQuiz Dojo ローカル起動 (Windows) — ダブルクリックでOK
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org からLTS版をインストールしてください。
  pause
  exit /b 1
)
start "" http://localhost:8080
node server.js
pause
