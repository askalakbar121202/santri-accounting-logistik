const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
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
async function init(){ await pool.query(`CREATE TABLE IF NOT EXISTS app_users(id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`); await pool.query(`CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY CHECK(id=1), state JSONB NOT NULL, pending_tx_batch JSONB NOT NULL DEFAULT '[]'::jsonb, revision BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT)`); await pool.query(`INSERT INTO app_state(id,state) VALUES(1,'{"transactions":[],"masters":{},"audit":[]}'::jsonb) ON CONFLICT(id) DO NOTHING`); }
const auth=(req,res,next)=>req.session.user?next():res.status(401).json({error:'Silakan login terlebih dahulu.'});
const admin=(req,res,next)=>req.session.user?.role==='admin'?next():res.status(403).json({error:'Hanya admin yang dapat melakukan tindakan ini.'});
app.get('/api/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,service:'Santri Accounting Cloud'})}catch(e){res.status(503).json({ok:false})}});
app.post('/api/setup',async(req,res)=>{try{if(!process.env.SETUP_KEY||req.get('x-setup-key')!==process.env.SETUP_KEY)return res.status(403).json({error:'Setup key tidak valid.'});const {username,password}=req.body||{};if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username||'')||typeof password!=='string'||password.length<12)return res.status(400).json({error:'Username 3–32 karakter; password admin minimal 12 karakter.'});const n=await pool.query('SELECT count(*)::int AS n FROM app_users');if(n.rows[0].n>0)return res.status(409).json({error:'Admin awal sudah dibuat. Gunakan menu admin/ubah konfigurasi.'});const hash=await bcrypt.hash(password,12);await pool.query('INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3)',[username,hash,'admin']);res.status(201).json({ok:true,message:'Admin pertama dibuat. Silakan login.'})}catch(e){console.error(e);res.status(500).json({error:'Gagal membuat admin.'})}});
app.post('/api/login',async(req,res)=>{try{const {username,password}=req.body||{};const q=await pool.query('SELECT id,username,password_hash,role,active FROM app_users WHERE username=$1',[String(username||'')]);const u=q.rows[0];if(!u||!u.active||!await bcrypt.compare(String(password||''),u.password_hash))return res.status(401).json({error:'Username atau password salah.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Gagal membuat sesi.'});req.session.user={id:u.id,username:u.username,role:u.role};req.session.save(err2=>err2?res.status(500).json({error:'Gagal menyimpan sesi.'}):res.json({ok:true,username:u.username,role:u.role}))})}catch(e){console.error(e);res.status(500).json({error:'Login gagal.'})}});
app.post('/api/logout',auth,(req,res)=>req.session.destroy(()=>res.clearCookie('connect.sid').json({ok:true})));
app.get('/api/me',auth,(req,res)=>res.json(req.session.user));
app.get('/api/state',auth,async(req,res)=>{try{const q=await pool.query('SELECT state,pending_tx_batch,revision,updated_at,updated_by FROM app_state WHERE id=1');res.json({...q.rows[0],revision:Number(q.rows[0].revision)})}catch(e){console.error(e);res.status(500).json({error:'Gagal membaca database.'})}});
app.put('/api/state',auth,async(req,res)=>{try{const {state,pendingTxBatch=[]}=req.body||{};if(!state||!Array.isArray(state.transactions)||!state.masters||typeof state.masters!=='object'||!Array.isArray(pendingTxBatch))return res.status(400).json({error:'Format data tidak valid.'});const q=await pool.query('UPDATE app_state SET state=$1::jsonb,pending_tx_batch=$2::jsonb,revision=revision+1,updated_at=now(),updated_by=$3 WHERE id=1 RETURNING revision,updated_at',[JSON.stringify(state),JSON.stringify(pendingTxBatch),req.session.user.username]);res.json({ok:true,revision:Number(q.rows[0].revision),updatedAt:q.rows[0].updated_at})}catch(e){console.error(e);res.status(500).json({error:'Gagal menyimpan ke database.'})}});
app.get('/api/users',auth,admin,async(req,res)=>{const q=await pool.query('SELECT id,username,role,active,created_at FROM app_users ORDER BY id');res.json(q.rows)});
app.post('/api/users',auth,admin,async(req,res)=>{try{const {username,password,role='staff'}=req.body||{};if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username||'')||typeof password!=='string'||password.length<12||!['admin','accounting','staff'].includes(role))return res.status(400).json({error:'Username/role tidak valid; password minimal 12 karakter.'});const hash=await bcrypt.hash(password,12);await pool.query('INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3)',[username,hash,role]);res.status(201).json({ok:true})}catch(e){res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Username sudah dipakai.':'Gagal menambah pengguna.'})}});
app.patch('/api/users/:id',auth,admin,async(req,res)=>{try{const {active,role,password}=req.body||{};if(role&&!['admin','accounting','staff'].includes(role))return res.status(400).json({error:'Role tidak valid.'});if(Number(req.params.id)===Number(req.session.user.id)&&active===false)return res.status(400).json({error:'Admin aktif tidak dapat menonaktifkan akunnya sendiri.'});if(password){if(password.length<12)return res.status(400).json({error:'Password minimal 12 karakter.'});await pool.query('UPDATE app_users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(password,12),req.params.id])}if(role||active!==undefined)await pool.query('UPDATE app_users SET role=COALESCE($1,role),active=COALESCE($2,active) WHERE id=$3',[role||null,active===undefined?null:!!active,req.params.id]);res.json({ok:true})}catch(e){res.status(500).json({error:'Gagal memperbarui pengguna.'})}});
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
init().catch(e => console.error('Database initialization failed', e));

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '0.0.0.0', () => console.log(`Santri Accounting Cloud listening on ${PORT}`));
}

module.exports = app;