# WAPI Backend API Deploy Kit

This is the **backend API** for the WAPI WhatsApp CRM SaaS project. It is a Node.js/Express app with Socket.IO, MongoDB, Redis queues, uploads, cron jobs, WhatsApp services, and webhooks.

It should **not** be deployed to Cloudflare Pages as a frontend. Use a VPS/Docker server, Render/Railway, or another Node backend host.

## Best setup

```text
Admin panel       -> Cloudflare Pages / Firebase / Vercel
Frontend app      -> Cloudflare Pages / Firebase / Vercel
Backend API       -> VPS Docker / Render / Railway
MongoDB           -> Docker MongoDB or MongoDB Atlas
Redis             -> Docker Redis or Upstash/Redis server
API domain        -> https://api.yourdomain.com
```

## Option A: VPS Docker deploy, easiest

Requirements on the server:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx curl
sudo systemctl enable --now docker
```

Upload this `wapi-api` folder to the server, then:

```bash
cd wapi-api
cp .env.production.example .env
nano .env
./deploy/scripts/deploy-docker.sh
```

Test:

```bash
curl http://127.0.0.1:5000/
```

Expected response:

```json
{"message":"App is running successfully"}
```

## Add domain with Nginx

Copy the sample config:

```bash
sudo cp deploy/nginx/wapi-api.conf /etc/nginx/sites-available/wapi-api
sudo nano /etc/nginx/sites-available/wapi-api
```

Change `api.yourdomain.com` to your real API domain.

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/wapi-api /etc/nginx/sites-enabled/wapi-api
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d api.yourdomain.com
```

Your backend URL becomes:

```text
https://api.yourdomain.com
```

## Option B: PM2 deploy without Docker

Use this only if MongoDB and Redis are already installed or hosted elsewhere.

```bash
cd wapi-api
cp .env.production.example .env
nano .env
./deploy/scripts/deploy-pm2.sh
```

Check logs:

```bash
pm2 logs wapi-api
```

Restart:

```bash
pm2 restart wapi-api
```

## Option C: Render or Railway

This folder includes:

```text
Dockerfile
render.yaml
railway.toml
```

For Render/Railway, you must provide external:

```text
MONGO_URI=mongodb+srv://...
REDIS_URL=redis://...
```

Do not use the Docker Compose Mongo/Redis services on Render/Railway unless the platform supports multi-service persistent Docker compose for your plan.

## Important environment variables

Edit `.env` before starting:

```env
APP_URL=https://api.yourdomain.com
SERVER_ADDR=https://api.yourdomain.com
FRONTEND_URL=https://wapi-docs.pages.dev
ALLOWED_ORIGINS=https://wapi-admin.pages.dev,https://wapi-docs.pages.dev
MONGO_URI=mongodb://mongo:27017/wapi
REDIS_URL=redis://redis:6379
JWT_SECRET=change-to-long-random
SESSION_SECRET=change-to-long-random
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe123!
WHATSAPP_VERIFY_TOKEN=your_verify_token
```

## After backend deploy

Update admin/frontend env files:

```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com/api
NEXT_PUBLIC_STORAGE_URL=https://api.yourdomain.com/
```

Then redeploy admin/frontend.

## Seed default admin/settings

After API is running and MongoDB is connected:

```bash
docker compose exec api npm run seed
```

or with PM2/non-Docker:

```bash
npm run seed
```

## Logs

Docker:

```bash
docker compose logs -f api
```

PM2:

```bash
pm2 logs wapi-api
```
