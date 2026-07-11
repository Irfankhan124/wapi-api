#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  echo "No .env found. Creating from .env.production.example..."
  cp .env.production.example .env
  echo "Edit .env first, then run this script again."
  exit 1
fi

mkdir -p uploads storage

docker compose up -d --build

echo "Waiting for API health check..."
sleep 8
curl -fsS http://127.0.0.1:5000/ || true

echo ""
echo "Done. API container status:"
docker compose ps
