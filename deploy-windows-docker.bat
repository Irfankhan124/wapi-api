@echo off
IF NOT EXIST .env (
  echo No .env found. Copying .env.production.example to .env...
  copy .env.production.example .env
  echo Edit .env first, then run this file again.
  pause
  exit /b 1
)
mkdir uploads 2>nul
mkdir storage 2>nul
docker compose up -d --build
docker compose ps
pause
