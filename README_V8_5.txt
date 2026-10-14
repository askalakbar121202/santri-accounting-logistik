ACCOUNTING LOGISTIK SANTRI V8.5 — AZKAL GRAFFITI CLOUD

ISI PAKET
- index.html: UI aplikasi yang mempertahankan fitur V8.4 (transaksi, pembayaran, laporan, deteksi duplikat, rekonsiliasi, riwayat, analisis armada, kasbon, tutup kas, backup/restore).
- server.js: API login, session, state cloud, dan manajemen akun admin.
- PostgreSQL: database bersama lintas lokasi.
- Dockerfile + render.yaml: contoh deploy ke hosting Docker seperti Render.

PENTING: ZIP INI ADALAH PAKET UNTUK DI-DEPLOY, BUKAN SERVER YANG SUDAH ONLINE. Anda perlu akun hosting dan database PostgreSQL sendiri. URL online dan kredensial database tidak bisa dibuat tanpa akses akun hosting Anda.

CARA DEPLOY (contoh Render)
1. Buat database PostgreSQL di provider hosting dan salin internal/external DATABASE_URL yang sesuai.
2. Upload folder proyek ini ke repository Git pribadi, atau deploy Dockerfile melalui hosting yang mendukung Docker. Jangan unggah file yang berisi password rahasia.
3. Buat Web Service dari repository/Dockerfile. Isi environment: DATABASE_URL, SESSION_SECRET (acak minimal 32 karakter), SETUP_KEY (acak rahasia), NODE_ENV=production, PGSSL=require jika provider mensyaratkan TLS.
4. Pastikan service dan database menggunakan jaringan/URL yang dapat saling mengakses. Deploy.
5. Buat admin pertama dengan POST https://ALAMAT-APP-ANDA/api/setup dan header x-setup-key: nilai SETUP_KEY, body JSON {"username":"admin","password":"PASSWORD-PANJANG-ANDA"}. Contoh cURL: curl -X POST 'https://ALAMAT-APP-ANDA/api/setup' -H 'Content-Type: application/json' -H 'x-setup-key: ISI_SETUP_KEY' -d '{"username":"admin","password":"GANTI_DENGAN_PASSWORD_MINIMAL_12_KARAKTER"}'
6. Buka URL web service (https://...) lalu login. Tambah user melalui API admin POST /api/users dengan session login admin dan JSON {"username":"accounting1","password":"PASSWORD_MINIMAL_12","role":"accounting"}. Role tersedia: admin, accounting, staff.
7. Uji login dari browser/perangkat berbeda. Gunakan HTTPS. Simpan DATABASE_URL, SESSION_SECRET, SETUP_KEY, dan password di tempat aman.

MEMINDAHKAN DATA DARI V8.4 LOKAL
- Di V8.4 lama, buka Pengaturan & Backup > Backup Data JSON.
- Setelah V8.5 online dan login sebagai admin, buka Pengaturan & Backup > Impor Backup, lalu pilih file JSON hasil backup V8.4. Konfirmasi dua kali dan tunggu proses sinkronisasi selesai. Fitur pemulihan aplikasi akan mengirim state ke database cloud. Uji dengan backup salinan terlebih dahulu.
- Data yang masih tersimpan hanya di localStorage dan belum dibackup tidak otomatis berpindah ke server. Database cloud dimulai kosong; impor file JSON backup V8.4 untuk memindahkan data.

CATATAN TEKNIS DAN BATASAN
- Semua browser pengguna terautentikasi mengakses satu dokumen state JSON bersama di PostgreSQL. Untuk penggunaan produksi dengan banyak operator simultan, state JSON bersama ini masih prototipe; lakukan uji konkurensi dan audit sebelum dipakai untuk pembukuan resmi.
- Fitur login dan session disediakan di server; pembatasan menu/izin per transaksi secara granular belum diimplementasikan. Role saat ini membatasi endpoint manajemen pengguna, bukan setiap tindakan dalam UI.
- Sinkronisasi menyimpan state setelah perubahan UI; backup berkala tetap wajib. Jika beberapa pengguna menyimpan bersamaan, perubahan dapat saling menimpa. Jangan gunakan untuk data resmi sebelum uji coba, backup, dan peninjauan teknis.
- Buka aplikasi lewat alamat server, bukan klik index.html langsung, karena login dan API memerlukan backend.
