@echo off
setlocal
cd /d "%~dp0"
node --watch dev-server.mjs 5173 %*
