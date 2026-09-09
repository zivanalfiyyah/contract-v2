# Deploy ke Hostinger VPS

Panduan deploy Smart CLM Enterprise ke Hostinger KVM VPS (Ubuntu 24.04).

## 1. Provisioning VPS

Di dashboard Hostinger (hPanel):
1. Beli paket **VPS** (rekomendasi minimal **KVM 1** — 1 vCPU/4GB RAM cukup untuk aplikasi ini).
2. Pilih OS **Ubuntu 24.04 LTS**.
3. Catat **IP address VPS** dan **password root** yang diberikan (atau setup SSH key saat provisioning, lebih aman).

## 2. Login & jalankan setup script

```bash
ssh root@<IP_VPS_ANDA>
curl -fsSL https://raw.githubusercontent.com/hr607/Contract-Management/main/deploy/hostinger-vps-setup.sh | bash
```

Script ini otomatis: install Node.js 22, PM2, Nginx, clone repo, install dependencies, build, dan jalankan aplikasi via PM2 + Nginx reverse proxy di port 80.

## 3. Isi environment variables (WAJIB)

Script di atas membuat `.env` dari `.env.example` tapi masih kosong. Edit dengan nilai asli:

```bash
nano /var/www/smart-clm/.env
```

Wajib diisi:
- `DATABASE_URL` — connection string Postgres (Neon) yang sama dengan yang dipakai di lokal
- `JWT_SECRET` — generate baru khusus VPS ini: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `GEMINI_API_KEY`
- `APP_URL` — isi setelah domain aktif (langkah 4), contoh `https://clm.namaanda.com`
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL`

Opsional (boleh dikosongkan dulu, fitur terkait otomatis nonaktif dengan aman):
`SMTP_*`, `STORAGE_*`

Setelah edit, restart aplikasi:

```bash
pm2 restart smart-clm
```

## 4. Arahkan domain (kalau punya)

Di pengaturan DNS domain Anda (Hostinger DNS, Cloudflare, dll), buat **A record**:

```
Type: A
Name: @ (atau subdomain seperti "clm")
Value: <IP_VPS_ANDA>
```

Tunggu propagasi DNS (biasanya beberapa menit sampai 1 jam).

## 5. Aktifkan HTTPS gratis (Let's Encrypt)

Setelah domain sudah resolve ke IP VPS:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d namadomainanda.com
```

Certbot otomatis konfigurasi Nginx untuk HTTPS + auto-renewal setiap 90 hari.

## Perintah operasional yang sering dipakai

```bash
pm2 status                 # cek status aplikasi
pm2 logs smart-clm         # lihat log real-time
pm2 restart smart-clm      # restart setelah update .env atau deploy baru
```

## Update aplikasi ke versi terbaru

```bash
cd /var/www/smart-clm
git pull origin main
npm install
npm run build
pm2 restart smart-clm
```

## Catatan penting

- **Backup & upload lokal**: karena ini VPS (bukan platform serverless/ephemeral), folder `uploads/` dan `backups/` di disk VPS bersifat permanen selama VPS tidak dihapus — beda dengan Render/Vercel yang bisa reset disk saat redeploy. Tapi tetap disarankan isi `STORAGE_*` (cloud storage) untuk redundansi kalau VPS bermasalah.
- **Firewall**: Hostinger VPS biasanya sudah buka port 80/443 secara default. Kalau pakai `ufw`, pastikan `ufw allow 80` dan `ufw allow 443` dijalankan.
- **Restart otomatis saat reboot server**: `pm2 startup` + `pm2 save` (sudah dijalankan otomatis oleh setup script) memastikan aplikasi otomatis jalan lagi kalau VPS di-restart.
