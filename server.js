const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { changedRecords, buildBatches, sendBatches } = require('./sheets-sync');

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
const prod = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) { console.error('Wajib mengatur DATABASE_URL dan SESSION_SECRET.'); process.exit(1); }
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20mb' }));
app.use(session({ store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }), secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: prod, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } }));
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS email TEXT
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique
    ON app_users (LOWER(email))
    WHERE email IS NOT NULL AND email <> ''
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      state JSONB NOT NULL,
      pending_tx_batch JSONB NOT NULL DEFAULT '[]'::jsonb,
      revision BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    )
  `);

  await pool.query(`
    INSERT INTO app_state(id, state)
    VALUES (1, '{"transactions":[],"masters":{},"audit":[]}'::jsonb)
    ON CONFLICT(id) DO NOTHING
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_transfer_requests (
      id BIGSERIAL PRIMARY KEY,
      old_user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      new_user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      old_token_hash TEXT NOT NULL UNIQUE,
      new_token_hash TEXT NOT NULL UNIQUE,
      old_verified BOOLEAN NOT NULL DEFAULT FALSE,
      new_verified BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL
        REFERENCES app_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
const auth=(req,res,next)=>req.session.user?next():res.status(401).json({error:'Silakan login terlebih dahulu.'});
const admin=(req,res,next)=>req.session.user?.role==='admin'?next():res.status(403).json({error:'Hanya admin yang dapat melakukan tindakan ini.'});
app.get('/api/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,service:'Santri Accounting Cloud'})}catch(e){res.status(503).json({ok:false})}});
app.post('/api/setup',async(req,res)=>{try{if(!process.env.SETUP_KEY||req.get('x-setup-key')!==process.env.SETUP_KEY)return res.status(403).json({error:'Setup key tidak valid.'});const {username,password}=req.body||{};if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username||'')||typeof password!=='string'||password.length<12)return res.status(400).json({error:'Username 3–32 karakter; password admin minimal 12 karakter.'});const n=await pool.query('SELECT count(*)::int AS n FROM app_users');if(n.rows[0].n>0)return res.status(409).json({error:'Admin awal sudah dibuat. Gunakan menu admin/ubah konfigurasi.'});const hash=await bcrypt.hash(password,12);await pool.query('INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3)',[username,hash,'admin']);res.status(201).json({ok:true,message:'Admin pertama dibuat. Silakan login.'})}catch(e){console.error(e);res.status(500).json({error:'Gagal membuat admin.'})}});
app.post('/api/login',async(req,res)=>{try{const {username,password}=req.body||{};const q=await pool.query('SELECT id,username,password_hash,role,active FROM app_users WHERE username=$1',[String(username||'')]);const u=q.rows[0];if(!u||!u.active||!await bcrypt.compare(String(password||''),u.password_hash))return res.status(401).json({error:'Username atau password salah.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Gagal membuat sesi.'});req.session.user={id:u.id,username:u.username,role:u.role};req.session.save(err2=>err2?res.status(500).json({error:'Gagal menyimpan sesi.'}):res.json({ok:true,username:u.username,role:u.role}))})}catch(e){console.error(e);res.status(500).json({error:'Login gagal.'})}});
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    const cleanUsername = String(username || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Username harus 3–32 karakter dan hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung.'
      });
    }

    if (
      cleanEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return res.status(400).json({
        error: 'Format email tidak valid.'
      });
    }

    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({
        error: 'Password minimal 12 karakter.'
      });
    }

    const hash = await bcrypt.hash(password, 12);

    await pool.query(
      `INSERT INTO app_users
        (username, email, password_hash, role, active)
       VALUES ($1, $2, $3, 'staff', FALSE)`,
      [cleanUsername, cleanEmail, hash]
    );

    return res.status(201).json({
      ok: true,
      message: 'Pendaftaran berhasil. Tunggu persetujuan Admin sebelum login.'
    });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({
        error: 'Username atau email sudah digunakan.'
      });
    }

    console.error('Pendaftaran akun gagal:', e.message);

    return res.status(500).json({
      error: 'Pendaftaran gagal. Silakan coba lagi.'
    });
  }
});

app.post('/api/admin-transfer',auth,admin,async(req,res)=>{
  const client=await pool.connect();
  try{
    const newUserId=Number(req.body?.newUserId);
    if(!Number.isSafeInteger(newUserId)||newUserId<=0||newUserId===Number(req.session.user.id))return res.status(400).json({error:'Pilih akun cloud lain yang valid.'});
    await client.query('BEGIN');
    const oldResult=await client.query('SELECT id,username,email,role,active FROM app_users WHERE id=$1 FOR UPDATE',[req.session.user.id]);
    const newResult=await client.query('SELECT id,username,email,role,active FROM app_users WHERE id=$1 FOR UPDATE',[newUserId]);
    const oldUser=oldResult.rows[0],newUser=newResult.rows[0];
    if(!oldUser||oldUser.role!=='admin'||!oldUser.active){await client.query('ROLLBACK');return res.status(403).json({error:'Akun admin saat ini tidak valid.'});}
    if(!newUser||!newUser.active){await client.query('ROLLBACK');return res.status(400).json({error:'Akun penerima harus sudah disetujui dan aktif.'});}
    if(!oldUser.email||!newUser.email||oldUser.email===newUser.email){await client.query('ROLLBACK');return res.status(400).json({error:'Email admin lama dan akun penerima harus diatur, valid, dan berbeda.'});}
    await client.query("UPDATE admin_transfer_requests SET expires_at=now(), completed_at=COALESCE(completed_at,now()) WHERE completed_at IS NULL AND expires_at>now() AND old_user_id=$1",[oldUser.id]);
    const oldToken=crypto.randomBytes(32).toString('hex'),newToken=crypto.randomBytes(32).toString('hex');
    const hashToken=value=>crypto.createHash('sha256').update(value).digest('hex');
    await client.query(`INSERT INTO admin_transfer_requests(old_user_id,new_user_id,old_token_hash,new_token_hash,expires_at)
      VALUES($1,$2,$3,$4,now()+INTERVAL '30 minutes')`,[oldUser.id,newUser.id,hashToken(oldToken),hashToken(newToken)]);
    await client.query('COMMIT');
    const baseUrl=(process.env.APP_BASE_URL||'https://santri-accounting-logistik.vercel.app').replace(/\/+$/,'');
    try{
      await mailer.sendMail({from:process.env.SMTP_USER,to:oldUser.email,subject:'Verifikasi Pergantian Admin Santri Accounting',text:`Halo ${oldUser.username},\n\nAda permintaan pemindahan hak admin utama ke akun ${newUser.username} (${newUser.email}). Untuk menyetujui, buka tautan ini dalam 30 menit:\n${baseUrl}/?adminTransferToken=${encodeURIComponent(oldToken)}&verify=old\n\nJika bukan Anda yang meminta, abaikan email ini dan segera periksa akun Anda.`});
      await mailer.sendMail({from:process.env.SMTP_USER,to:newUser.email,subject:'Konfirmasi Menjadi Admin Utama Santri Accounting',text:`Halo ${newUser.username},\n\nAnda diminta menerima hak admin utama dari akun ${oldUser.username}. Untuk mengonfirmasi, buka tautan ini dalam 30 menit:\n${baseUrl}/?adminTransferToken=${encodeURIComponent(newToken)}&verify=new\n\nPergantian hanya selesai setelah kedua email diverifikasi.`});
    }catch(mailError){
      await pool.query('UPDATE admin_transfer_requests SET expires_at=now(),completed_at=COALESCE(completed_at,now()) WHERE old_token_hash=$1 OR new_token_hash=$2',[hashToken(oldToken),hashToken(newToken)]);
      console.error('Email verifikasi pergantian admin gagal:',mailError.message);
      return res.status(502).json({error:'Permintaan tersimpan tetapi email verifikasi gagal dikirim. Tidak ada pergantian admin; periksa konfigurasi SMTP sebelum mencoba lagi.'});
    }
    res.json({ok:true,message:'Tautan verifikasi dikirim ke email admin lama dan akun penerima. Kedua tautan harus dibuka dalam 30 menit.'});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('Permintaan pergantian admin gagal:',e.message);res.status(500).json({error:'Tidak dapat memulai pergantian admin.'});}
  finally{client.release();}
});
app.post('/api/admin-transfer/verify',async(req,res)=>{
  const token=String(req.body?.token||'').trim(),step=String(req.body?.step||'');
  if(!/^[a-f0-9]{64}$/i.test(token)||!['old','new'].includes(step))return res.status(400).json({error:'Tautan verifikasi tidak valid.'});
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const column=step==='old'?'old_token_hash':'new_token_hash';
    const verifiedColumn=step==='old'?'old_verified':'new_verified';
    const found=await client.query(`SELECT id,old_user_id,new_user_id,old_verified,new_verified FROM admin_transfer_requests WHERE ${column}=$1 AND completed_at IS NULL AND expires_at>now() FOR UPDATE`,[tokenHash]);
    if(!found.rows.length){await client.query('ROLLBACK');return res.status(400).json({error:'Tautan tidak valid, sudah digunakan, atau kedaluwarsa.'});}
    const transfer=found.rows[0];
    if(transfer[verifiedColumn]){await client.query('ROLLBACK');return res.status(400).json({error:'Tautan verifikasi ini sudah digunakan.'});}
    await client.query(`UPDATE admin_transfer_requests SET ${verifiedColumn}=TRUE WHERE id=$1`,[transfer.id]);
    const oldVerified=step==='old'||transfer.old_verified,newVerified=step==='new'||transfer.new_verified;
    if(oldVerified&&newVerified){
      const users=await client.query('SELECT id,role,active FROM app_users WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',[[transfer.old_user_id,transfer.new_user_id]]);
      const oldUser=users.rows.find(u=>Number(u.id)===Number(transfer.old_user_id));
      const newUser=users.rows.find(u=>Number(u.id)===Number(transfer.new_user_id));
      if(!oldUser||!newUser||!oldUser.active||oldUser.role!=='admin'||!newUser.active){await client.query('ROLLBACK');return res.status(409).json({error:'Akun berubah atau tidak aktif. Tidak ada pergantian admin; mulai ulang proses.'});}
      await client.query("UPDATE app_users SET role='accounting' WHERE id=$1",[transfer.old_user_id]);
      await client.query("UPDATE app_users SET role='admin' WHERE id=$1",[transfer.new_user_id]);
      await client.query('UPDATE admin_transfer_requests SET completed_at=now() WHERE id=$1',[transfer.id]);
      await client.query("DELETE FROM user_sessions WHERE sess->'user'->>'id'=$1",[String(transfer.old_user_id)]);
      await client.query('COMMIT');
      return res.json({ok:true,completed:true,message:'Pergantian admin selesai. Admin lama menjadi Accounting dan sesi lamanya dicabut. Akun penerima harus login kembali.'});
    }
    await client.query('COMMIT');
    return res.json({ok:true,completed:false,message:'Email berhasil diverifikasi. Pergantian belum selesai sampai email satunya juga diverifikasi.'});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('Verifikasi pergantian admin gagal:',e.message);res.status(500).json({error:'Verifikasi gagal. Silakan hubungi admin aplikasi.'});}
  finally{client.release();}
});

app.post('/api/forgot-password', async (req, res) => {
  const safeMessage =
    'Jika email terdaftar, instruksi reset password akan dikirim.';

  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();

    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.json({ ok: true, message: safeMessage });
    }

    const result = await pool.query(
      `SELECT id, username, email
       FROM app_users
       WHERE LOWER(email) = $1 AND active = TRUE
       LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: true, message: safeMessage });
    }

    const user = result.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    await pool.query(
      `UPDATE password_reset_tokens
       SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    await pool.query(
      `INSERT INTO password_reset_tokens
       (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + INTERVAL '15 minutes')`,
      [user.id, tokenHash]
    );

    const baseUrl = (
      process.env.APP_BASE_URL ||
      'https://santri-accounting-logistik.vercel.app'
    ).replace(/\/+$/, '');

    const resetUrl =
      `${baseUrl}/?resetToken=${encodeURIComponent(token)}`;

    try {
      await mailer.sendMail({
        from: process.env.SMTP_USER,
        to: user.email,
        subject: 'Reset Password Santri Accounting - Logistic',
        text:
          `Halo ${user.username},\n\n` +
          `Gunakan tautan berikut untuk mengatur ulang password:\n` +
          `${resetUrl}\n\n` +
          `Tautan berlaku selama 15 menit dan hanya dapat digunakan sekali.\n` +
          `Jika Anda tidak meminta reset password, abaikan email ini.`
      });
    } catch (mailError) {
      await pool.query(
        `UPDATE password_reset_tokens
         SET used_at = now()
         WHERE token_hash = $1`,
        [tokenHash]
      );
      throw mailError;
    }

    return res.json({ ok: true, message: safeMessage });
  } catch (e) {
    console.error('Permintaan reset password gagal:', e.message);
    return res.status(500).json({
      error: 'Permintaan reset password gagal. Silakan coba lagi.'
    });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const client = await pool.connect();

  try {
    const token = String(req.body?.token || '').trim();
    const password = req.body?.password;

    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).json({
        error: 'Tautan reset password tidak valid atau sudah kedaluwarsa.'
      });
    }

    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({
        error: 'Password baru minimal 12 karakter.'
      });
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    await client.query('BEGIN');

    const result = await client.query(
      `SELECT t.id, t.user_id
       FROM password_reset_tokens t
       JOIN app_users u ON u.id = t.user_id
       WHERE t.token_hash = $1
         AND t.used_at IS NULL
         AND t.expires_at > now()
         AND u.active = TRUE
       FOR UPDATE OF t`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Tautan reset password tidak valid atau sudah kedaluwarsa.'
      });
    }

    const reset = result.rows[0];
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query(
      `UPDATE app_users
       SET password_hash = $1
       WHERE id = $2`,
      [passwordHash, reset.user_id]
    );

    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`,
      [reset.user_id]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      message: 'Password berhasil diubah. Silakan login menggunakan password baru.'
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Reset password gagal:', e.message);

    return res.status(500).json({
      error: 'Reset password gagal. Silakan coba lagi.'
    });
  } finally {
    client.release();
  }
});

app.post('/api/logout',auth,(req,res)=>req.session.destroy(()=>res.clearCookie('connect.sid').json({ok:true})));
app.get('/api/me',auth,(req,res)=>res.json(req.session.user));
app.get('/api/operators',auth,async(req,res)=>{try{const q=await pool.query("SELECT id,username,role FROM app_users WHERE active=TRUE ORDER BY username");res.json(q.rows.map(u=>({...u,isCurrentUser:Number(u.id)===Number(req.session.user.id)})))}catch(e){console.error('Gagal memuat operator cloud:',e.message);res.status(500).json({error:'Daftar operator cloud gagal dimuat.'})}});
app.get('/api/state',auth,async(req,res)=>{try{const q=await pool.query('SELECT state,pending_tx_batch,revision,updated_at,updated_by FROM app_state WHERE id=1');res.json({...q.rows[0],revision:Number(q.rows[0].revision)})}catch(e){console.error(e);res.status(500).json({error:'Gagal membaca database.'})}});
app.put('/api/state',auth,async(req,res)=>{
  try {
    const {state,pendingTxBatch=[]}=req.body||{};
    if(!state||!Array.isArray(state.transactions)||!state.masters||typeof state.masters!=='object'||!Array.isArray(pendingTxBatch)) {
      return res.status(400).json({error:'Format data tidak valid.'});
    }

    // Read the last committed state, then persist the new state before contacting Sheets.
    const previous = await pool.query('SELECT state FROM app_state WHERE id=1');
    const previousState = previous.rows[0]?.state || {transactions:[]};
    const q = await pool.query(
      'UPDATE app_state SET state=$1::jsonb,pending_tx_batch=$2::jsonb,revision=revision+1,updated_at=now(),updated_by=$3 WHERE id=1 RETURNING revision,updated_at',
      [JSON.stringify(state),JSON.stringify(pendingTxBatch),req.session.user.username]
    );

    // Only changed records from saved reports are eligible. The temporary pendingTxBatch is never passed.
    const changed = changedRecords(previousState, state);
    const batches = buildBatches(changed);
    let sheetsSync = {status:'not-needed'};
    if (batches.length) {
      try {
        const result = await sendBatches({
          url: process.env.SHEETS_WEB_APP_URL,
          token: process.env.SHEETS_BRIDGE_TOKEN,
          batches
        });
        sheetsSync = result.skipped
          ? {status:'not-configured', message:'Transaksi tersimpan; Google Sheets belum dikonfigurasi.'}
          : {status:'sent', results:result.results || []};
      } catch (syncError) {
        // A Sheets failure must not undo or report failure for the already committed transaction.
        console.error('Google Sheets sync failed after database save:', syncError.message);
        sheetsSync = {status:'failed', message:'Transaksi tersimpan di aplikasi, tetapi Google Sheets belum berhasil diperbarui.'};
      }
    }
    return res.json({
      ok:true,
      revision:Number(q.rows[0].revision),
      updatedAt:q.rows[0].updated_at,
      sheetsSync
    });
  } catch(e) {
    console.error(e);
    return res.status(500).json({error:'Gagal menyimpan ke database.'});
  }
});
app.post('/api/sheets/sync',auth,admin,async(req,res)=>{
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 ||
        ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 150)) {
      return res.status(400).json({error:'Kirim daftar ID transaksi yang dipilih (1–200 ID).'});
    }
    const q = await pool.query('SELECT state FROM app_state WHERE id=1');
    const transactions = Array.isArray(q.rows[0]?.state?.transactions) ? q.rows[0].state.transactions : [];
    const wanted = new Set(ids.map(id => id.trim()));
    const selected = transactions.filter(tx => tx && wanted.has(String(tx.id)));
    if (selected.length !== wanted.size) {
      return res.status(404).json({error:'Satu atau lebih ID transaksi tidak ditemukan.'});
    }
    const batches = buildBatches(selected);
    if (!batches.length) {
      return res.status(400).json({error:'Jenis transaksi yang dipilih belum memiliki pemetaan Google Sheets.'});
    }
    const result = await sendBatches({
      url: process.env.SHEETS_WEB_APP_URL,
      token: process.env.SHEETS_BRIDGE_TOKEN,
      batches
    });
    if (result.skipped) {
      return res.status(503).json({error:'Sinkronisasi belum dikonfigurasi. Tidak ada data yang dikirim.'});
    }
    return res.json({ok:true,results:result.results || [],message:'Transaksi yang dipilih berhasil dikirim ke Google Sheets.'});
  } catch (e) {
    console.error('Sinkronisasi Google Sheets gagal:', e.message);
    return res.status(502).json({error:'Sinkronisasi gagal. Data aplikasi tetap tersimpan; silakan periksa konfigurasi dan coba lagi.'});
  }
});
app.get('/api/users',auth,admin,async(req,res)=>{const q=await pool.query('SELECT id,username,email,role,active,created_at FROM app_users ORDER BY id');res.json(q.rows.map(u=>({...u,isCurrentUser:Number(u.id)===Number(req.session.user.id)})))});
app.post('/api/users',auth,admin,async(req,res)=>{try{const {username,password,role='staff'}=req.body||{};if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username||'')||typeof password!=='string'||password.length<12||!['admin','accounting','staff'].includes(role))return res.status(400).json({error:'Username/role tidak valid; password minimal 12 karakter.'});const hash=await bcrypt.hash(password,12);await pool.query('INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3)',[username,hash,role]);res.status(201).json({ok:true})}catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Username sudah dipakai.':'Gagal menambah pengguna.'})}});
app.patch('/api/users/:id',auth,admin,async(req,res)=>{
  try{
    const {active,role,password,email}=req.body||{};
    if(role&&role!=='admin'){
      const target=await pool.query('SELECT role,active FROM app_users WHERE id=$1',[req.params.id]);
      if(target.rows[0]?.role==='admin'&&target.rows[0]?.active){
        const count=await pool.query("SELECT count(*)::int AS n FROM app_users WHERE role='admin' AND active=TRUE");
        if(count.rows[0].n<=1)return res.status(409).json({error:'Admin aktif terakhir tidak dapat diturunkan perannya.'});
      }
    }
    if(role&&!['admin','accounting','staff'].includes(role))return res.status(400).json({error:'Role tidak valid.'});
    if(Number(req.params.id)===Number(req.session.user.id)&&active===false)return res.status(400).json({error:'Admin aktif tidak dapat menonaktifkan akunnya sendiri.'});
    if(email!==undefined){
      const cleanEmail=String(email||'').trim().toLowerCase();
      if(cleanEmail.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))return res.status(400).json({error:'Format email tidak valid.'});
      await pool.query('UPDATE app_users SET email=$1 WHERE id=$2',[cleanEmail,req.params.id]);
    }
    if(password!==undefined){
      if(typeof password!=='string'||password.length<12)return res.status(400).json({error:'Password minimal 12 karakter.'});
      await pool.query('UPDATE app_users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(password,12),req.params.id]);
    }
    if(role||active!==undefined)await pool.query('UPDATE app_users SET role=COALESCE($1,role),active=COALESCE($2,active) WHERE id=$3',[role||null,active===undefined?null:!!active,req.params.id]);
    res.json({ok:true});
  }catch(e){
    if(e.code==='23505')return res.status(409).json({error:'Email tersebut sudah digunakan akun lain.'});
    res.status(500).json({error:'Gagal memperbarui pengguna.'});
  }
});
app.delete('/api/users/:id',auth,admin,async(req,res)=>{
  const client=await pool.connect();
  try{
    const targetId=Number(req.params.id);
    if(!Number.isSafeInteger(targetId)||targetId<=0)return res.status(400).json({error:'ID akun tidak valid.'});
    if(targetId===Number(req.session.user.id))return res.status(400).json({error:'Akun yang sedang digunakan tidak dapat dihapus.'});
    await client.query('BEGIN');
    const target=await client.query('SELECT id,username,role,active FROM app_users WHERE id=$1 FOR UPDATE',[targetId]);
    if(!target.rows.length){await client.query('ROLLBACK');return res.status(404).json({error:'Akun tidak ditemukan.'});}
    if(target.rows[0].role==='admin'){await client.query('ROLLBACK');return res.status(409).json({error:'Akun berperan admin tidak dapat dihapus. Pindahkan atau ubah perannya terlebih dahulu.'});}
    await client.query("DELETE FROM user_sessions WHERE sess->'user'->>'id'=$1",[String(targetId)]);
    await client.query('DELETE FROM app_users WHERE id=$1',[targetId]);
    await client.query('COMMIT');
    res.json({ok:true,message:'Akun cloud berhasil dihapus. Data transaksi dan laporan tidak dihapus.'});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('Hapus akun cloud gagal:',e.message);res.status(500).json({error:'Akun cloud gagal dihapus.'});}
  finally{client.release();}
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
init().catch(e => console.error('Database initialization failed', e));

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '0.0.0.0', () => console.log(`Santri Accounting Cloud listening on ${PORT}`));
}

module.exports = app;
