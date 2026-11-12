@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
 echo Pacote incompleto. Instale novamente pelo download do Hub.
 pause
 exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0abrir.js"
if errorlevel 1 pause
