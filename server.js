const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace-this-secret-before-public-use';
const PASSWORD_ENCRYPTION_KEY = process.env.PASSWORD_ENCRYPTION_KEY || SESSION_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const BASE_URL = process.env.BASE_URL || '';
const STARTING_POINTS = Math.max(1, Number(process.env.STARTING_POINTS || 10));
const AVATAR_KEYS = ['avatar-01','avatar-02','avatar-03','avatar-04','avatar-05','avatar-06','avatar-07','avatar-08','avatar-09','avatar-10','avatar-11','avatar-12'];
function cleanAvatarKey(v) {
  const key = String(v || '').trim();
  return AVATAR_KEYS.includes(key) ? key : '';
}

if (!DATABASE_URL) {
  console.error('DATABASE_URL が設定されていません。PostgreSQLの接続URLをRenderのEnvironmentに設定してください。');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function query(text, params = []) { return pool.query(text, params); }
async function one(text, params = []) { const r = await query(text, params); return r.rows[0] || null; }

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      public_code VARCHAR(4) NOT NULL,
      username VARCHAR(20) NOT NULL,
      password_hash TEXT NOT NULL,
      password_ciphertext TEXT,
      avatar_key VARCHAR(20),
      points INTEGER NOT NULL DEFAULT 10 CHECK(points >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(public_code);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(LOWER(username));

    CREATE TABLE IF NOT EXISTS staff (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(30) NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(10) NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_username_ci ON staff(LOWER(username));

    CREATE TABLE IF NOT EXISTS point_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      reason TEXT,
      action_type TEXT NOT NULL DEFAULT 'adjust',
      counterpart_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      counterpart_name TEXT,
      staff_id BIGINT REFERENCES staff(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_history_user ON point_history(user_id, id DESC);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key VARCHAR(20);

    CREATE TABLE IF NOT EXISTS matches (
      id BIGSERIAL PRIMARY KEY,
      challenger_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      opponent_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      referee_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      challenger_name TEXT NOT NULL,
      opponent_name TEXT NOT NULL,
      referee_name TEXT NOT NULL,
      challenger_code VARCHAR(4) NOT NULL,
      opponent_code VARCHAR(4) NOT NULL,
      referee_code VARCHAR(4) NOT NULL,
      wager INTEGER NOT NULL CHECK(wager > 0),
      opponent_approved BOOLEAN NOT NULL DEFAULT FALSE,
      referee_approved BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','matched','in_progress','completed','rejected','cancelled')),
      winner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      winner_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      matched_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_matches_active_challenger ON matches(challenger_id,status);
    CREATE INDEX IF NOT EXISTS idx_matches_active_opponent ON matches(opponent_id,status);
    CREATE INDEX IF NOT EXISTS idx_matches_active_referee ON matches(referee_id,status);
  `);

  const existingAdmin = await one('SELECT id FROM staff LIMIT 1');
  if (!existingAdmin) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await query('INSERT INTO staff(username,password_hash,role) VALUES($1,$2,$3)', [ADMIN_USERNAME, hash, 'admin']);
    console.log(`Created initial admin account: ${ADMIN_USERNAME}`);
  }

  await query(`UPDATE users SET points=10 WHERE LOWER(username)=LOWER($1) AND points<10`, ['ノノンガ']);
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'festival.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 }
}));

function cleanName(v) { return String(v || '').trim().replace(/\s+/g, ' '); }
function cleanReason(v) { return cleanName(v).slice(0, 80); }
function b64url(input) { return Buffer.from(input).toString('base64url'); }
function issueParticipantToken(userId) {
  const payload = JSON.stringify({ uid: Number(userId), exp: Date.now() + 1000 * 60 * 60 * 12 });
  const body = b64url(payload);
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyParticipantToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.uid || !data.exp || Date.now() > Number(data.exp)) return null;
    return Number(data.uid);
  } catch { return null; }
}
function getParticipantToken(req) {
  const h = String(req.headers.authorization || '');
  return String(req.headers['x-participant-token'] || (h.startsWith('Bearer ') ? h.slice(7).trim() : '') || '');
}
function encryptionKey() { return crypto.createHash('sha256').update(PASSWORD_ENCRYPTION_KEY).digest(); }
function encryptPassword(password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decryptPassword(payload) {
  try {
    const [ivB64, tagB64, dataB64] = String(payload || '').split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

async function requireUser(req, res, next) {
  try {
    let userId = verifyParticipantToken(getParticipantToken(req));
    if (userId) {
      const row = await one('SELECT id FROM users WHERE id=$1', [userId]);
      if (!row) userId = null;
    }
    if (!userId && req.session && req.session.userId) {
      const row = await one('SELECT id FROM users WHERE id=$1', [req.session.userId]);
      if (row) userId = Number(row.id); else req.session.userId = null;
    }
    if (!userId) return res.status(401).json({ error: '参加者ログインが必要です', code: 'AUTH_REQUIRED' });
    req.userId = Number(userId); next();
  } catch (e) { next(e); }
}
async function requireStaff(req, res, next) {
  try {
    if (!req.session.staffId) return res.status(403).json({ error: 'スタッフ権限が必要です' });
    const s = await one('SELECT id,username,role,active FROM staff WHERE id=$1', [req.session.staffId]);
    if (!s || !s.active) return res.status(403).json({ error: 'スタッフ権限が無効です' });
    req.staff = { ...s, id: Number(s.id) }; next();
  } catch (e) { next(e); }
}
function requireAdmin(req, res, next) {
  requireStaff(req, res, () => req.staff.role === 'admin' ? next() : res.status(403).json({ error: '管理者権限が必要です' }));
}
function regenerate(req) { return new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve())); }
function saveSession(req) { return new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve())); }

const attempts = new Map();
function loginGuard(scope) {
  return (req, res, next) => {
    const key = `${scope}:${req.ip}`, now = Date.now();
    const item = attempts.get(key) || { count: 0, reset: now + 10 * 60 * 1000 };
    if (now > item.reset) { item.count = 0; item.reset = now + 10 * 60 * 1000; }
    if (item.count >= 20) return res.status(429).json({ error: '試行回数が多すぎます。少し時間を置いてください' });
    req.rateKey = key; req.rateItem = item; next();
  };
}
function failAttempt(req) { req.rateItem.count++; attempts.set(req.rateKey, req.rateItem); }
function clearAttempt(req) { attempts.delete(req.rateKey); }

const transferCooldown = new Map();
function userTransferGuard(req, res, next) {
  const now = Date.now(), last = transferCooldown.get(req.userId) || 0;
  if (now - last < 2000) return res.status(429).json({ error: 'ポイント譲渡が早すぎます。2秒ほど待ってください' });
  transferCooldown.set(req.userId, now); next();
}

async function makeCode(client = pool) {
  const count = Number((await client.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n);
  if (count >= 10000) throw new Error('参加者上限（10,000人）に達しています');
  for (let i = 0; i < 100; i++) {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const found = (await client.query('SELECT 1 FROM users WHERE public_code=$1', [code])).rows[0];
    if (!found) return code;
  }
  throw new Error('IDの発行に失敗しました。もう一度お試しください');
}
async function preserveCounterpartName(client, userId, username) {
  await client.query(`UPDATE point_history SET counterpart_name=COALESCE(counterpart_name,$1), counterpart_user_id=NULL WHERE counterpart_user_id=$2`, [username, userId]);
}
async function deleteUserHard(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id,username FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!u) { await client.query('ROLLBACK'); return null; }
    await preserveCounterpartName(client, userId, u.username);
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
    await client.query('COMMIT');
    return u;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
const eliminationTimers = new Map();
function scheduleElimination(userId) {
  if (eliminationTimers.has(userId)) return;
  const timer = setTimeout(async () => {
    eliminationTimers.delete(userId);
    try {
      const u = await one('SELECT id,points FROM users WHERE id=$1', [userId]);
      if (u && Number(u.points) === 0) await deleteUserHard(userId);
    } catch (e) { console.error('Delayed elimination failed:', e); }
  }, 5000);
  eliminationTimers.set(userId, timer);
}

app.post('/api/register', (req, res) => res.status(403).json({ error: '参加者アカウントはスタッフのみ作成できます' }));

app.post('/api/login', loginGuard('participant'), async (req, res, next) => {
  try {
    const loginId = cleanName(req.body.loginId || req.body.username), password = String(req.body.password || '');
    const user = /^\d{4}$/.test(loginId)
      ? await one('SELECT * FROM users WHERE public_code=$1', [loginId])
      : await one('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [loginId]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) { failAttempt(req); return res.status(401).json({ error: 'IDまたはパスワードが違います' }); }
    const avatarKey = cleanAvatarKey(req.body.avatarKey);
    if (!avatarKey) return res.status(400).json({ error: 'ログインするアイコンを選択してください' });
    await query('UPDATE users SET avatar_key=$1 WHERE id=$2', [avatarKey, user.id]);
    user.avatar_key = avatarKey;
    await regenerate(req); req.session.userId = Number(user.id); req.session.staffId = null; await saveSession(req); clearAttempt(req);
    const authToken = issueParticipantToken(user.id);
    res.json({ ok: true, user: { id:Number(user.id), public_code:user.public_code, username:user.username, points:Number(user.points), avatar_key:user.avatar_key, created_at:user.created_at }, authToken });
  } catch (e) { next(e); }
});
app.post('/api/logout', requireUser, (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', requireUser, async (req, res, next) => {
  try { const u = await one('SELECT id,public_code,username,points,avatar_key,created_at FROM users WHERE id=$1', [req.userId]); res.json({ ...u, id:Number(u.id), points:Number(u.points) }); } catch(e){ next(e); }
});
app.get('/api/my-history', requireUser, async (req, res, next) => {
  try {
    const r = await query(`SELECT h.id,h.delta,h.reason,h.action_type,h.created_at,COALESCE(c.username,h.counterpart_name) counterpart
      FROM point_history h LEFT JOIN users c ON c.id=h.counterpart_user_id WHERE h.user_id=$1 ORDER BY h.id DESC LIMIT 40`, [req.userId]);
    res.json(r.rows.map(x=>({...x,id:Number(x.id),delta:Number(x.delta)})));
  } catch(e){ next(e); }
});
app.get('/api/my-qr', requireUser, async (req, res, next) => {
  try {
    const u = await one('SELECT public_code FROM users WHERE id=$1', [req.userId]);
    const requestBase = `${req.protocol}://${req.get('host')}`;
    const base = (BASE_URL || requestBase).replace(/\/$/, '');
    const payload = `${base}/admin?code=${encodeURIComponent(u.public_code)}`;
    const dataUrl = await QRCode.toDataURL(payload, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ code:u.public_code, dataUrl, url:payload });
  } catch(e){ next(e); }
});
app.get('/api/ranking', async (req, res, next) => {
  try { const r=await query('SELECT public_code,username,points,avatar_key FROM users WHERE points>0 ORDER BY points DESC,id ASC LIMIT 100'); res.json(r.rows.map(x=>({...x,points:Number(x.points)}))); } catch(e){ next(e); }
});


// Participant-to-participant direct transfer is disabled in v5.8.
app.post('/api/transfer', requireUser, (req,res) => res.status(410).json({ error:'ポイント譲渡は廃止されました。対戦マッチングを利用してください' }));

const ACTIVE_MATCH_STATUSES = ['pending','matched','in_progress'];
async function activeMatchForUser(userId, client=pool) {
  const r = await client.query(`SELECT id FROM matches WHERE status = ANY($1::varchar[]) AND (challenger_id=$2 OR opponent_id=$2 OR referee_id=$2) ORDER BY id DESC LIMIT 1`, [ACTIVE_MATCH_STATUSES, userId]);
  return r.rows[0] || null;
}
function publicMatch(row, viewerId) {
  if(!row) return null;
  const role = Number(row.challenger_id)===Number(viewerId) ? 'challenger' : Number(row.opponent_id)===Number(viewerId) ? 'opponent' : Number(row.referee_id)===Number(viewerId) ? 'referee' : 'viewer';
  return {
    id:Number(row.id), role, status:row.status, wager:Number(row.wager),
    opponentApproved:!!row.opponent_approved, refereeApproved:!!row.referee_approved,
    challenger:{id:row.challenger_id?Number(row.challenger_id):null,name:row.challenger_name,code:row.challenger_code},
    opponent:{id:row.opponent_id?Number(row.opponent_id):null,name:row.opponent_name,code:row.opponent_code},
    referee:{id:row.referee_id?Number(row.referee_id):null,name:row.referee_name,code:row.referee_code},
    winnerUserId:row.winner_user_id?Number(row.winner_user_id):null,winnerName:row.winner_name||null,
    createdAt:row.created_at,matchedAt:row.matched_at,startedAt:row.started_at,completedAt:row.completed_at
  };
}

app.post('/api/matches', requireUser, async (req,res,next)=>{
  const opponentCode=String(req.body.opponentCode||'').trim();
  const refereeCode=String(req.body.refereeCode||'').trim();
  const wager=Number(req.body.wager);
  if(!/^\d{4}$/.test(opponentCode)) return res.status(400).json({error:'対戦相手のIDを4桁で入力してください'});
  if(!/^\d{4}$/.test(refereeCode)) return res.status(400).json({error:'審判のIDを4桁で入力してください'});
  if(!Number.isInteger(wager)||wager<1||wager>100000) return res.status(400).json({error:'賭けポイントは1〜100,000の整数で入力してください'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const challenger=(await client.query('SELECT id,username,public_code,points FROM users WHERE id=$1 FOR UPDATE',[req.userId])).rows[0];
    const opponent=(await client.query('SELECT id,username,public_code,points FROM users WHERE public_code=$1 AND points>0 FOR UPDATE',[opponentCode])).rows[0];
    const referee=(await client.query('SELECT id,username,public_code,points FROM users WHERE public_code=$1 AND points>0 FOR UPDATE',[refereeCode])).rows[0];
    if(!challenger||Number(challenger.points)<=0){await client.query('ROLLBACK');return res.status(410).json({error:'このアカウントは退場処理中です'})}
    if(!opponent){await client.query('ROLLBACK');return res.status(404).json({error:'対戦相手のIDが見つかりません'})}
    if(!referee){await client.query('ROLLBACK');return res.status(404).json({error:'審判のIDが見つかりません'})}
    const ids=[Number(challenger.id),Number(opponent.id),Number(referee.id)];
    if(new Set(ids).size!==3){await client.query('ROLLBACK');return res.status(400).json({error:'対戦者2名と審判は、それぞれ別の参加者を指定してください'})}
    for(const uid of ids){if(await activeMatchForUser(uid,client)){await client.query('ROLLBACK');return res.status(409).json({error:'指定した参加者の中に、すでに進行中のマッチがある人がいます'})}}
    const maxWager=Math.min(Number(challenger.points),Number(opponent.points));
    if(wager>maxWager){await client.query('ROLLBACK');return res.status(400).json({error:`賭けられる最大ポイントは ${maxWager}pt です`})}
    const r=await client.query(`INSERT INTO matches(challenger_id,opponent_id,referee_id,challenger_name,opponent_name,referee_name,challenger_code,opponent_code,referee_code,wager) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[challenger.id,opponent.id,referee.id,challenger.username,opponent.username,referee.username,challenger.public_code,opponent.public_code,referee.public_code,wager]);
    await client.query('COMMIT');
    res.json({ok:true,match:publicMatch(r.rows[0],req.userId),maxWager});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});

app.get('/api/matches/me', requireUser, async (req,res,next)=>{
  try{
    let r=await query(`SELECT * FROM matches WHERE (challenger_id=$1 OR opponent_id=$1 OR referee_id=$1) AND status = ANY($2::varchar[]) ORDER BY id DESC LIMIT 1`,[req.userId,ACTIVE_MATCH_STATUSES]);
    if(!r.rows[0]) r=await query(`SELECT * FROM matches WHERE (challenger_id=$1 OR opponent_id=$1 OR referee_id=$1) AND status='completed' AND completed_at > NOW()-INTERVAL '45 seconds' ORDER BY id DESC LIMIT 1`,[req.userId]);
    res.json({match:publicMatch(r.rows[0]||null,req.userId)});
  }catch(e){next(e)}
});

app.post('/api/matches/:id/approve', requireUser, async (req,res,next)=>{
  const id=Number(req.params.id);const client=await pool.connect();
  try{
    await client.query('BEGIN');const m=(await client.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    if(m.status!=='pending'){await client.query('ROLLBACK');return res.status(409).json({error:'このマッチは承認待ちではありません'})}
    if(Number(m.opponent_id)===req.userId) m.opponent_approved=true;
    else if(Number(m.referee_id)===req.userId) m.referee_approved=true;
    else {await client.query('ROLLBACK');return res.status(403).json({error:'このマッチを承認する権限がありません'})}
    const matched=m.opponent_approved&&m.referee_approved;
    const r=await client.query(`UPDATE matches SET opponent_approved=$1,referee_approved=$2,status=$3,matched_at=CASE WHEN $3='matched' THEN COALESCE(matched_at,NOW()) ELSE matched_at END WHERE id=$4 RETURNING *`,[m.opponent_approved,m.referee_approved,matched?'matched':'pending',id]);
    await client.query('COMMIT');res.json({ok:true,match:publicMatch(r.rows[0],req.userId)});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});

app.post('/api/matches/:id/reject', requireUser, async (req,res,next)=>{
  const id=Number(req.params.id);try{
    const m=await one('SELECT * FROM matches WHERE id=$1',[id]);if(!m)return res.status(404).json({error:'マッチが見つかりません'});
    if(m.status!=='pending')return res.status(409).json({error:'このマッチは承認待ちではありません'});
    if(Number(m.opponent_id)!==req.userId&&Number(m.referee_id)!==req.userId&&Number(m.challenger_id)!==req.userId)return res.status(403).json({error:'このマッチを拒否できません'});
    await query("UPDATE matches SET status='rejected' WHERE id=$1",[id]);res.json({ok:true});
  }catch(e){next(e)}
});

app.post('/api/matches/:id/start', requireUser, async (req,res,next)=>{
  const id=Number(req.params.id);try{
    const m=await one('SELECT * FROM matches WHERE id=$1',[id]);if(!m)return res.status(404).json({error:'マッチが見つかりません'});
    if(![m.challenger_id,m.opponent_id,m.referee_id].some(x=>Number(x)===req.userId))return res.status(403).json({error:'このマッチに参加していません'});
    if(m.status==='in_progress')return res.json({ok:true,match:publicMatch(m,req.userId)});
    if(m.status!=='matched')return res.status(409).json({error:'まだマッチングが完了していません'});
    const r=await query("UPDATE matches SET status='in_progress',started_at=COALESCE(started_at,NOW()) WHERE id=$1 RETURNING *",[id]);res.json({ok:true,match:publicMatch(r.rows[0],req.userId)});
  }catch(e){next(e)}
});

app.post('/api/matches/:id/result', requireUser, async (req,res,next)=>{
  const id=Number(req.params.id),winnerId=Number(req.body.winnerId);const client=await pool.connect();
  try{
    await client.query('BEGIN');const m=(await client.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    if(Number(m.referee_id)!==req.userId){await client.query('ROLLBACK');return res.status(403).json({error:'勝利判定は指定された審判だけが行えます'})}
    if(!['matched','in_progress'].includes(m.status)){await client.query('ROLLBACK');return res.status(409).json({error:'このマッチは勝利判定できません'})}
    if(![Number(m.challenger_id),Number(m.opponent_id)].includes(winnerId)){await client.query('ROLLBACK');return res.status(400).json({error:'勝者の指定が正しくありません'})}
    const loserId=winnerId===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);
    const winner=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[winnerId])).rows[0];
    const loser=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[loserId])).rows[0];
    if(!winner||!loser){await client.query('ROLLBACK');return res.status(410).json({error:'対戦者アカウントが存在しません'})}
    const wager=Number(m.wager);if(Number(loser.points)<wager){await client.query('ROLLBACK');return res.status(409).json({error:`${loser.username} のポイントが賭けポイントを下回っています。運営に確認してください`})}
    const winnerPoints=Number(winner.points)+wager,loserPoints=Number(loser.points)-wager;
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[winnerPoints,winnerId]);await client.query('UPDATE users SET points=$1 WHERE id=$2',[loserPoints,loserId]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[winnerId,wager,`MATCH #${id} 勝利`,'match_win',loserId,loser.username]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[loserId,-wager,`MATCH #${id} 敗北`,'match_loss',winnerId,winner.username]);
    const ur=await client.query("UPDATE matches SET status='completed',winner_user_id=$1,winner_name=$2,completed_at=NOW(),started_at=COALESCE(started_at,NOW()) WHERE id=$3 RETURNING *",[winnerId,winner.username,id]);
    await client.query('COMMIT');if(loserPoints===0)scheduleElimination(loserId);
    res.json({ok:true,match:publicMatch(ur.rows[0],req.userId),winner:{id:winnerId,name:winner.username,points:winnerPoints},loser:{id:loserId,name:loser.username,points:loserPoints},wager,eliminated:loserPoints===0});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});

app.post('/api/staff/login', loginGuard('staff'), async (req,res,next)=>{
  try{
    const username=cleanName(req.body.username), password=String(req.body.password||'');
    const s=await one('SELECT * FROM staff WHERE LOWER(username)=LOWER($1) AND active=TRUE',[username]);
    if(!s||!(await bcrypt.compare(password,s.password_hash))){failAttempt(req);return res.status(401).json({error:'スタッフIDまたはパスワードが違います'})}
    await regenerate(req);req.session.staffId=Number(s.id);await saveSession(req);clearAttempt(req);res.json({ok:true,username:s.username,role:s.role});
  }catch(e){next(e)}
});
app.post('/api/staff/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/staff/status',async(req,res,next)=>{try{if(!req.session.staffId)return res.json({loggedIn:false});const s=await one('SELECT id,username,role,active FROM staff WHERE id=$1',[req.session.staffId]);res.json({loggedIn:!!(s&&s.active),staff:s&&s.active?{...s,id:Number(s.id)}:null})}catch(e){next(e)}});

app.get('/api/staff/users', requireStaff, async (req,res,next)=>{
  try{
    const q=cleanName(req.query.q), code=String(req.query.code||'').trim(), all=String(req.query.all||'')==='1'; let r;
    const select=`SELECT id,public_code,username,points,avatar_key,created_at,(password_ciphertext IS NOT NULL) AS password_available FROM users`;
    if(code) r=await query(`${select} WHERE public_code=$1 LIMIT 1`,[code]);
    else if(q) r=await query(`${select} WHERE LOWER(username) LIKE LOWER($1) OR public_code LIKE $2 ORDER BY points DESC LIMIT 100`,[`%${q}%`,`%${q}%`]);
    else if(all) r=await query(`${select} ORDER BY LOWER(username) ASC LIMIT 10000`);
    else r={rows:[]};
    res.json(r.rows.map(x=>({...x,id:Number(x.id),points:Number(x.points)})));
  }catch(e){next(e)}
});

app.post('/api/staff/participants', requireStaff, async (req,res,next)=>{
  const username=cleanName(req.body.username), password=String(req.body.password||'');
  if(username.length<2||username.length>20)return res.status(400).json({error:'参加者名は2〜20文字で入力してください'});
  if(!/^[^<>]{2,20}$/.test(username))return res.status(400).json({error:'参加者名に使用できない文字が含まれています'});
  if(password.length<6||password.length>72)return res.status(400).json({error:'参加者パスワードは6〜72文字で入力してください'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const hash=await bcrypt.hash(password,12), code=await makeCode(client), cipher=encryptPassword(password);
    const r=await client.query('INSERT INTO users(public_code,username,password_hash,password_ciphertext,points) VALUES($1,$2,$3,$4,$5) RETURNING id',[code,username,hash,cipher,STARTING_POINTS]);
    await client.query('COMMIT');res.json({ok:true,id:Number(r.rows[0].id),username,code,startingPoints:STARTING_POINTS,password});
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'その参加者名は現在使用中です'});next(e)}finally{client.release()}
});

app.get('/api/staff/users/:id/password', requireAdmin, async (req,res,next)=>{
  try{
    const u=await one('SELECT id,username,password_ciphertext FROM users WHERE id=$1',[Number(req.params.id)]);
    if(!u)return res.status(404).json({error:'参加者が見つかりません'});
    if(!u.password_ciphertext)return res.json({available:false,username:u.username});
    const password=decryptPassword(u.password_ciphertext);
    if(password===null)return res.status(500).json({error:'保存済みパスワードを復号できません。PASSWORD_ENCRYPTION_KEYが変更されていないか確認してください'});
    res.json({available:true,username:u.username,password});
  }catch(e){next(e)}
});
app.post('/api/staff/users/:id/password', requireAdmin, async (req,res,next)=>{
  try{
    const id=Number(req.params.id), password=String(req.body.password||'');
    if(password.length<6||password.length>72)return res.status(400).json({error:'参加者パスワードは6〜72文字で入力してください'});
    const u=await one('SELECT id,username FROM users WHERE id=$1',[id]);if(!u)return res.status(404).json({error:'参加者が見つかりません'});
    const hash=await bcrypt.hash(password,12), cipher=encryptPassword(password);
    await query('UPDATE users SET password_hash=$1,password_ciphertext=$2 WHERE id=$3',[hash,cipher,id]);
    res.json({ok:true,username:u.username,password});
  }catch(e){next(e)}
});

app.post('/api/staff/users/:id/points', requireStaff, async (req,res,next)=>{
  const id=Number(req.params.id),delta=Number(req.body.delta),reason=cleanReason(req.body.reason);
  if(!Number.isInteger(delta)||delta===0||Math.abs(delta)>100000)return res.status(400).json({error:'1〜100,000の整数で入力してください'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const u=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!u){await client.query('ROLLBACK');return res.status(404).json({error:'参加者が見つかりません'})}
    const nextPoints=Number(u.points)+delta;if(nextPoints<0){await client.query('ROLLBACK');return res.status(400).json({error:'ポイントは0未満にできません'})}
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[nextPoints,id]);
    await client.query('INSERT INTO point_history(user_id,delta,reason,action_type,staff_id) VALUES($1,$2,$3,$4,$5)',[id,delta,reason||null,'adjust',req.staff.id]);
    await client.query('COMMIT');if(nextPoints===0)scheduleElimination(id);res.json({id,username:u.username,points:nextPoints,eliminated:nextPoints===0});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});

app.post('/api/staff/transfer', requireStaff, async (req,res,next)=>{
  const fromId=Number(req.body.fromId),toId=Number(req.body.toId),amount=Number(req.body.amount),reason=cleanReason(req.body.reason);
  if(!Number.isInteger(amount)||amount<1||amount>100000)return res.status(400).json({error:'移動ポイントは1〜100,000の整数で入力してください'});
  if(fromId===toId)return res.status(400).json({error:'同じ参加者には移動できません'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const from=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[fromId])).rows[0];
    const to=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[toId])).rows[0];
    if(!from||!to){await client.query('ROLLBACK');return res.status(404).json({error:'参加者が見つかりません'})}
    if(Number(from.points)<amount){await client.query('ROLLBACK');return res.status(400).json({error:`${from.username}のポイントが不足しています`})}
    const fromPoints=Number(from.points)-amount,toPoints=Number(to.points)+amount;
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[fromPoints,fromId]);await client.query('UPDATE users SET points=$1 WHERE id=$2',[toPoints,toId]);
    await client.query('INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name,staff_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[fromId,-amount,reason||null,'transfer_out',toId,to.username,req.staff.id]);
    await client.query('INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name,staff_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[toId,amount,reason||null,'transfer_in',fromId,from.username,req.staff.id]);
    await client.query('COMMIT');if(fromPoints===0)scheduleElimination(fromId);res.json({ok:true,eliminated:fromPoints===0,from:{id:fromId,username:from.username,points:fromPoints},to:{id:toId,username:to.username,points:toPoints}});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});

app.delete('/api/staff/users/:id', requireAdmin, async (req,res,next)=>{try{const u=await deleteUserHard(Number(req.params.id));if(!u)return res.status(404).json({error:'参加者が見つかりません'});res.json({ok:true,username:u.username})}catch(e){next(e)}});
app.get('/api/staff/history', requireStaff, async (req,res,next)=>{try{const r=await query(`SELECT h.id,u.username,h.delta,h.reason,h.action_type,COALESCE(c.username,h.counterpart_name) counterpart,s.username staff_name,h.created_at FROM point_history h JOIN users u ON u.id=h.user_id LEFT JOIN users c ON c.id=h.counterpart_user_id LEFT JOIN staff s ON s.id=h.staff_id ORDER BY h.id DESC LIMIT 150`);res.json(r.rows.map(x=>({...x,id:Number(x.id),delta:Number(x.delta)})))}catch(e){next(e)}});
app.get('/api/staff/accounts', requireAdmin, async (req,res,next)=>{try{const r=await query('SELECT id,username,role,active,created_at FROM staff ORDER BY id');res.json(r.rows.map(x=>({...x,id:Number(x.id)})))}catch(e){next(e)}});
app.post('/api/staff/accounts', requireAdmin, async (req,res,next)=>{const username=cleanName(req.body.username),password=String(req.body.password||''),role=req.body.role==='admin'?'admin':'staff';if(username.length<2||username.length>30)return res.status(400).json({error:'スタッフIDは2〜30文字で入力してください'});if(password.length<8||password.length>72)return res.status(400).json({error:'スタッフパスワードは8〜72文字で入力してください'});try{const hash=await bcrypt.hash(password,12),r=await query('INSERT INTO staff(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',[username,hash,role]);res.json({ok:true,id:Number(r.rows[0].id)})}catch(e){if(e.code==='23505')return res.status(409).json({error:'そのスタッフIDは使用済みです'});next(e)}});
app.post('/api/staff/accounts/:id/toggle', requireAdmin, async (req,res,next)=>{try{const id=Number(req.params.id);if(id===req.staff.id)return res.status(400).json({error:'自分自身は無効化できません'});const s=await one('SELECT id,active FROM staff WHERE id=$1',[id]);if(!s)return res.status(404).json({error:'スタッフが見つかりません'});await query('UPDATE staff SET active=$1 WHERE id=$2',[!s.active,id]);res.json({ok:true})}catch(e){next(e)}});

app.use(express.static(path.join(__dirname,'public')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/ranking',(req,res)=>res.sendFile(path.join(__dirname,'public','ranking.html')));
app.get('/history',(req,res)=>res.sendFile(path.join(__dirname,'public','history.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'サーバー処理でエラーが発生しました'})});

(async()=>{
  try{
    await initDb();
    app.listen(PORT,'0.0.0.0',()=>{
      console.log(`NEXUS:ZERO v5.8: http://localhost:${PORT}`);
      console.log('Database: PostgreSQL');
      console.log(`Starting points: ${STARTING_POINTS}`);
      if(SESSION_SECRET.startsWith('replace-this'))console.log('WARNING: SESSION_SECRETを本番用に変更してください。');
      if(PASSWORD_ENCRYPTION_KEY===SESSION_SECRET)console.log('WARNING: PASSWORD_ENCRYPTION_KEYを本番用に別途設定することを推奨します。');
      if(ADMIN_PASSWORD==='change-me-now')console.log('WARNING: 初期管理者パスワードを変更してください。');
    });
  }catch(e){console.error('Startup failed:',e);process.exit(1)}
})();
