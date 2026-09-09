# Changelog & Panduan Migrasi

## [Unreleased #4] — Fitur AI Gemini Baru: Bandingkan Dokumen, Buat Draft AI, Copilot Multi-Turn

### Ringkasan

Tiga penambahan/peningkatan fitur AI (Gemini Flash), plus satu perbaikan lintas semua endpoint AI sekaligus:

1. **Bandingkan Dokumen (AI)** — baru. Membandingkan dua dokumen bebas (bukan cuma riwayat versi internal) pasal-per-pasal, menilai pihak mana yang diuntungkan tiap perbedaan, dan memberi rekomendasi negosiasi.
2. **Buat Draft Kontrak dengan AI** — baru. Menyusun draft kontrak lengkap (judul, pasal-pasal, variabel, risk flags) dari deskripsi kebutuhan bisnis berbahasa natural, dalam Bahasa Indonesia atau Inggris, langsung bisa dimuat ke form Buat Kontrak.
3. **AI Legal Copilot** — ditingkatkan jadi chat agent sungguhan. Sebelumnya tiap pertanyaan dikirim terpisah tanpa konteks percakapan sebelumnya (riwayat cuma tampil di UI, tidak pernah dikirim ke model) — sekarang riwayat 10 giliran terakhir dikirim sebagai `contents` multi-turn beneran, jadi pertanyaan lanjutan ("jelaskan lebih detail soal itu") benar-benar dijawab dengan mengingat konteks sebelumnya.
4. **Perbaikan lintas semua endpoint `/api/ai/*`**: sebelumnya kalau `GEMINI_API_KEY` belum dikonfigurasi, tiap endpoint AI (10+ endpoint lama: analyze-risk, compliance-check, translate-legal, dst) gagal dengan error 500 generik dari SDK Gemini yang membingungkan. Sekarang ada middleware terpusat yang mengecek konfigurasi SEBELUM masuk ke handler manapun — semua endpoint AI (lama maupun baru) langsung menjawab 503 dengan pesan jelas "GEMINI_API_KEY belum dikonfigurasi" begitu ada permintaan, konsisten dengan pola *honest degradation* yang sudah dipakai di SMTP/Push/Storage.

Fitur risk analysis, translate dokumen (ID↔EN), dan review/audit dokumen tunggal SUDAH ada sebelumnya di sistem — tidak dibangun ulang, hanya ikut kena perbaikan poin 4 di atas.

### Endpoint baru

- `POST /api/ai/compare-documents` — `{ documentA, documentB, labelA?, labelB? }` → perbedaan substantif, klausul unik tiap dokumen, poin negosiasi, rekomendasi.
- `POST /api/ai/generate-contract-draft` — `{ prompt, category?, language? }` (`language`: `"id"` default atau `"en"`) → judul, pasal-pasal lengkap siap pakai, daftar variabel `{{Placeholder}}`, dan risk flags per pasal.

### Endpoint yang berubah

- `POST /api/ai/copilot` — sekarang menerima `history: {q, a}[]` (opsional) selain `question`/`context`, dan menggunakan `systemInstruction` + `contents` multi-turn alih-alih satu string prompt gabungan.

### Verifikasi

Karena `GEMINI_API_KEY` di lingkungan pengembangan ini masih placeholder (belum ada API key nyata), pengujian dilakukan sejauh yang jujur bisa diverifikasi tanpa kunci asli:
- Middleware honest-degradation diuji lewat 4 endpoint (2 lama, 2 baru) — semua konsisten menjawab 503 dengan pesan yang sama.
- UI kedua fitur baru diuji end-to-end di browser sungguhan (isi form, klik submit, request benar-benar terkirim ke server, response 503 tertangkap dan ditampilkan ke pengguna lewat toast — bukan crash atau silent fail).
- Type-check bersih di frontend & backend.
- **Belum bisa diverifikasi**: kualitas/akurasi hasil AI sungguhan (perbandingan dokumen, draft kontrak, jawaban copilot multi-turn) — itu baru bisa diuji nyata setelah `GEMINI_API_KEY` asli diisi di `.env`.

## [Unreleased #3] — Migrasi Database: SQLite → PostgreSQL

### Ringkasan

Persistence layer (`db.ts`) dipindah total dari SQLite (file lokal `app.db`) ke PostgreSQL, supaya aplikasi bisa jalan di lebih dari satu server instance dan tidak kehilangan data setiap kali platform hosting me-redeploy/restart container dengan disk yang di-reset (mis. Heroku, Cloud Run, Railway tanpa persistent volume).

**Ini BREAKING CHANGE untuk cara deploy** (env var baru wajib), tapi TIDAK mengubah satu pun perilaku fitur — setiap endpoint, setiap query, semua logic bisnis di `server.ts`/`auth.ts` sama sekali tidak disentuh. Ini murni penggantian mesin penyimpanan di bawahnya.

### Yang berubah

- **`db.ts` ditulis ulang** untuk PostgreSQL (pakai driver `pg`), tapi mempertahankan API publik yang identik (`loadDB()`, `saveDB()`, `initDB()`, `DEFAULT_TENANT_ID`, `makeDefaultUsers()`) — sehingga tidak ada satu baris pun yang perlu diubah di `server.ts` atau `auth.ts`.
- Model penyimpanan tetap sama: setiap "koleksi" (contracts, users, clauses, dst) adalah tabel `(id, data JSONB)` — desain dokumen-per-baris yang sama seperti sebelumnya di SQLite, hanya kolom `data TEXT` menjadi `data JSONB` (Postgres native, mendukung query/index di dalam JSON kalau nanti dibutuhkan).
- **`backup.ts` ditulis ulang**: sebelumnya memakai SQLite online-backup API (butuh file `app.db` lokal, tidak berlaku lagi). Sekarang backup harian adalah snapshot JSON lengkap (`data.json`) dari seluruh state aplikasi — format yang sama dengan `database.json` legacy yang sudah lama didukung untuk import, jadi backup ini portable dan tidak butuh tool database apa pun untuk dibaca/dipulihkan.
- **`better-sqlite3` tidak lagi dipakai runtime** — hanya tersisa sebagai dependency untuk `migrate-to-postgres.ts` (skrip migrasi satu kali).

### Karakteristik penting: penulisan async

SQLite lama bersifat sinkron (setiap `saveDB()` langsung commit ke disk sebelum function itu selesai). Postgres secara alami butuh network round-trip, jadi `saveDB()` sekarang:
1. Langsung meng-update cache di memori (baca setelah `saveDB()` dalam request yang sama tetap konsisten, sama seperti sebelumnya).
2. Menjadwalkan penulisan sungguhan ke Postgres di background lewat antrian promise berurutan (supaya urutan tulis tetap benar, dan satu penulisan gagal tidak merusak antrian berikutnya).

Konsekuensinya: ada jeda singkat (biasanya < 1 detik) antara response API terkirim dan data benar-benar ter-commit di Postgres. Kalau proses Node crash TEPAT di jeda itu, perubahan terakhir bisa hilang — risiko yang sangat kecil untuk skala pemakaian aplikasi ini, tapi dicatat di sini secara transparan. Setiap kegagalan penulisan dicatat lewat `logger.error(...)`, tidak pernah disembunyikan.

### Panduan Migrasi

**Wajib untuk deployment manapun** (baru maupun existing):

1. Siapkan database Postgres (Neon/Supabase tier gratis paling cepat — tidak perlu instalasi apa pun, atau instance Postgres sendiri).
2. Isi `DATABASE_URL` di `.env` (lihat `.env.example` untuk formatnya).
3. `npm install` — menarik `pg` + `@types/pg`.
4. **Kalau ini instalasi baru** (belum pernah punya `app.db`): langsung `npm run dev` — database Postgres akan di-seed otomatis dengan data awal & user default, persis seperti SQLite dulu.
5. **Kalau ini instalasi existing** (sudah punya `app.db` berisi data nyata): jalankan sekali:
   ```
   npx tsx migrate-to-postgres.ts
   ```
   Skrip ini membaca `app.db` (read-only, tidak pernah mengubahnya) dan menyalin semua baris ke Postgres. Aman dijalankan berkali-kali (idempotent — setiap run menimpa bersih dari awal). Setelah sukses, jalankan `npm run dev` seperti biasa; `app.db` sendiri boleh disimpan sebagai arsip/cadangan tapi tidak lagi dibaca oleh aplikasi.
6. Diverifikasi end-to-end: migrasi data asli (bukan data uji) dari SQLite ke Postgres — jumlah baris cocok persis di setiap tabel (tenants, users, contracts, audits, dst, total 17 tabel/koleksi), isi & urutan data diverifikasi sama; ditambah uji tulis baru (create/delete kontrak & sub folder) dibuktikan benar-benar ter-commit ke Postgres (dicek langsung query database, bukan cuma lewat API aplikasi), dan bertahan setelah proses server di-restart total (uji durability sungguhan, bukan cuma cache memori); serta smoke test lengkap di browser nyata (login, dashboard, monitoring, analytics, arsip dokumen) tanpa error.

## [Unreleased #2] — Kesiapan Komersial: Lupa Password, Cloud Storage

### Ringkasan

Dua langkah kesiapan komersial dari audit gap sebelumnya:

1. **Lupa Password / Reset Password** — user yang lupa password tidak lagi harus menunggu admin reset manual.
2. **Cloud Storage untuk file upload** — abstraksi penyimpanan berkas yang otomatis pakai S3-compatible object storage (AWS S3 / Cloudflare R2 / MinIO / GCS-interop) kalau dikonfigurasi, dengan fallback aman ke disk lokal kalau belum — mengikuti pola *honest degradation* yang sama dengan SMTP dan Push Notification.

Tidak ada breaking change. Instalasi yang sudah berjalan tetap memakai disk lokal seperti sebelumnya sampai variabel `STORAGE_*` diisi.

---

### 1. Lupa Password / Reset Password

- `POST /api/auth/forgot-password` — minta tautan reset. Balasan **selalu sama** baik email terdaftar maupun tidak (cegah enumerasi akun), KECUALI kalau SMTP memang belum dikonfigurasi sama sekali, di mana sistem jujur bilang fitur ini belum aktif (503) — dicek SEBELUM mencari user, jadi tetap tidak membocorkan keberadaan akun.
- `POST /api/auth/reset-password` — selesaikan reset pakai token dari email. Token: 32-byte random, di-hash SHA-256 sebelum disimpan (mirip pola password hashing lain di `auth.ts`), berlaku 1 jam, sekali pakai (dihapus setelah dipakai).
- UI login sekarang punya link "Lupa kata sandi?" → form minta email → form set password baru (dibuka otomatis kalau URL punya `?resetToken=...` dari tautan email, lalu token langsung dibersihkan dari address bar).
- Diverifikasi end-to-end: token salah ditolak (400), password < 8 karakter ditolak, token benar berhasil ganti password, password lama langsung tidak berlaku, token tidak bisa dipakai dua kali, dan UI browser sungguhan (navigasi form, pesan honest-degradation, capture token dari URL, validasi client-side) semua bekerja.
- Rate-limited pakai `loginLimiter` yang sudah ada (10 percobaan/15 menit) untuk cegah brute-force token.

### 2. Cloud Storage — `storage.ts`

Modul baru dengan pola *honest degradation* yang sama seperti `email.ts`/`push.ts`: kalau `STORAGE_*` belum dikonfigurasi, upload tetap jalan normal ke disk lokal (`uploads/`, seperti sebelumnya) — tidak ada perilaku yang berubah untuk instalasi yang belum di-setup.

**Environment variable baru (opsional):**

```
STORAGE_BUCKET=
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
STORAGE_REGION=auto
STORAGE_ENDPOINT=
STORAGE_PUBLIC_URL_BASE=
STORAGE_FORCE_PATH_STYLE=false
```

Lihat `.env.example` untuk penjelasan tiap variabel dan cara mengisi untuk AWS S3 vs Cloudflare R2 vs MinIO.

**Perilaku:**
- Kalau `STORAGE_BUCKET` + `STORAGE_ACCESS_KEY_ID` + `STORAGE_SECRET_ACCESS_KEY` terisi → upload disimpan ke object storage via `@aws-sdk/client-s3` (S3-compatible API, jadi juga jalan untuk R2/MinIO/GCS-interop).
- Kalau belum diisi, atau upload ke cloud gagal (mis. bucket sedang down) → otomatis fallback ke disk lokal, dicatat di log server (`logger.error`), request tetap berhasil (tidak hard-fail hanya karena bucket bermasalah sesaat).
- Status konfigurasi bisa dicek admin di Konfigurasi > Kelola Perusahaan (panel baru "Penyimpanan Berkas"), juga lewat `GET /api/admin/storage/status` (super_admin).
- Multer diganti dari `diskStorage` ke `memoryStorage` — file di-buffer di memori lalu diserahkan ke `storage.ts` yang memutuskan tujuan penyimpanan; batasan tipe file (PDF/JPG/PNG) dan ukuran (20MB) tidak berubah.
- Diverifikasi end-to-end: upload dengan storage belum dikonfigurasi (fallback lokal, file benar-benar tersimpan & bisa diakses via `/uploads/...`), dan upload dengan endpoint cloud yang sengaja tidak bisa dihubungi (membuktikan fallback-on-error benar-benar jalan, error tercatat di log, request tetap sukses alih-alih crash).

### Panduan Migrasi (update)

Untuk instalasi yang sudah berjalan:
1. `npm install` — menarik `@aws-sdk/client-s3`.
2. Tidak perlu migrasi data. User lama otomatis bisa pakai "Lupa kata sandi?" begitu SMTP dikonfigurasi (lihat bagian SMTP di changelog sebelumnya).
3. File upload lama di `uploads/` tetap terbaca seperti biasa — abstraksi storage baru hanya berlaku untuk upload BARU setelah `STORAGE_*` diisi. Tidak ada migrasi otomatis file lama ke cloud (kalau nanti mau pindah, salin manual folder `uploads/` ke bucket dengan nama key yang sama).

## [Unreleased] — Bug fixes + Analitik Lanjutan, Kolaborasi Komentar, Push Notification, Folder 3-Layer

### Ringkasan

Empat area perbaikan/fitur besar pada rilis ini:

1. Perbaikan bug yang dilaporkan (export PDF, duplikasi draft perpanjangan di Monitoring).
2. Pengiriman email nyata (SMTP) untuk kirim PDF & tautan tanda tangan eksternal.
3. Web Push Notification nyata (bukan simulasi) untuk reminder jatuh tempo, perubahan status, dan komentar baru.
4. Kolaborasi komentar per klausul: mention pengguna, riwayat, dan hak resolve untuk semua peserta diskusi (gaya Google Docs).
5. Folder arsip 3-layer (Kategori > Sub Folder > Sub-Sub Folder) terintegrasi ke alur pembuatan & pendaftaran kontrak.

Tidak ada breaking change pada data yang sudah ada — semua kontrak/data lama tetap berjalan tanpa perlu diisi field baru (field baru bersifat opsional).

---

### 1. Bug Fixes

- **Export PDF gagal total**: Tailwind v4 menghasilkan warna `oklch()` yang tidak didukung `html2canvas` versi lama, sehingga setiap export gagal senyap. Diganti dengan fork `html2canvas-pro` yang API-nya identik tapi mendukung `oklch`/`oklab`/`lab`/`lch`.
- **Duplikasi draft "Perpanjang" di Monitoring**: Klik "Perpanjang" berkali-kali pada kontrak yang sama dulu membuat banyak draft duplikat. Sekarang backend menolak (`409`) jika draft perpanjangan yang masih aktif sudah ada, dan frontend otomatis membuka draft tersebut alih-alih membuat yang baru.
- **`POST /api/push/test` berbohong**: endpoint ini dulu selalu menjawab "terkirim" walau tidak pernah benar-benar mengirim push. Sekarang memanggil layanan push sungguhan dan melaporkan hasil `sent`/`failed` yang jujur.
- **Komentar klausul: hanya pemilik boleh resolve**: melanggar semantik "diskusi bersama" — sekarang siapa pun peserta diskusi bisa menandai selesai/belum (edit isi teks tetap dibatasi pemilik/admin/legal).
- **Fitur mention tidak tersambung ke UI**: backend sudah mendukung `mentions`, tapi frontend selalu mengirim array kosong. Sekarang ada picker "@" untuk memilih pengguna yang di-mention.
- **Filter Status di Monitoring hardcode & tidak lengkap**: dropdown filter status hanya berisi 5 nilai tetap (Request/Review/Approval/Approved/Signed) sehingga kontrak dengan status lain (Draft, Signature, Archived, Terminated, atau nilai legacy seperti "Completed" pada data lama) tidak pernah bisa difilter — persis contoh "dropdown pada row belum bisa ditambahkan" yang dilaporkan. Sekarang daftar opsi dibangun otomatis dari status yang benar-benar ada di data (`Array.from(new Set(contracts.map(c => c.status)))`), jadi selalu lengkap tanpa perlu edit kode saat ada status baru.
- **Verifikasi ulang Export PDF & duplikasi Monitoring**: diuji ulang end-to-end dengan browser sungguhan — Export to PDF menghasilkan file PDF valid (`%PDF-1.3`, ~6MB) dan mengunduh dengan benar; percobaan "Perpanjang" dua kali pada kontrak yang sama sekarang benar-benar diblokir server (409) alih-alih membuat draft duplikat. Dua kontrak duplikat lama yang sempat lolos sebelum guard ini terpasang (dibuat 19 detik berselisih saat testing) sudah dibersihkan dari database produksi lokal.

### 1b. Dashboard Analitik Lanjutan — filter, zoom, drill-down real-time

Sebelumnya dashboard Analytics & Risk sudah menampilkan grafik nyata (tren bulanan, breakdown kategori, top vendor, forecast jatuh tempo) tapi tidak bisa difilter atau diperbesar — sekarang ditambahkan:

- **Filter kategori real-time**: dropdown kategori (diambil dinamis dari daftar folder/kategori yang ada) memfilter seluruh dashboard — KPI, tren bulanan, breakdown status, top vendor, forecast — langsung dari server (`GET /api/analytics?category=Vendor`), bukan filter sisi klien atas data yang sudah dipotong.
- **Zoom rentang waktu tren bulanan**: tombol 3/6/12/24 bulan mengatur jendela waktu grafik tren (`GET /api/analytics?months=6`), memperbesar/perkecil cakupan data secara real-time tanpa reload halaman.
- **Drill-down eksplorasi**: klik salah satu bar kategori atau vendor di grafik langsung membawa pengguna ke tab Monitoring dengan filter kategori/pencarian vendor yang sama otomatis diterapkan — menjadikannya benar-benar "dieksplorasi", bukan sekadar dilihat.

Endpoint `/api/analytics` menerima dua query param baru: `category` (opsional, default semua) dan `months` (3/6/12/24, default 12). Tidak ada breaking change — memanggil endpoint tanpa param tetap berperilaku seperti sebelumnya (semua kategori, 12 bulan).

### 2. SMTP (Email) — `email.ts`

Modul baru dengan pola *honest degradation*: kalau SMTP belum dikonfigurasi, aplikasi TIDAK berpura-pura berhasil — response akan melaporkan `emailSent: false` / status 503.

**Environment variable baru (opsional, isi hanya jika ingin kirim email sungguhan):**

```
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=
```

Lihat `.env.example` untuk penjelasan tiap variabel. Selama variabel ini kosong, fitur "Kirim PDF via Email" akan menampilkan status "belum dikonfigurasi" — tidak error, tidak pura-pura terkirim.

**Cara pakai:** Konfigurasi > Kelola Perusahaan menampilkan status koneksi SMTP + tombol test koneksi (super admin). Tombol "Kirim PDF (Email/WA)" di workspace kontrak akan mengirim email sungguhan begitu SMTP dikonfigurasi.

### 3. Web Push Notification — `push.ts`

Modul baru berbasis VAPID + Web Push API (library `web-push`). Sama seperti email, memakai pola *honest degradation*.

**Environment variable baru:**

```
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=mailto:admin@domainanda.co
```

Generate dengan: `npx web-push generate-vapid-keys`. Kunci contoh sudah diisi di `.env` untuk keperluan development/testing lokal — ganti dengan kunci milik Anda sendiri sebelum produksi.

**Cara pakai:** tombol "Aktifkan Notifikasi" di UI akan meminta izin browser lalu mendaftarkan subscription. Reminder jatuh tempo, perubahan status kontrak, dan komentar baru (termasuk saat di-mention) akan mengirim push notification nyata ke browser yang sudah subscribe — bahkan saat tab tidak aktif. Subscription yang sudah kadaluarsa (404/410 dari layanan push) otomatis dibersihkan dari database.

### 4. Kolaborasi Komentar per Klausul

- Endpoint baru: `GET /api/users/mentionable` — daftar pengguna aktif di tenant yang sama (untuk picker mention), tidak termasuk diri sendiri.
- `PUT /api/contracts/:id/comments/:cid` sekarang memisahkan izin: edit teks komentar (pemilik/admin/legal saja) vs toggle resolved (siapa saja peserta diskusi).
- Komentar yang menyertakan mention akan memicu push notification + notifikasi in-app ke pengguna yang di-mention.
- UI: tombol "@" di panel komentar membuka daftar centang pengguna, otomatis menyisipkan `@Nama` ke teks komentar.

### 5. Folder Arsip 3-Layer

Struktur baru: **Kategori (folder utama, sudah ada) > Sub Folder > Sub-Sub Folder** (maksimal 2 level di bawah kategori).

**Model data baru** (`src/types.ts`):

```ts
interface SubFolder {
  id: string;
  tenantId: string;
  category: string;      // folder utama (kategori) tempat sub folder ini berada
  parentId: string | null; // null = sub folder langsung di bawah kategori
  name: string;
  createdAt: string;
}
```

`Contract.subFolderId?: string` — opsional, menunjuk ke `SubFolder` tempat kontrak ini diarsipkan. Kontrak tanpa `subFolderId` tetap tampil di level kategori (root), persis seperti perilaku lama — **tidak ada migrasi data yang diperlukan**.

**Endpoint baru** (`server.ts`):

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/subfolders?category=X` | daftar sub folder milik tenant, bisa difilter per kategori |
| POST | `/api/subfolders` | buat sub/sub-sub folder baru (`category`, `parentId`, `name`); ditolak jika akan membuat level ke-3 |
| PUT | `/api/subfolders/:id` | ubah nama |
| DELETE | `/api/subfolders/:id` | hapus; ditolak jika masih punya sub folder anak, atau masih dipakai kontrak |

**Cara pakai:**
- **Arsip Dokumen**: buka folder kategori → breadcrumb drill-down, tombol "Sub Folder Baru" / "Sub-Sub Folder Baru" di tiap level, hover kartu folder untuk ubah nama/hapus.
- **Buat Kontrak Baru**: setelah memilih Kategori, muncul dropdown "Sub Folder" (opsional); jika sub folder itu punya anak, muncul dropdown kedua "Sub-Sub Folder". Mengganti Kategori akan mereset pilihan folder.
- **Daftarkan Dokumen Upload**: dropdown sub folder muncul otomatis begitu kategori yang dipilih sudah punya sub folder.

### Dependency baru

| Package | Alasan |
|---|---|
| `html2canvas-pro` (ganti `html2canvas`) | dukungan warna `oklch()` dari Tailwind v4 |
| `nodemailer` + `@types/nodemailer` | pengiriman email SMTP |
| `web-push` + `@types/web-push` | Web Push API (VAPID) |

### Panduan Migrasi

Untuk instalasi yang sudah berjalan (existing deployment):

1. `npm install` — menarik dependency baru di atas.
2. Tidak perlu migrasi data manual. Tabel `sub_folders` baru dibuat otomatis saat server pertama kali start (lihat `db.ts`, dijalankan lewat blok bootstrap SQL yang sudah defensif terhadap instalasi lama).
3. Isi variabel `.env` baru (SMTP_*, VAPID_*) hanya jika ingin mengaktifkan email/push sungguhan — jika dibiarkan kosong, fitur terkait akan melaporkan status "belum dikonfigurasi" dengan aman, tanpa memecahkan fitur lain.
4. Restart server. Kontrak lama otomatis muncul di level folder kategori (root) di menu Arsip Dokumen karena `subFolderId` mereka kosong — tidak perlu tindakan tambahan.
