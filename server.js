'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.KB_DB_PATH || (
  process.env.VERCEL
    ? '/tmp/kb-realtime.sqlite'
    : path.join(ROOT, 'data', 'kb-realtime.sqlite')
);
const ADMIN_EMAIL = String(process.env.KB_ADMIN_EMAIL || 'admin@example.local').toLowerCase();
const ADMIN_PASSWORD = process.env.KB_ADMIN_PASSWORD || '';
const TEST_MODE = process.env.KB_TEST_MODE === '1';
const ADMIN_AUTH_TTL_SECONDS = 60 * 60 * 12;
const USER_AUTH_TTL_SECONDS = 60 * 60 * 24 * 30;
const ADMIN_SESSION_SECRET = process.env.KB_ADMIN_SESSION_SECRET ||
  crypto.createHash('sha256').update(`${ADMIN_PASSWORD}:kb-admin-session:v1`).digest('hex');
const USER_SESSION_SECRET = process.env.KB_USER_SESSION_SECRET ||
  crypto.createHash('sha256').update(`${ADMIN_PASSWORD}:kb-user-session:v1`).digest('hex');
const REDIS_URL = String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '');
const SHARED_STATE_ENABLED = !!(REDIS_URL && REDIS_TOKEN);

if (ADMIN_PASSWORD.length < 12) {
  console.error('KB_ADMIN_PASSWORD wajib diisi dan minimal 12 karakter.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RESTRICTED','BLOCKED')),
  access_state TEXT NOT NULL DEFAULT 'ALLOWED' CHECK(access_state IN ('ALLOWED','DENIED')),
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  online_until TEXT,
  last_activity TEXT,
  current_page TEXT NOT NULL DEFAULT '/#top',
  progress INTEGER NOT NULL DEFAULT 0,
  chat_status TEXT NOT NULL DEFAULT 'OFFLINE'
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  current_page TEXT NOT NULL DEFAULT '/#top',
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','OPERATOR','CUSTOMER_SUPPORT')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('USER','ADMIN')),
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SENT','DELIVERED','READ')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id),
  target_user_id TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  reason TEXT,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS navigation_commands (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL REFERENCES admins(id),
  route_id TEXT NOT NULL,
  route_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

const ROUTES = Object.freeze({
  home: { id: 'home', label: 'Beranda', path: '/#top', progress: 10 },
  process: { id: 'process', label: 'Proses Pengajuan', path: '/#proses', progress: 35 },
  products: { id: 'products', label: 'Jenis Pinjaman', path: '/#jenis-pinjaman', progress: 65 },
  footer: { id: 'footer', label: 'Informasi & Footer', path: '/#footer-kb-bank', progress: 90 }
});
const PATH_TO_ROUTE = new Map(Object.values(ROUTES).map(r => [r.path, r]));

const PERMISSIONS = Object.freeze({
  SUPER_ADMIN: new Set(['monitor','chat','navigate','allow','deny','restrict','block','unblock','terminate','audit','manage_admins','content']),
  OPERATOR: new Set(['monitor','chat','navigate']),
  CUSTOMER_SUPPORT: new Set(['chat'])
});

const now = () => new Date().toISOString();
const id = (prefix='id') => `${prefix}_${crypto.randomUUID()}`;
const safeJson = obj => JSON.stringify(obj ?? null);
const parseJsonSafe = v => { try { return JSON.parse(v); } catch { return v; } };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const exp = Buffer.from(expected, 'hex');
  return actual.length === exp.length && crypto.timingSafeEqual(actual, exp);
}

function signAdminAuth(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyAdminAuth(token) {
  try {
    const [body,sig] = String(token||'').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(body).digest();
    const actual = Buffer.from(sig,'base64url');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected,actual)) return null;
    const payload = JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if (!payload?.id || !payload?.role || !payload?.csrf || Number(payload.exp||0) <= Date.now()) return null;
    if (!PERMISSIONS[payload.role]) return null;
    return payload;
  } catch { return null; }
}

function signUserAuth(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', USER_SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyUserAuth(token) {
  try {
    const [body,sig] = String(token||'').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', USER_SESSION_SECRET).update(body).digest();
    const actual = Buffer.from(sig,'base64url');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected,actual)) return null;
    const payload = JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if (!payload?.uid || !payload?.sid || !payload?.csrf || Number(payload.exp||0) <= Date.now()) return null;
    return payload;
  } catch { return null; }
}
function issueUserAuth(res,user,session) {
  if (!user?.id || !session?.id || !session?.csrf_token) return;
  const token=signUserAuth({
    uid:user.id,sid:session.id,csrf:session.csrf_token,name:user.full_name||'',
    iat:now(),exp:Date.now()+(USER_AUTH_TTL_SECONDS*1000)
  });
  setCookie(res,'kb_user_auth',token,{maxAge:USER_AUTH_TTL_SECONDS});
}

const existingAdmin = db.prepare('SELECT id FROM admins WHERE email=?').get(ADMIN_EMAIL);
if (!existingAdmin) {
  db.prepare('INSERT INTO admins(id,email,full_name,role,password_hash,created_at,active) VALUES(?,?,?,?,?,?,1)')
    .run(id('adm'), ADMIN_EMAIL, 'Super Admin', 'SUPER_ADMIN', hashPassword(ADMIN_PASSWORD), now());
}

function cookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function setCookie(res, name, value, opts={}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (opts.maxAge) bits.push(`Max-Age=${opts.maxAge}`);
  if (process.env.NODE_ENV === 'production') bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [...(Array.isArray(prev)?prev:[prev]), bits.join('; ')] : bits.join('; '));
}

async function redisCommand(...args) {
  if (!SHARED_STATE_ENABLED) return null;
  try {
    const response = await fetch(REDIS_URL, {
      method:'POST',
      headers:{ Authorization:`Bearer ${REDIS_TOKEN}`, 'Content-Type':'application/json' },
      body:JSON.stringify(args.map(v=>String(v)))
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.result;
  } catch (error) {
    console.error('Shared state Redis error:', error.message);
    return null;
  }
}
async function saveSharedUser(snapshot) {
  if (!SHARED_STATE_ENABLED || !snapshot?.id) return;
  await Promise.all([
    redisCommand('SET',`kb:user:${snapshot.id}`,JSON.stringify(snapshot),'EX','2592000'),
    redisCommand('SADD','kb:users',snapshot.id)
  ]);
}
async function loadSharedUsers() {
  if (!SHARED_STATE_ENABLED) return [];
  const ids = await redisCommand('SMEMBERS','kb:users');
  if (!Array.isArray(ids) || !ids.length) return [];
  const raw = await Promise.all(ids.slice(0,1000).map(uid=>redisCommand('GET',`kb:user:${uid}`)));
  return raw.map(v=>{ try { return v ? JSON.parse(v) : null; } catch { return null; } }).filter(Boolean);
}

async function loadSharedUser(userId) {
  if (!SHARED_STATE_ENABLED || !userId) return null;
  const raw=await redisCommand('GET',`kb:user:${userId}`);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

const HERO_CONTENT_KEY = 'hero:meta';
const HERO_IMAGE_KEY = 'hero:image';
const HERO_DEFAULT = Object.freeze({
  chip_one_title: 'KBstar',
  chip_one_subtitle: 'Digital banking experience',
  chip_two_title: 'Pengajuan digital',
  chip_two_subtitle: 'Lebih ringkas & terarah',
  caption: 'KB Bank × KBstar',
  image_alt: 'Visual kampanye KBstar dari KB Bank',
  has_custom_image: false,
  image_mime: null,
  updated_at: null
});
const HERO_IMAGE_MAX_BYTES = 600 * 1024;

function contentRedisKey(key) {
  return `kb:content:${key}`;
}
function getLocalContent(key) {
  const row=db.prepare('SELECT value FROM content_store WHERE key=?').get(key);
  return row?.value ?? null;
}
function setLocalContent(key,value) {
  const t=now();
  db.prepare(`INSERT INTO content_store(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(key,String(value),t);
}
function deleteLocalContent(key) {
  db.prepare('DELETE FROM content_store WHERE key=?').run(key);
}
async function getContentValue(key) {
  if (SHARED_STATE_ENABLED) {
    const value=await redisCommand('GET',contentRedisKey(key));
    if (value !== null && value !== undefined) return String(value);
  }
  return getLocalContent(key);
}
async function setContentValue(key,value) {
  setLocalContent(key,value);
  if (SHARED_STATE_ENABLED) await redisCommand('SET',contentRedisKey(key),String(value));
}
async function deleteContentValue(key) {
  deleteLocalContent(key);
  if (SHARED_STATE_ENABLED) await redisCommand('DEL',contentRedisKey(key));
}
function heroText(value,max,required=true) {
  const out=String(value??'').trim().replace(/\s+/g,' ').slice(0,max);
  return required && !out ? null : out;
}
async function loadHeroMeta() {
  const raw=await getContentValue(HERO_CONTENT_KEY);
  let saved={};
  try { saved=raw ? JSON.parse(raw) : {}; } catch {}
  return {
    ...HERO_DEFAULT,
    ...saved,
    has_custom_image:!!saved.has_custom_image,
    image_mime:saved.image_mime||null,
    updated_at:saved.updated_at||null
  };
}
async function saveHeroMeta(meta) {
  await setContentValue(HERO_CONTENT_KEY,JSON.stringify(meta));
}
function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length<12) return null;
  if (buffer[0]===0x89 && buffer[1]===0x50 && buffer[2]===0x4e && buffer[3]===0x47 &&
      buffer[4]===0x0d && buffer[5]===0x0a && buffer[6]===0x1a && buffer[7]===0x0a) return 'image/png';
  if (buffer[0]===0xff && buffer[1]===0xd8 && buffer[2]===0xff) return 'image/jpeg';
  if (buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return 'image/webp';
  return null;
}
function publicHero(meta) {
  return {
    chip_one_title:meta.chip_one_title,
    chip_one_subtitle:meta.chip_one_subtitle,
    chip_two_title:meta.chip_two_title,
    chip_two_subtitle:meta.chip_two_subtitle,
    caption:meta.caption,
    image_alt:meta.image_alt,
    has_custom_image:!!meta.has_custom_image,
    image_url:meta.has_custom_image ? `/api/public/hero-image?v=${encodeURIComponent(meta.updated_at||'1')}` : null,
    updated_at:meta.updated_at
  };
}
function heroAuditSnapshot(meta) {
  return {
    chip_one_title:meta.chip_one_title,
    chip_one_subtitle:meta.chip_one_subtitle,
    chip_two_title:meta.chip_two_title,
    chip_two_subtitle:meta.chip_two_subtitle,
    caption:meta.caption,
    image_alt:meta.image_alt,
    has_custom_image:!!meta.has_custom_image,
    image_mime:meta.image_mime||null,
    updated_at:meta.updated_at||null
  };
}
function json(res, status, data, extra={}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra });
  res.end(JSON.stringify(data));
}
function text(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type':type, 'Cache-Control':'no-store' });
  res.end(body);
}
function readBody(req, max=64_000) {
  return new Promise((resolve,reject) => {
    let data='';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > max) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}
function normalizeName(v) {
  return String(v||'').trim().replace(/\s+/g,' ').slice(0,100);
}
function redactSensitive(v) {
  let s = String(v||'').trim().slice(0,2000);
  const labels = '(password|passcode|pin|otp|cvv|token|secret|kode\\s*keamanan)';
  s = s.replace(new RegExp(`(${labels}\\s*[:=]?\\s*)([^\\s,;]{2,})`, 'gi'), '$1[REDACTED]');
  return s;
}
function routeFromInput(page) {
  const value = String(page || '/#top');
  if (PATH_TO_ROUTE.has(value)) return PATH_TO_ROUTE.get(value);
  if (value === '/' || value === '/index.html') return ROUTES.home;
  const hash = value.includes('#') ? '/#'+value.split('#')[1] : '/#top';
  return PATH_TO_ROUTE.get(hash) || ROUTES.home;
}
function logActivity(userId, sessionId, type, detail='') {
  db.prepare('INSERT INTO activity_log(id,user_id,session_id,type,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(id('act'), userId, sessionId || null, type, String(detail).slice(0,1000), now());
}
function audit(admin, targetUserId, action, previousState, newState, reason='', metadata={}) {
  db.prepare('INSERT INTO audit_log(id,admin_id,target_user_id,action,created_at,previous_state,new_state,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id('aud'), admin.id, targetUserId || null, action, now(), safeJson(previousState), safeJson(newState), String(reason||'').slice(0,500), safeJson(metadata));
}

function userState(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  return u ? { status:u.status, access_state:u.access_state, blocked_reason:u.blocked_reason } : null;
}
function adminHas(admin, permission) {
  return !!admin && PERMISSIONS[admin.role]?.has(permission);
}

const adminStreams = new Map();
const userStreams = new Map();
function addStream(map, key, res) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(res);
  res.on('close', () => {
    map.get(key)?.delete(res);
    if (map.get(key)?.size === 0) map.delete(key);
  });
}
function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; } catch { return false; }
}
function broadcastAdmins(event, data) {
  for (const set of adminStreams.values()) for (const res of set) sseWrite(res,event,data);
}
function broadcastUser(userId,event,data) {
  for (const res of userStreams.get(userId) || []) sseWrite(res,event,data);
}
function broadcastAllUsers(event,data) {
  for (const set of userStreams.values()) for (const res of set) sseWrite(res,event,data);
}
setInterval(() => {
  for (const set of adminStreams.values()) for (const res of set) res.write(': ping\n\n');
  for (const set of userStreams.values()) for (const res of set) res.write(': ping\n\n');
}, 15000).unref();

function ensureUser(req,res,{create=true}={}) {
  const c = cookies(req);
  const signed=verifyUserAuth(c.kb_user_auth);
  let userId = signed?.uid || c.kb_uid;
  let sessionId = signed?.sid || c.kb_sid;
  let user = userId ? db.prepare('SELECT * FROM users WHERE id=?').get(userId) : null;
  const t = now();

  // Reconcile the canonical name carried by the signed user cookie into any
  // existing local /tmp mirror. This prevents a blank/stale name when a Vercel
  // request lands on an instance that had already created the same user row.
  const signedName = normalizeName(signed?.name || '');
  if (user && signedName && normalizeName(user.full_name) !== signedName) {
    db.prepare('UPDATE users SET full_name=?,updated_at=?,last_activity=? WHERE id=?').run(signedName,t,t,user.id);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  }

  // Preserve cookie-issued IDs across serverless instances instead of creating
  // duplicate users/sessions whenever Vercel starts with a fresh /tmp DB.
  if (!user && create) {
    userId = userId || id('usr');
    db.prepare('INSERT INTO users(id,full_name,created_at,updated_at,last_activity,online_until,current_page,progress,chat_status) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(userId,signedName||null,t,t,t,new Date(Date.now()+30000).toISOString(),'/#top',10,'ONLINE');
    user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    setCookie(res,'kb_uid',userId,{maxAge:USER_AUTH_TTL_SECONDS});
    logActivity(userId,null,'USER_CREATED','Website session identity created');
    broadcastAdmins('user.created',{user_id:userId});
  }
  if (!user) return { error:'NO_USER' };
  if (user.status === 'BLOCKED') return { error:'BLOCKED', user };
  if (user.access_state === 'DENIED') return { error:'ACCESS_DENIED', user };

  let session = sessionId ? db.prepare('SELECT * FROM user_sessions WHERE id=? AND user_id=?').get(sessionId,user.id) : null;
  if (session?.revoked_at) return { error:'SESSION_TERMINATED', user, session };
  if (!session && create) {
    sessionId = sessionId || id('ses');
    const csrf = signed?.uid===user.id && signed?.sid===sessionId && signed?.csrf
      ? String(signed.csrf)
      : crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO user_sessions(id,user_id,csrf_token,created_at,last_activity,current_page) VALUES(?,?,?,?,?,?)')
      .run(sessionId,user.id,csrf,t,t,user.current_page || '/#top');
    session = db.prepare('SELECT * FROM user_sessions WHERE id=?').get(sessionId);
    setCookie(res,'kb_sid',sessionId,{maxAge:USER_AUTH_TTL_SECONDS});
    logActivity(user.id,sessionId,'SESSION_STARTED','User session started');
    broadcastAdmins('session.started',{user_id:user.id,session_id:sessionId});
  }

  // Refresh the signed stateless session whenever an older browser is upgraded
  // or a new serverless instance had to recreate the local mirror.
  if (create && session && (!signed || signed.uid!==user.id || signed.sid!==session.id || signed.csrf!==session.csrf_token || normalizeName(signed.name)!==normalizeName(user.full_name))) {
    issueUserAuth(res,user,session);
  }
  return { user, session };
}

function ensureAdmin(req,res) {
  const c = cookies(req);

  // Vercel-safe stateless admin auth. This does not depend on /tmp SQLite
  // and therefore survives requests landing on different serverless instances.
  const signed = verifyAdminAuth(c.kb_admin_auth);
  if (signed) {
    return {
      admin:{id:signed.id,email:signed.email,full_name:signed.full_name,role:signed.role},
      session:{id:`signed:${signed.id}`,csrf_token:signed.csrf,created_at:signed.iat,last_activity:now()}
    };
  }

  // Backward-compatible fallback for local/VPS deployments.
  const sid = c.kb_admin_sid;
  if (!sid) return { error:'UNAUTHENTICATED' };
  const row = db.prepare(`SELECT s.*,a.email,a.full_name,a.role,a.active FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.id=?`).get(sid);
  if (!row || row.revoked_at || !row.active) return { error:'UNAUTHENTICATED' };
  db.prepare('UPDATE admin_sessions SET last_activity=? WHERE id=?').run(now(),sid);
  return { admin:{id:row.admin_id,email:row.email,full_name:row.full_name,role:row.role}, session:row };
}
function verifyCsrf(req, session) {
  const a=Buffer.from(String(req.headers['x-csrf-token']||'')), b=Buffer.from(String(session.csrf_token||''));
  return a.length===b.length && a.length>0 && crypto.timingSafeEqual(a,b);
}
function enforceUser(req,res) {
  const ctx = ensureUser(req,res,{create:true});
  if (ctx.error === 'BLOCKED') { json(res,403,{error:'BLOCKED',message:'Akses diblokir oleh server.'}); return null; }
  if (ctx.error === 'ACCESS_DENIED') { json(res,403,{error:'ACCESS_DENIED',message:'Akses ditolak oleh server.'}); return null; }
  if (ctx.error === 'SESSION_TERMINATED') { json(res,401,{error:'SESSION_TERMINATED',message:'Session telah diakhiri oleh admin.'}); return null; }
  return ctx;
}
function enforceAdmin(req,res,permission=null) {
  const ctx = ensureAdmin(req,res);
  if (ctx.error) { json(res,401,{error:'UNAUTHENTICATED'}); return null; }
  if (permission && !adminHas(ctx.admin,permission)) { json(res,403,{error:'FORBIDDEN'}); return null; }
  return ctx;
}

async function currentUsers() {
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT id FROM user_sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL ORDER BY s.created_at DESC LIMIT 1) session_id,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.user_id=u.id AND m.sender_type='USER' AND m.status!='READ') unread_messages
    FROM users u ORDER BY u.created_at DESC
  `).all();

  const local = rows.map(r => ({
    id:r.id, full_name:r.full_name || '', status:r.status, access_state:r.access_state,
    online_until:r.online_until, current_page:r.current_page, last_activity:r.last_activity, progress:r.progress,
    chat_status:r.chat_status, session_id:r.session_id, unread_messages:Number(r.unread_messages||0),
    created_at:r.created_at, updated_at:r.updated_at, blocked_reason:r.blocked_reason || null
  }));

  // Merge shared snapshots so identity/presence remains visible even when
  // Vercel routes user/admin requests to different serverless instances.
  const shared = await loadSharedUsers();
  const byId = new Map();
  for (const item of shared) if (item?.id) byId.set(item.id,item);
  for (const item of local) {
    const prev=byId.get(item.id);
    const prevTime=new Date(prev?.updated_at||0).getTime();
    const localTime=new Date(item.updated_at||0).getTime();
    byId.set(item.id, prev && prevTime>localTime ? {...item,...prev} : {...prev,...item});
  }

  const nowMs=Date.now();
  return [...byId.values()].map(r=>{
    const online=!!r.online_until && new Date(r.online_until).getTime()>nowMs;
    return {
      id:r.id,
      full_name:r.full_name || 'Belum diidentifikasi',
      status:r.status || 'ACTIVE',
      access_state:r.access_state || 'ALLOWED',
      online,
      current_page:r.current_page || '/#top',
      last_activity:r.last_activity || r.updated_at || r.created_at,
      progress:Number(r.progress||0),
      chat_status:online?'ONLINE':(r.chat_status||'OFFLINE'),
      session_id:r.session_id || null,
      unread_messages:Number(r.unread_messages||0),
      created_at:r.created_at || r.updated_at || now(),
      blocked_reason:r.blocked_reason || null
    };
  }).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
}
async function dashboardStats() {
  const users = await currentUsers();
  const today = new Date(); today.setHours(0,0,0,0);
  return {
    online_users: users.filter(u=>u.online).length,
    active_sessions: users.filter(u=>u.session_id).length,
    active_chats: users.filter(u=>u.chat_status==='ONLINE').length,
    unread_messages: users.reduce((n,u)=>n+u.unread_messages,0),
    new_users: users.filter(u=>new Date(u.created_at)>=today).length,
    blocked_users: users.filter(u=>u.status==='BLOCKED').length
  };
}

async function syncSharedUserFromDb(userId) {
  if (!SHARED_STATE_ENABLED) return;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) return;
  const session=db.prepare('SELECT id FROM user_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get(userId);
  await saveSharedUser({
    id:u.id,full_name:u.full_name||'',status:u.status,access_state:u.access_state,
    blocked_reason:u.blocked_reason||null,created_at:u.created_at,updated_at:u.updated_at,
    online_until:u.online_until,last_activity:u.last_activity,current_page:u.current_page,
    progress:u.progress,chat_status:u.chat_status,session_id:session?.id||null
  });
}

function serveStatic(req,res,urlPath) {
  let filePath;
  const isPublicIndex = urlPath === '/' || urlPath === '/index.html';
  if (isPublicIndex) filePath = path.join(PUBLIC,'index.html');
  else if (urlPath === '/admin' || urlPath === '/admin/') filePath = path.join(PUBLIC,'admin.html');
  else filePath = path.join(PUBLIC, decodeURIComponent(urlPath).replace(/^\/+/,''));
  if (!filePath.startsWith(PUBLIC)) return text(res,403,'Forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext=path.extname(filePath).toLowerCase();
  const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
  const headers={'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-store':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};

  // Inject the additive hero-content controller without modifying the existing
  // landing-page HTML/design. This keeps the website source frozen while making
  // the right-side KBstar campaign visual manageable from Admin Panel.
  if (isPublicIndex && ext==='.html') {
    let html=fs.readFileSync(filePath,'utf8');
    const tag='<script src="/hero-content.js" defer></script>';
    if (!html.includes(tag)) {
      html=html.includes('</body>') ? html.replace('</body>',`${tag}</body>`) : `${html}${tag}`;
    }
    res.writeHead(200,headers);
    res.end(html);
    return true;
  }

  res.writeHead(200,headers);
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handler(req,res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');

  try {
    if (pathname==='/api/public/hero' && req.method==='GET') {
      const meta=await loadHeroMeta();
      return json(res,200,{hero:publicHero(meta)});
    }

    if (pathname==='/api/public/hero-image' && req.method==='GET') {
      const meta=await loadHeroMeta();
      if(!meta.has_custom_image || !meta.image_mime) return text(res,404,'Not Found');
      const raw=await getContentValue(HERO_IMAGE_KEY);
      if(!raw) return text(res,404,'Not Found');
      let buffer;
      try { buffer=Buffer.from(raw,'base64'); } catch { return text(res,404,'Not Found'); }
      const detected=detectImageMime(buffer);
      if(!detected || detected!==meta.image_mime) return text(res,404,'Not Found');
      res.writeHead(200,{
        'Content-Type':detected,
        'Content-Length':buffer.length,
        'Cache-Control':'public, max-age=31536000, immutable',
        'X-Content-Type-Options':'nosniff'
      });
      res.end(buffer);
      return;
    }

    // User page itself is server-access-controlled when a known identity is blocked/denied/terminated.
    if ((pathname==='/' || pathname==='/index.html') && req.method==='GET') {
      const c=cookies(req);
      if (c.kb_uid) {
        const user=db.prepare('SELECT * FROM users WHERE id=?').get(c.kb_uid);
        if (user?.status==='BLOCKED') return text(res,403,'Akses diblokir oleh server.');
        if (user?.access_state==='DENIED') return text(res,403,'Akses ditolak oleh server.');
      }
      if (c.kb_sid) {
        const s=db.prepare('SELECT revoked_at FROM user_sessions WHERE id=?').get(c.kb_sid);
        if (s?.revoked_at) return text(res,401,'Session telah diakhiri oleh admin.');
      }
      return serveStatic(req,res,pathname);
    }

    if (pathname==='/api/user/bootstrap' && req.method==='GET') {
      const ctx=enforceUser(req,res); if(!ctx) return;
      db.prepare('UPDATE users SET online_until=?,last_activity=?,chat_status=?,updated_at=? WHERE id=?')
        .run(new Date(Date.now()+30000).toISOString(),now(),'ONLINE',now(),ctx.user.id);
      await syncSharedUserFromDb(ctx.user.id);
      const freshUser=db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.id);
      const unread=db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE user_id=? AND sender_type='ADMIN' AND status!='READ'").get(ctx.user.id).n; return json(res,200,{user:{id:freshUser.id,full_name:freshUser.full_name,status:freshUser.status,access_state:freshUser.access_state,current_page:freshUser.current_page},session:{id:ctx.session.id,csrf_token:ctx.session.csrf_token},routes:Object.values(ROUTES),unread_messages:Number(unread||0)});
    }

    if (pathname==='/api/user/identity' && req.method==='POST') {
      const ctx=enforceUser(req,res); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const body=await readBody(req); const fullName=normalizeName(body.full_name);
      if(fullName.length<3) return json(res,422,{error:'INVALID_NAME'});
      const previous=ctx.user.full_name;
      db.prepare('UPDATE users SET full_name=?,updated_at=?,last_activity=? WHERE id=?').run(fullName,now(),now(),ctx.user.id);
      const freshIdentityUser=db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.id);
      issueUserAuth(res,freshIdentityUser,ctx.session);
      logActivity(ctx.user.id,ctx.session.id,'IDENTITY_UPDATED', previous ? 'Full name updated' : 'Full name set');
      await syncSharedUserFromDb(ctx.user.id);
      broadcastAdmins('user.updated',{user_id:ctx.user.id,full_name:fullName});
      return json(res,200,{id:ctx.user.id,full_name:fullName});
    }

    if (pathname==='/api/user/presence' && req.method==='POST') {
      const ctx=enforceUser(req,res); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const body=await readBody(req); const route=routeFromInput(body.page);
      const t=now(), until=new Date(Date.now()+30000).toISOString();
      db.prepare('UPDATE users SET current_page=?,progress=?,online_until=?,last_activity=?,chat_status=?,updated_at=? WHERE id=?')
        .run(route.path,route.progress,until,t,'ONLINE',t,ctx.user.id);
      db.prepare('UPDATE user_sessions SET current_page=?,last_activity=? WHERE id=?').run(route.path,t,ctx.session.id);
      logActivity(ctx.user.id,ctx.session.id,'PAGE_VIEW',route.path);
      await syncSharedUserFromDb(ctx.user.id);
      broadcastAdmins('presence.updated',{user_id:ctx.user.id,current_page:route.path,progress:route.progress});
      return json(res,200,{ok:true,current_page:route.path,progress:route.progress});
    }

    if (pathname==='/api/chat/messages' && req.method==='GET') {
      const ctx=enforceUser(req,res); if(!ctx) return;
      db.prepare("UPDATE chat_messages SET status='READ',read_at=? WHERE user_id=? AND sender_type='ADMIN' AND status!='READ'").run(now(),ctx.user.id);
      const rows=db.prepare(`SELECT m.*, CASE WHEN m.sender_type='USER' THEN u.full_name ELSE a.full_name END sender_name
        FROM chat_messages m JOIN users u ON u.id=m.user_id LEFT JOIN admins a ON a.id=m.sender_id AND m.sender_type='ADMIN'
        WHERE m.user_id=? ORDER BY m.created_at ASC LIMIT 500`).all(ctx.user.id);
      broadcastAdmins('chat.read',{user_id:ctx.user.id,reader:'USER'});
      return json(res,200,{messages:rows.map(r=>({...r,sender_name:r.sender_name||'Customer Care'}))});
    }

    if (pathname==='/api/chat/messages' && req.method==='POST') {
      const ctx=enforceUser(req,res); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const body=await readBody(req); const msg=redactSensitive(body.message);
      if(!msg) return json(res,422,{error:'EMPTY_MESSAGE'});
      const mid=id('msg'), t=now(); const delivered=adminStreams.size>0;
      db.prepare('INSERT INTO chat_messages(id,user_id,sender_type,sender_id,body,status,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(mid,ctx.user.id,'USER',ctx.user.id,msg,delivered?'DELIVERED':'SENT',t,delivered?t:null);
      db.prepare("UPDATE users SET chat_status='ONLINE',last_activity=?,updated_at=? WHERE id=?").run(t,t,ctx.user.id);
      logActivity(ctx.user.id,ctx.session.id,'CHAT_MESSAGE','User sent a chat message');
      await syncSharedUserFromDb(ctx.user.id);
      const payload={id:mid,user_id:ctx.user.id,sender_type:'USER',sender_name:ctx.user.full_name||'Belum diidentifikasi',body:msg,status:delivered?'DELIVERED':'SENT',created_at:t};
      broadcastAdmins('chat.message',payload);
      return json(res,201,payload);
    }

    if (pathname==='/api/chat/typing' && req.method==='POST') {
      const ctx=enforceUser(req,res); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const body=await readBody(req);
      broadcastAdmins('chat.typing',{user_id:ctx.user.id,typing:!!body.typing});
      return json(res,200,{ok:true});
    }

    if (pathname==='/events/user' && req.method==='GET') {
      const ctx=enforceUser(req,res); if(!ctx) return;
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write('retry: 2000\n\n'); addStream(userStreams,ctx.user.id,res);
      db.prepare("UPDATE users SET online_until=?,chat_status='ONLINE',last_activity=?,updated_at=? WHERE id=?")
        .run(new Date(Date.now()+30000).toISOString(),now(),now(),ctx.user.id);
      await syncSharedUserFromDb(ctx.user.id);
      broadcastAdmins('presence.updated',{user_id:ctx.user.id,online:true});
      sseWrite(res,'ready',{user_id:ctx.user.id});
      return;
    }

    if (pathname==='/api/admin/login' && req.method==='POST') {
      const body=await readBody(req); const email=String(body.email||'').toLowerCase().trim();
      const a=db.prepare('SELECT * FROM admins WHERE email=? AND active=1').get(email);
      if(!a || !verifyPassword(String(body.password||''),a.password_hash)) return json(res,401,{error:'INVALID_CREDENTIALS'});
      const sid=id('as'), csrf=crypto.randomBytes(24).toString('base64url'), t=now();
      db.prepare('INSERT INTO admin_sessions(id,admin_id,csrf_token,created_at,last_activity) VALUES(?,?,?,?,?)').run(sid,a.id,csrf,t,t);
      setCookie(res,'kb_admin_sid',sid);
      const authToken=signAdminAuth({
        id:a.id,email:a.email,full_name:a.full_name,role:a.role,csrf,
        iat:t,exp:Date.now()+(ADMIN_AUTH_TTL_SECONDS*1000)
      });
      setCookie(res,'kb_admin_auth',authToken,{maxAge:ADMIN_AUTH_TTL_SECONDS});
      return json(res,200,{admin:{id:a.id,email:a.email,full_name:a.full_name,role:a.role},csrf_token:csrf});
    }

    if (pathname==='/api/admin/me' && req.method==='GET') {
      const ctx=enforceAdmin(req,res); if(!ctx) return;
      return json(res,200,{admin:ctx.admin,csrf_token:ctx.session.csrf_token,permissions:[...PERMISSIONS[ctx.admin.role]],shared_state:SHARED_STATE_ENABLED});
    }

    if (pathname==='/api/admin/content/hero' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'content'); if(!ctx) return;
      const meta=await loadHeroMeta();
      return json(res,200,{hero:publicHero(meta)});
    }

    if (pathname==='/api/admin/content/hero' && req.method==='PUT') {
      const ctx=enforceAdmin(req,res,'content'); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const body=await readBody(req,1_100_000);
      const previous=await loadHeroMeta();

      const next={
        ...previous,
        chip_one_title:heroText(body.chip_one_title,48,true),
        chip_one_subtitle:heroText(body.chip_one_subtitle,80,true),
        chip_two_title:heroText(body.chip_two_title,48,true),
        chip_two_subtitle:heroText(body.chip_two_subtitle,80,true),
        caption:heroText(body.caption,80,false) ?? '',
        image_alt:heroText(body.image_alt,140,true)
      };
      if(!next.chip_one_title || !next.chip_one_subtitle || !next.chip_two_title || !next.chip_two_subtitle || !next.image_alt) {
        return json(res,422,{error:'INVALID_HERO_CONTENT',message:'Judul, subjudul, dan alt gambar wajib diisi.'});
      }

      if(body.remove_image===true) {
        await deleteContentValue(HERO_IMAGE_KEY);
        next.has_custom_image=false;
        next.image_mime=null;
      }

      if(body.image_data) {
        const match=String(body.image_data).match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if(!match) return json(res,422,{error:'INVALID_IMAGE',message:'Gunakan gambar PNG, JPG, atau WebP.'});
        let buffer;
        try { buffer=Buffer.from(match[2],'base64'); } catch { return json(res,422,{error:'INVALID_IMAGE'}); }
        if(!buffer.length || buffer.length>HERO_IMAGE_MAX_BYTES) {
          return json(res,413,{error:'IMAGE_TOO_LARGE',message:'Gambar setelah optimasi maksimal 600 KB.'});
        }
        const detected=detectImageMime(buffer);
        if(!detected || detected!==match[1]) return json(res,422,{error:'INVALID_IMAGE_SIGNATURE'});
        await setContentValue(HERO_IMAGE_KEY,buffer.toString('base64'));
        next.has_custom_image=true;
        next.image_mime=detected;
      }

      next.updated_at=now();
      await saveHeroMeta(next);
      audit(ctx.admin,null,'HERO_CONTENT_UPDATED',heroAuditSnapshot(previous),heroAuditSnapshot(next),'', {section:'hero_visual'});
      const payload={updated_at:next.updated_at};
      broadcastAdmins('content.hero.updated',payload);
      broadcastAllUsers('content.hero.updated',payload);
      return json(res,200,{ok:true,hero:publicHero(next)});
    }

    if (pathname==='/api/admin/dashboard' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'monitor'); if(!ctx) return;
      return json(res,200,{stats:await dashboardStats(),shared_state:SHARED_STATE_ENABLED});
    }

    if (pathname==='/api/admin/users' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'monitor'); if(!ctx) return;
      return json(res,200,{users:await currentUsers(),shared_state:SHARED_STATE_ENABLED});
    }

    if (pathname==='/api/admin/routes' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'navigate'); if(!ctx) return;
      return json(res,200,{routes:Object.values(ROUTES)});
    }

    if (pathname==='/api/admin/chat/users' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'chat'); if(!ctx) return;
      const nowMs=Date.now();
      const rows=db.prepare(`SELECT u.id,u.full_name,u.online_until,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.user_id=u.id AND m.sender_type='USER' AND m.status!='READ') unread_messages
        FROM users u WHERE EXISTS(SELECT 1 FROM chat_messages m2 WHERE m2.user_id=u.id) ORDER BY u.last_activity DESC`).all();
      const sharedNames=new Map((await loadSharedUsers()).map(x=>[x.id,x.full_name]));
      return json(res,200,{users:rows.map(r=>{const online=!!r.online_until&&new Date(r.online_until).getTime()>nowMs;return {id:r.id,full_name:r.full_name||sharedNames.get(r.id)||'Belum diidentifikasi',online,chat_status:online?'ONLINE':'OFFLINE',unread_messages:Number(r.unread_messages||0)}})});
    }

    const navMatch=pathname.match(/^\/api\/admin\/users\/([^/]+)\/navigate$/);
    if (navMatch && req.method==='POST') {
      const ctx=enforceAdmin(req,res,'navigate'); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const targetId=decodeURIComponent(navMatch[1]); const target=db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
      if(!target) return json(res,404,{error:'USER_NOT_FOUND'});
      const body=await readBody(req); const route=ROUTES[String(body.route_id||'')];
      if(!route) return json(res,422,{error:'ROUTE_NOT_ALLOWED'});
      const command={id:id('nav'),user_id:targetId,admin_id:ctx.admin.id,route_id:route.id,route_path:route.path,created_at:now()};
      db.prepare('INSERT INTO navigation_commands(id,user_id,admin_id,route_id,route_path,created_at) VALUES(?,?,?,?,?,?)')
        .run(command.id,targetId,ctx.admin.id,route.id,route.path,command.created_at);
      audit(ctx.admin,targetId,'ASSIST_NAVIGATION',{current_page:target.current_page},{target_route:route.path},body.reason||'',{route_id:route.id});
      broadcastUser(targetId,'navigate',{route_id:route.id,path:route.path,label:route.label,command_id:command.id});
      broadcastAdmins('audit.created',{action:'ASSIST_NAVIGATION',target_user_id:targetId});
      return json(res,200,{ok:true,route});
    }

    const actionMatch=pathname.match(/^\/api\/admin\/users\/([^/]+)\/(allow|deny|restrict|block|unblock|terminate)$/);
    if (actionMatch && req.method==='POST') {
      const targetId=decodeURIComponent(actionMatch[1]), action=actionMatch[2];
      const permission=action==='terminate'?'terminate':action;
      const ctx=enforceAdmin(req,res,permission); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const target=db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
      if(!target) return json(res,404,{error:'USER_NOT_FOUND'});
      const body=await readBody(req); const reason=String(body.reason||'').trim();
      if(action==='block' && reason.length<3) return json(res,422,{error:'REASON_REQUIRED'});
      const prev=userState(targetId), t=now();
      if(action==='allow') db.prepare("UPDATE users SET status='ACTIVE',access_state='ALLOWED',blocked_reason=NULL,updated_at=? WHERE id=?").run(t,targetId);
      if(action==='deny') db.prepare("UPDATE users SET status='RESTRICTED',access_state='DENIED',updated_at=? WHERE id=?").run(t,targetId);
      if(action==='restrict') db.prepare("UPDATE users SET status='RESTRICTED',access_state='ALLOWED',updated_at=? WHERE id=?").run(t,targetId);
      if(action==='block') db.prepare("UPDATE users SET status='BLOCKED',access_state='DENIED',blocked_reason=?,updated_at=? WHERE id=?").run(reason,t,targetId);
      if(action==='unblock') db.prepare("UPDATE users SET status='ACTIVE',access_state='ALLOWED',blocked_reason=NULL,updated_at=? WHERE id=?").run(t,targetId);
      if(action==='terminate') db.prepare("UPDATE user_sessions SET revoked_at=?,revoke_reason=? WHERE user_id=? AND revoked_at IS NULL").run(t,reason||'Terminated by admin',targetId);
      const next=userState(targetId);
      audit(ctx.admin,targetId,action.toUpperCase(),prev,next,reason);
      logActivity(targetId,null,'ADMIN_ACTION',action.toUpperCase());
      if(action==='block' || action==='deny') broadcastUser(targetId,'access.revoked',{action,status:next});
      else if(action==='unblock' || action==='allow') broadcastUser(targetId,'access.restored',{action,status:next});
      else if(action==='terminate') broadcastUser(targetId,'session.terminated',{reason:reason||'Session diakhiri admin'});
      broadcastAdmins('user.updated',{user_id:targetId});
      return json(res,200,{ok:true,state:next});
    }

    const adminChatMatch=pathname.match(/^\/api\/admin\/users\/([^/]+)\/messages$/);
    if(adminChatMatch && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'chat'); if(!ctx) return;
      const targetId=decodeURIComponent(adminChatMatch[1]);
      const target=db.prepare('SELECT id,full_name FROM users WHERE id=?').get(targetId);
      if(!target) return json(res,404,{error:'USER_NOT_FOUND'});
      const sharedTarget=await loadSharedUser(targetId);
      const canonicalTarget={...target,full_name:target.full_name||sharedTarget?.full_name||'Belum diidentifikasi'};
      db.prepare("UPDATE chat_messages SET status='READ',read_at=? WHERE user_id=? AND sender_type='USER' AND status!='READ'").run(now(),targetId);
      const rows=db.prepare(`SELECT m.*, CASE WHEN m.sender_type='USER' THEN u.full_name ELSE a.full_name END sender_name
        FROM chat_messages m JOIN users u ON u.id=m.user_id LEFT JOIN admins a ON a.id=m.sender_id AND m.sender_type='ADMIN'
        WHERE m.user_id=? ORDER BY m.created_at ASC LIMIT 500`).all(targetId);
      broadcastUser(targetId,'chat.read',{reader:'ADMIN'});
      return json(res,200,{user:canonicalTarget,messages:rows.map(r=>({...r,sender_name:r.sender_name||(r.sender_type==='USER'?canonicalTarget.full_name:'Customer Care')}))});
    }
    if(adminChatMatch && req.method==='POST') {
      const ctx=enforceAdmin(req,res,'chat'); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const targetId=decodeURIComponent(adminChatMatch[1]); const target=db.prepare('SELECT id,full_name FROM users WHERE id=?').get(targetId);
      if(!target) return json(res,404,{error:'USER_NOT_FOUND'});
      const body=await readBody(req); const msg=redactSensitive(body.message); if(!msg) return json(res,422,{error:'EMPTY_MESSAGE'});
      const mid=id('msg'),t=now(),delivered=(userStreams.get(targetId)?.size||0)>0;
      db.prepare('INSERT INTO chat_messages(id,user_id,sender_type,sender_id,body,status,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(mid,targetId,'ADMIN',ctx.admin.id,msg,delivered?'DELIVERED':'SENT',t,delivered?t:null);
      const payload={id:mid,user_id:targetId,sender_type:'ADMIN',sender_name:ctx.admin.full_name,body:msg,status:delivered?'DELIVERED':'SENT',created_at:t};
      broadcastUser(targetId,'chat.message',payload); broadcastAdmins('chat.message',payload);
      return json(res,201,payload);
    }

    const typingMatch=pathname.match(/^\/api\/admin\/users\/([^/]+)\/typing$/);
    if(typingMatch && req.method==='POST') {
      const ctx=enforceAdmin(req,res,'chat'); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const body=await readBody(req); broadcastUser(decodeURIComponent(typingMatch[1]),'chat.typing',{typing:!!body.typing,admin:ctx.admin.full_name});
      return json(res,200,{ok:true});
    }

    if(pathname==='/api/admin/audit' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'audit'); if(!ctx) return;
      const rows=db.prepare(`SELECT l.*,a.email admin_email,a.full_name admin_name,u.full_name target_name FROM audit_log l JOIN admins a ON a.id=l.admin_id LEFT JOIN users u ON u.id=l.target_user_id ORDER BY l.created_at DESC LIMIT 500`).all();
      return json(res,200,{audit:rows.map(r=>({...r,previous_state:parseJsonSafe(r.previous_state),new_state:parseJsonSafe(r.new_state),metadata:parseJsonSafe(r.metadata)}))});
    }
    if(pathname==='/api/admin/activity' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'monitor'); if(!ctx) return;
      const rows=db.prepare(`SELECT l.*,u.full_name FROM activity_log l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 500`).all();
      return json(res,200,{activity:rows});
    }
    if(pathname==='/api/admin/admins' && req.method==='GET') {
      const ctx=enforceAdmin(req,res,'manage_admins'); if(!ctx) return;
      const rows=db.prepare('SELECT id,email,full_name,role,created_at,active FROM admins ORDER BY created_at DESC').all();
      return json(res,200,{admins:rows});
    }
    if(pathname==='/api/admin/admins' && req.method==='POST') {
      const ctx=enforceAdmin(req,res,'manage_admins'); if(!ctx) return;
      if(!verifyCsrf(req,ctx.session)) return json(res,403,{error:'CSRF'});
      const body=await readBody(req), email=String(body.email||'').toLowerCase().trim(), fullName=normalizeName(body.full_name), role=String(body.role||'');
      if(!email.includes('@') || fullName.length<3 || !PERMISSIONS[role] || String(body.password||'').length<12) return json(res,422,{error:'INVALID_ADMIN'});
      const aid=id('adm');
      db.prepare('INSERT INTO admins(id,email,full_name,role,password_hash,created_at,active) VALUES(?,?,?,?,?,?,1)').run(aid,email,fullName,role,hashPassword(String(body.password)),now());
      audit(ctx.admin,null,'ADMIN_CREATED',null,{admin_id:aid,email,role},body.reason||'',{});
      return json(res,201,{id:aid,email,full_name:fullName,role});
    }

    if(pathname==='/events/admin' && req.method==='GET') {
      const ctx=enforceAdmin(req,res); if(!ctx) return;
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write('retry: 2000\n\n'); addStream(adminStreams,ctx.admin.id,res); sseWrite(res,'ready',{admin_id:ctx.admin.id}); return;
    }

    if (pathname==='/api/test/reset' && TEST_MODE && req.method==='POST') {
      db.exec('DELETE FROM navigation_commands; DELETE FROM audit_log; DELETE FROM activity_log; DELETE FROM chat_messages; DELETE FROM user_sessions; DELETE FROM users; DELETE FROM admin_sessions;');
      return json(res,200,{ok:true});
    }

    if (pathname.startsWith('/api/') || pathname.startsWith('/events/')) return json(res,404,{error:'NOT_FOUND'});
    if (serveStatic(req,res,pathname)) return;
    return text(res,404,'Not Found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return json(res,500,{error:'SERVER_ERROR'});
    try { res.end(); } catch {}
  }
}

const server=http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => console.log(`KB realtime server: http://127.0.0.1:${PORT}`));

function shutdown(){ try{server.close(()=>{db.close();process.exit(0);});}catch{process.exit(0);} }
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
