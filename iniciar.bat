@echo off
cd /d "%~dp0"
set PATH=C:\Program Files\nodejs;%PATH%
echo.
echo ST PLAY no navegador: http://localhost:5173
echo (nao abre o Electron — so o site)
echo.
call npm run dev
if errorlevel 1 pause
