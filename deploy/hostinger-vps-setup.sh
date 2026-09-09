#!/usr/bin/env bash
# One-time VPS bootstrap for Smart CLM Enterprise on a fresh Hostinger KVM
# VPS (Ubuntu 24.04). Run this ONCE as root right after first SSH login:
#
#   curl -fsSL https://raw.githubusercontent.com/hr607/Contract-Management/main/deploy/hostinger-vps-setup.sh | bash
#
# or copy this file to the VPS and run: bash hostinger-vps-setup.sh
#
# What it does:
#   1. Installs Node.js 22 LTS, PM2 (process manager), Nginx, Certbot
#   2. Clones the repo (or pulls latest if it already exists)
#   3. Installs deps + builds the production bundle
#   4. Starts the app under PM2 (survives reboots, auto-restarts on crash)
#   5. Configures Nginx as a reverse proxy on port 80 -> app's $PORT
#
# What it does NOT do (you do these manually, see instructions below):
#   - Fill in .env with real secrets (DATABASE_URL, JWT_SECRET, etc.)
#   - Point your domain's DNS A record at this VPS's IP
#   - Run certbot for HTTPS (needs the domain pointed here first)

set -euo pipefail

REPO_URL="https://github.com/hr607/Contract-Management.git"
APP_DIR="/var/www/smart-clm"
APP_PORT=3000

echo "== 1/6: System update & base packages =="
apt-get update -y
apt-get install -y curl git nginx

echo "== 2/6: Node.js 22 LTS =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "== 3/6: PM2 (process manager) =="
npm install -g pm2

echo "== 4/6: Clone or update the app =="
mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull origin main
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo "!! .env not found. Copying .env.example -> .env — YOU MUST edit it"
  echo "!! with real values before the app will work (DATABASE_URL, JWT_SECRET, etc)."
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

echo "== 5/6: Install deps, build, start under PM2 =="
cd "$APP_DIR"
npm install
npm run build
# NODE_ENV=production is REQUIRED: server.ts checks it to decide whether to
# serve the built dist/ folder or try to boot Vite's dev middleware (which
# would break — dist/server.cjs is a production bundle, not a dev server).
# Set at `pm2 start` time, PM2 persists it in its own process list, so it
# survives `pm2 restart` / reboots without needing to touch .env for this.
#
# PORT is left unset on purpose — server.ts defaults to 3000, matching the
# Nginx proxy_pass target below. Change both together if you ever need a
# different port.
pm2 delete smart-clm 2>/dev/null || true
NODE_ENV=production pm2 start dist/server.cjs --name smart-clm
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "== 6/6: Nginx reverse proxy (HTTP, port 80 -> $APP_PORT) =="
cat > /etc/nginx/sites-available/smart-clm <<NGINX
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/smart-clm /etc/nginx/sites-enabled/smart-clm
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "======================================================================"
echo " Bootstrap done. Remaining manual steps:"
echo " 1. Edit $APP_DIR/.env with real secrets, then: pm2 restart smart-clm"
echo " 2. Point your domain's DNS A record at this server's IP address"
echo " 3. Once DNS resolves, run: certbot --nginx -d yourdomain.com"
echo "    (installs a free Let's Encrypt HTTPS cert and auto-renews it)"
echo "======================================================================"
