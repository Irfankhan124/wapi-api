#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  echo "No .env found. Creating from .env.production.example..."
  cp .env.production.example .env
  echo "Edit .env first, then run this script again."
  exit 1
fi

npm install --include=optional
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
