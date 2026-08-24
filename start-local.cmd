@echo off
setlocal

cd /d "%~dp0"
set "API_DIR=%~dp0server-deno"

start "Horizon Scanner API (Deno)" cmd /k "pushd ""%API_DIR%"" && deno run --allow-net --allow-env --allow-read --allow-sys --allow-write=/tmp --env-file=../.env server.ts"
start "Horizon Scanner Frontend" cmd /k "npm run dev"

echo Horizon Scanner is starting.
echo Frontend: http://127.0.0.1:3000
echo API: http://localhost:3002

endlocal
