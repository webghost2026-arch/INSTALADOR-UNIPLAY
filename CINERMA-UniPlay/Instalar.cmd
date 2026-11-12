@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
 echo Extraia todos os arquivos do ZIP antes de abrir Instalar.cmd.
 pause
 exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0instalar.js"
if errorlevel 1 (
 echo A instalacao nao foi concluida. Confira a mensagem acima.
 pause
 exit /b 1
)
pause
