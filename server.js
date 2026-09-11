const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const crypto = require('crypto');
const { randomInt } = require('crypto');

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


    CREATE TABLE IF NOT EXISTS quick_matches (
      id BIGSERIAL PRIMARY KEY,
      challenger_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      opponent_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      challenger_name TEXT NOT NULL,
      opponent_name TEXT NOT NULL,
      challenger_code VARCHAR(4) NOT NULL,
      opponent_code VARCHAR(4) NOT NULL,
      wager INTEGER NOT NULL CHECK(wager > 0),
      game_type VARCHAR(20) NOT NULL DEFAULT 'hitblow',
      opponent_approved BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      first_player_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      turn_player_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      challenger_secret VARCHAR(4),
      opponent_secret VARCHAR(4),
      initial_hint_key VARCHAR(1),
      turn_no INTEGER NOT NULL DEFAULT 1,
      winner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      winner_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      matched_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_quick_matches_challenger ON quick_matches(challenger_id,status);
    CREATE INDEX IF NOT EXISTS idx_quick_matches_opponent ON quick_matches(opponent_id,status);

    CREATE TABLE IF NOT EXISTS hit_blow_guesses (
      id BIGSERIAL PRIMARY KEY,
      match_id BIGINT NOT NULL REFERENCES quick_matches(id) ON DELETE CASCADE,
      player_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      player_name TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      guess VARCHAR(4) NOT NULL,
      hits INTEGER NOT NULL,
      blows INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hit_blow_guesses_match ON hit_blow_guesses(match_id,id);
  `);

  // Keep the match status constraint compatible across upgrades.
  // PostgreSQL preserves old CHECK constraints when CREATE TABLE IF NOT EXISTS is used.
  await query(`
    ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_status_check;
    ALTER TABLE matches ADD CONSTRAINT matches_status_check
      CHECK(status IN ('pending','matched','in_progress','completed','rejected','cancelled'));
  `);

  // QUICK BATTLE state columns.
  await query(`
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS live_selection VARCHAR(4) NOT NULL DEFAULT '';
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS turn_started_at TIMESTAMPTZ;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS challenger_janken_choice VARCHAR(10);
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS opponent_janken_choice VARCHAR(10);
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS challenger_janken_wins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS opponent_janken_wins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS janken_round INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS janken_round_started_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS janken_rounds (
      id BIGSERIAL PRIMARY KEY,
      match_id BIGINT NOT NULL REFERENCES quick_matches(id) ON DELETE CASCADE,
      round_no INTEGER NOT NULL,
      challenger_choice VARCHAR(10) NOT NULL,
      opponent_choice VARCHAR(10) NOT NULL,
      winner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      result VARCHAR(10) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_janken_rounds_match ON janken_rounds(match_id,id);
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
app.get('/api/ranking', async (req, res, next) => {
  try { const r=await query('SELECT public_code,username,points,avatar_key FROM users WHERE points>0 ORDER BY points DESC,id ASC LIMIT 100'); res.json(r.rows.map(x=>({...x,points:Number(x.points)}))); } catch(e){ next(e); }
});

app.get('/api/my-rank', requireUser, async (req,res,next)=>{
  try {
    const u=await one('SELECT id,public_code,username,points,avatar_key FROM users WHERE id=$1',[req.userId]);
    if(!u) return res.status(404).json({error:'参加者が見つかりません'});
    if(Number(u.points)<=0) return res.json({rank:null,user:{public_code:u.public_code,username:u.username,points:Number(u.points),avatar_key:u.avatar_key}});
    const rr=await one(`SELECT 1 + COUNT(*)::int AS rank FROM users WHERE points>0 AND (points>$1 OR (points=$1 AND id<$2))`,[Number(u.points),Number(u.id)]);
    res.json({rank:Number(rr.rank),user:{public_code:u.public_code,username:u.username,points:Number(u.points),avatar_key:u.avatar_key}});
  } catch(e){ next(e); }
});


// Participant-to-participant direct transfer is disabled in v5.8.
app.post('/api/transfer', requireUser, (req,res) => res.status(410).json({ error:'ポイント譲渡は廃止されました。対戦マッチングを利用してください' }));

const ACTIVE_MATCH_STATUSES = ['pending','matched','in_progress'];
async function activeMatchForUser(userId, client=pool) {
  const r = await client.query(`SELECT id FROM matches WHERE status = ANY($1::varchar[]) AND (challenger_id=$2 OR opponent_id=$2 OR referee_id=$2) ORDER BY id DESC LIMIT 1`, [ACTIVE_MATCH_STATUSES, userId]);
  if(r.rows[0]) return {kind:'custom',...r.rows[0]};
  const q = await client.query(`SELECT id FROM quick_matches WHERE status = ANY($1::varchar[]) AND (challenger_id=$2 OR opponent_id=$2) ORDER BY id DESC LIMIT 1`, [['pending','setup','in_progress'], userId]);
  return q.rows[0] ? {kind:'quick',...q.rows[0]} : null;
}
function publicMatch(row, viewerId) {
  if(!row) return null;
  const role = Number(row.challenger_id)===Number(viewerId) ? 'challenger' : Number(row.opponent_id)===Number(viewerId) ? 'opponent' : Number(row.referee_id)===Number(viewerId) ? 'referee' : 'viewer';
  return {
    id:Number(row.id), role, status:row.status, wager:Number(row.wager),
    opponentApproved:!!row.opponent_approved, refereeApproved:!!row.referee_approved,
    challenger:{id:row.challenger_id?Number(row.challenger_id):null,name:row.challenger_name,code:row.challenger_code,avatarKey:row.challenger_avatar||null},
    opponent:{id:row.opponent_id?Number(row.opponent_id):null,name:row.opponent_name,code:row.opponent_code,avatarKey:row.opponent_avatar||null},
    referee:{id:row.referee_id?Number(row.referee_id):null,name:row.referee_name,code:row.referee_code,avatarKey:row.referee_avatar||null},
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
  if(!Number.isInteger(wager)||wager<10||wager>100000||wager%10!==0) return res.status(400).json({error:'対戦ポイントは10pt刻み（10、20、30…）で入力してください'});
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
    const rawMaxWager=Math.min(Number(challenger.points),Number(opponent.points));
    const maxWager=Math.floor(rawMaxWager/10)*10;
    if(maxWager<10){await client.query('ROLLBACK');return res.status(400).json({error:'どちらかの所持ポイントが10pt未満のため、現在は対戦を申し込めません'})}
    if(wager>maxWager){await client.query('ROLLBACK');return res.status(400).json({error:`設定できる対戦ポイントの上限は ${maxWager}pt です（10pt刻み）`})}
    const r=await client.query(`INSERT INTO matches(challenger_id,opponent_id,referee_id,challenger_name,opponent_name,referee_name,challenger_code,opponent_code,referee_code,wager) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[challenger.id,opponent.id,referee.id,challenger.username,opponent.username,referee.username,challenger.public_code,opponent.public_code,referee.public_code,wager]);
    await client.query('COMMIT');
    res.json({ok:true,match:publicMatch(r.rows[0],req.userId),maxWager});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});

app.get('/api/matches/me', requireUser, async (req,res,next)=>{
  try{
    const matchSelect = `SELECT m.*, cu.avatar_key AS challenger_avatar, ou.avatar_key AS opponent_avatar, ru.avatar_key AS referee_avatar
      FROM matches m
      LEFT JOIN users cu ON cu.id=m.challenger_id
      LEFT JOIN users ou ON ou.id=m.opponent_id
      LEFT JOIN users ru ON ru.id=m.referee_id`;
    let r=await query(`${matchSelect} WHERE (m.challenger_id=$1 OR m.opponent_id=$1 OR m.referee_id=$1) AND m.status = ANY($2::varchar[]) ORDER BY m.id DESC LIMIT 1`,[req.userId,ACTIVE_MATCH_STATUSES]);
    if(!r.rows[0]) r=await query(`${matchSelect} WHERE (m.challenger_id=$1 OR m.opponent_id=$1 OR m.referee_id=$1) AND m.status='completed' AND m.completed_at > NOW()-INTERVAL '15 seconds' ORDER BY m.id DESC LIMIT 1`,[req.userId]);
    res.json({match:publicMatch(r.rows[0]||null,req.userId)});
  }catch(e){next(e)}
});

app.post('/api/matches/:id/approve', requireUser, async (req,res,next)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'マッチIDが不正です'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let m=(await client.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    if(m.status!=='pending'){
      // Idempotent response: if this match has just become matched, don't treat a repeated tap as an error.
      if(['matched','in_progress'].includes(m.status)){await client.query('COMMIT');return res.json({ok:true,match:publicMatch(m,req.userId)})}
      await client.query('ROLLBACK');return res.status(409).json({error:'このマッチは承認待ちではありません'});
    }

    if(Number(m.opponent_id)===Number(req.userId)){
      if(!m.opponent_approved) await client.query('UPDATE matches SET opponent_approved=TRUE WHERE id=$1',[id]);
    }else if(Number(m.referee_id)===Number(req.userId)){
      if(!m.referee_approved) await client.query('UPDATE matches SET referee_approved=TRUE WHERE id=$1',[id]);
    }else{
      await client.query('ROLLBACK');return res.status(403).json({error:'このマッチを承認する権限がありません'});
    }

    // Re-read after the individual approval update so the MATCHED decision always uses DB state.
    m=(await client.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(m.opponent_approved===true && m.referee_approved===true){
      m=(await client.query(`UPDATE matches SET status='matched',matched_at=COALESCE(matched_at,NOW()) WHERE id=$1 AND status='pending' RETURNING *`,[id])).rows[0] || m;
    }

    await client.query('COMMIT');
    res.json({ok:true,match:publicMatch(m,req.userId)});
  }catch(e){
    try{await client.query('ROLLBACK')}catch{}
    next(e);
  }finally{client.release()}
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
    const wager=Number(m.wager);if(Number(loser.points)<wager){await client.query('ROLLBACK');return res.status(409).json({error:`${loser.username} のポイントが対戦ポイントを下回っています。運営に確認してください`})}
    const winnerPoints=Number(winner.points)+wager,loserPoints=Number(loser.points)-wager;
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[winnerPoints,winnerId]);await client.query('UPDATE users SET points=$1 WHERE id=$2',[loserPoints,loserId]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[winnerId,wager,`MATCH #${id} 勝利`,'match_win',loserId,loser.username]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[loserId,-wager,`MATCH #${id} 敗北`,'match_loss',winnerId,winner.username]);
    const ur=await client.query("UPDATE matches SET status='completed',winner_user_id=$1,winner_name=$2,completed_at=NOW(),started_at=COALESCE(started_at,NOW()) WHERE id=$3 RETURNING *",[winnerId,winner.username,id]);
    await client.query('COMMIT');if(loserPoints===0)scheduleElimination(loserId);
    res.json({ok:true,match:publicMatch(ur.rows[0],req.userId),winner:{id:winnerId,name:winner.username,points:winnerPoints},loser:{id:loserId,name:loser.username,points:loserPoints},wager,eliminated:loserPoints===0});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});



// QUICK BATTLE: HIT & BLOW ----------------------------------------------------
const QUICK_ACTIVE_STATUSES=['pending','setup','in_progress'];
function validKeyCode(code){return /^\d{4}$/.test(code)&&new Set(code.split('')).size===4}
function hbScore(secret,guess){let hits=0,blows=0;for(let i=0;i<4;i++){if(secret[i]===guess[i])hits++;else if(secret.includes(guess[i]))blows++;}return {hits,blows}}
function publicQuickMatch(row,viewerId){
  if(!row)return null;
  const viewer=Number(viewerId),challengerId=Number(row.challenger_id),opponentId=Number(row.opponent_id);
  const role=viewer===challengerId?'challenger':viewer===opponentId?'opponent':'viewer';
  const firstId=row.first_player_id?Number(row.first_player_id):null;
  const secondId=firstId?(firstId===challengerId?opponentId:challengerId):null;
  const mySecret=role==='challenger'?row.challenger_secret:role==='opponent'?row.opponent_secret:null;
  const otherReady=role==='challenger'?!!row.opponent_secret:role==='opponent'?!!row.challenger_secret:false;
  return {
    id:Number(row.id),kind:'quick',gameType:row.game_type,status:row.status,role,wager:Number(row.wager),opponentApproved:!!row.opponent_approved,
    challenger:{id:challengerId,name:row.challenger_name,code:row.challenger_code,avatarKey:row.challenger_avatar||null},
    opponent:{id:opponentId,name:row.opponent_name,code:row.opponent_code,avatarKey:row.opponent_avatar||null},
    firstPlayerId:firstId,secondPlayerId:secondId,turnPlayerId:row.turn_player_id?Number(row.turn_player_id):null,turnNo:Number(row.turn_no||1),
    mySecret:mySecret||null,myReady:!!mySecret,otherReady,
    challengerSecret:row.status==='completed'?(row.challenger_secret||null):null,
    opponentSecret:row.status==='completed'?(row.opponent_secret||null):null,
    liveSelection:row.live_selection||'',
    turnStartedAt:row.turn_started_at||null,
    turnDeadlineAt:row.turn_started_at?new Date(new Date(row.turn_started_at).getTime()+60000).toISOString():null,
    initialHint:(viewer===secondId&&row.initial_hint_key)?row.initial_hint_key:null,
    jankenRound:Number(row.janken_round||1),
    challengerJankenWins:Number(row.challenger_janken_wins||0),opponentJankenWins:Number(row.opponent_janken_wins||0),
    myJankenChoice:role==='challenger'?(row.challenger_janken_choice||null):role==='opponent'?(row.opponent_janken_choice||null):null,
    rivalJankenLocked:role==='challenger'?!!row.opponent_janken_choice:role==='opponent'?!!row.challenger_janken_choice:false,
    jankenRoundStartedAt:row.janken_round_started_at||null,
    jankenRoundDeadlineAt:row.janken_round_started_at?new Date(new Date(row.janken_round_started_at).getTime()+15000).toISOString():null,
    winnerUserId:row.winner_user_id?Number(row.winner_user_id):null,winnerName:row.winner_name||null,
    createdAt:row.created_at,matchedAt:row.matched_at,startedAt:row.started_at,completedAt:row.completed_at
  };
}
const quickSelect=`SELECT q.*, cu.avatar_key AS challenger_avatar, ou.avatar_key AS opponent_avatar
  FROM quick_matches q LEFT JOIN users cu ON cu.id=q.challenger_id LEFT JOIN users ou ON ou.id=q.opponent_id`;

app.post('/api/quick-matches',requireUser,async(req,res,next)=>{
  const opponentCode=String(req.body.opponentCode||'').trim();const wager=Number(req.body.wager);const gameType=String(req.body.gameType||'hitblow');
  if(!['hitblow','janken'].includes(gameType))return res.status(400).json({error:'このQUICK BATTLEは現在利用できません'});
  if(!/^\d{4}$/.test(opponentCode))return res.status(400).json({error:'対戦相手のIDを4桁で入力してください'});
  if(!Number.isInteger(wager)||wager<10||wager%10!==0)return res.status(400).json({error:'対戦ポイントは10pt刻み（10、20、30…）で入力してください'});
  const client=await pool.connect();
  try{await client.query('BEGIN');
    const challenger=(await client.query('SELECT id,username,public_code,points FROM users WHERE id=$1 FOR UPDATE',[req.userId])).rows[0];
    const opponent=(await client.query('SELECT id,username,public_code,points FROM users WHERE public_code=$1 AND points>0 FOR UPDATE',[opponentCode])).rows[0];
    if(!challenger||Number(challenger.points)<=0){await client.query('ROLLBACK');return res.status(410).json({error:'このアカウントは退場処理中です'})}
    if(!opponent){await client.query('ROLLBACK');return res.status(404).json({error:'対戦相手のIDが見つかりません'})}
    if(Number(challenger.id)===Number(opponent.id)){await client.query('ROLLBACK');return res.status(400).json({error:'自分自身には対戦を申し込めません'})}
    for(const uid of [challenger.id,opponent.id]){if(await activeMatchForUser(uid,client)){await client.query('ROLLBACK');return res.status(409).json({error:'どちらかのプレイヤーに進行中のマッチがあります'})}}
    const maxWager=Math.floor(Math.min(Number(challenger.points),Number(opponent.points))/10)*10;
    if(maxWager<10){await client.query('ROLLBACK');return res.status(400).json({error:'どちらかの所持ポイントが10pt未満です'})}
    if(wager>maxWager){await client.query('ROLLBACK');return res.status(400).json({error:`設定できる対戦ポイントの上限は ${maxWager}pt です`})}
    const r=await client.query(`INSERT INTO quick_matches(challenger_id,opponent_id,challenger_name,opponent_name,challenger_code,opponent_code,wager,game_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[challenger.id,opponent.id,challenger.username,opponent.username,challenger.public_code,opponent.public_code,wager,gameType]);
    await client.query('COMMIT');res.json({ok:true,match:publicQuickMatch(r.rows[0],req.userId),maxWager});
  }catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}
});

app.get('/api/quick-matches/me',requireUser,async(req,res,next)=>{try{
  let r=await query(`${quickSelect} WHERE (q.challenger_id=$1 OR q.opponent_id=$1) AND q.status=ANY($2::varchar[]) ORDER BY q.id DESC LIMIT 1`,[req.userId,QUICK_ACTIVE_STATUSES]);
  if(!r.rows[0])r=await query(`${quickSelect} WHERE (q.challenger_id=$1 OR q.opponent_id=$1) AND q.status='completed' AND q.completed_at>NOW()-INTERVAL '40 seconds' ORDER BY q.id DESC LIMIT 1`,[req.userId]);
  res.json({match:publicQuickMatch(r.rows[0]||null,req.userId)});
}catch(e){next(e)}});

app.post('/api/quick-matches/:id/approve',requireUser,async(req,res,next)=>{
  const id=Number(req.params.id);const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    if(Number(m.opponent_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(403).json({error:'対戦相手だけが承認できます'})}
    if(m.status!=='pending'){await client.query('COMMIT');return res.json({ok:true,match:publicQuickMatch(m,req.userId)})}
    if(m.game_type==='janken'){
      m=(await client.query(`UPDATE quick_matches SET opponent_approved=TRUE,status='in_progress',matched_at=NOW(),started_at=NOW(),janken_round=1,janken_round_started_at=NOW() + INTERVAL '4 seconds',challenger_janken_choice=NULL,opponent_janken_choice=NULL WHERE id=$1 RETURNING *`,[id])).rows[0];
    }else{
      const first=Math.random()<0.5?Number(m.challenger_id):Number(m.opponent_id);
      m=(await client.query(`UPDATE quick_matches SET opponent_approved=TRUE,status='setup',first_player_id=$1,matched_at=NOW() WHERE id=$2 RETURNING *`,[first,id])).rows[0];
    }
    await client.query('COMMIT');res.json({ok:true,match:publicQuickMatch(m,req.userId)});
  }catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}
});

app.post('/api/quick-matches/:id/reject',requireUser,async(req,res,next)=>{try{const id=Number(req.params.id);const m=await one('SELECT * FROM quick_matches WHERE id=$1',[id]);if(!m)return res.status(404).json({error:'マッチが見つかりません'});if(![Number(m.challenger_id),Number(m.opponent_id)].includes(Number(req.userId)))return res.status(403).json({error:'このマッチを拒否できません'});if(m.status!=='pending')return res.status(409).json({error:'この申請はすでに開始されています'});await query("UPDATE quick_matches SET status='rejected' WHERE id=$1",[id]);res.json({ok:true});}catch(e){next(e)}});

app.post('/api/quick-matches/:id/secret',requireUser,async(req,res,next)=>{const id=Number(req.params.id);const code=Array.isArray(req.body.keys)?req.body.keys.map(String).join(''):String(req.body.code||'');if(!validKeyCode(code))return res.status(400).json({error:'0〜9から重複なしで4つのPASSKEYを選択してください'});const client=await pool.connect();try{await client.query('BEGIN');let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}if(m.status!=='setup'){await client.query('ROLLBACK');return res.status(409).json({error:'現在は暗号キーを設定できません'})}const role=Number(m.challenger_id)===Number(req.userId)?'challenger':Number(m.opponent_id)===Number(req.userId)?'opponent':null;if(!role){await client.query('ROLLBACK');return res.status(403).json({error:'このマッチに参加していません'})}const col=role==='challenger'?'challenger_secret':'opponent_secret';if(m[col]){await client.query('ROLLBACK');return res.status(409).json({error:'暗号キーはすでにロックされています'})}await client.query(`UPDATE quick_matches SET ${col}=$1 WHERE id=$2`,[code,id]);m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];if(m.challenger_secret&&m.opponent_secret){const first=Number(m.first_player_id);const firstSecret=first===Number(m.challenger_id)?m.challenger_secret:m.opponent_secret;const hint=firstSecret[randomInt(0,4)];m=(await client.query(`UPDATE quick_matches SET status='in_progress',turn_player_id=first_player_id,initial_hint_key=$1,started_at=NOW(),turn_no=1,turn_started_at=NOW() + INTERVAL '4 seconds',live_selection='' WHERE id=$2 RETURNING *`,[hint,id])).rows[0];}await client.query('COMMIT');res.json({ok:true,match:publicQuickMatch(m,req.userId)});}catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}});

app.get('/api/quick-matches/:id/state',requireUser,async(req,res,next)=>{const id=Number(req.params.id);const client=await pool.connect();try{
  await client.query('BEGIN');
  let locked=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!locked||![Number(locked.challenger_id),Number(locked.opponent_id)].includes(Number(req.userId))){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
  if(locked.status==='in_progress'&&locked.turn_started_at&&new Date(locked.turn_started_at).getTime()<=Date.now()-60000){
    const next=Number(locked.turn_player_id)===Number(locked.challenger_id)?Number(locked.opponent_id):Number(locked.challenger_id);
    locked=(await client.query(`UPDATE quick_matches SET turn_player_id=$1,turn_no=turn_no+1,turn_started_at=NOW(),live_selection='' WHERE id=$2 RETURNING *`,[next,id])).rows[0];
  }
  await client.query('COMMIT');
  const r=await query(`${quickSelect} WHERE q.id=$1 AND (q.challenger_id=$2 OR q.opponent_id=$2)`,[id,req.userId]);
  const g=await query('SELECT player_id,player_name,turn_no,guess,hits,blows,created_at FROM hit_blow_guesses WHERE match_id=$1 ORDER BY id',[id]);
  res.json({match:publicQuickMatch(r.rows[0],req.userId),guesses:g.rows.map(x=>({playerId:Number(x.player_id),playerName:x.player_name,turnNo:Number(x.turn_no),guess:x.guess,hits:Number(x.hits),blows:Number(x.blows),createdAt:x.created_at}))});
}catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}});

app.post('/api/quick-matches/:id/selection',requireUser,async(req,res,next)=>{
  const id=Number(req.params.id);const keys=Array.isArray(req.body.keys)?req.body.keys.map(String):[];
  if(keys.length>4||keys.some(x=>!/^[0-9]$/.test(x))||new Set(keys).size!==keys.length)return res.status(400).json({error:'PASSKEYの選択情報が不正です'});
  const client=await pool.connect();try{await client.query('BEGIN');let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    if(m.status!=='in_progress'){await client.query('ROLLBACK');return res.status(409).json({error:'対戦は進行中ではありません'})}
    if(m.turn_started_at&&Date.now()<new Date(m.turn_started_at).getTime()){await client.query('ROLLBACK');return res.status(409).json({error:'BATTLE STARTING...'})}
    if(m.turn_started_at&&new Date(m.turn_started_at).getTime()<=Date.now()-60000){const next=Number(m.turn_player_id)===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);await client.query(`UPDATE quick_matches SET turn_player_id=$1,turn_no=turn_no+1,turn_started_at=NOW(),live_selection='' WHERE id=$2`,[next,id]);await client.query('COMMIT');return res.status(409).json({error:'TIME OUT：相手のターンへ移行しました'})}
    if(Number(m.turn_player_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(409).json({error:'現在は相手のターンです'})}
    await client.query('UPDATE quick_matches SET live_selection=$1 WHERE id=$2',[keys.join(''),id]);await client.query('COMMIT');res.json({ok:true});
  }catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}
});

app.post('/api/quick-matches/:id/guess',requireUser,async(req,res,next)=>{const id=Number(req.params.id);const code=Array.isArray(req.body.keys)?req.body.keys.map(String).join(''):String(req.body.code||'');if(!validKeyCode(code))return res.status(400).json({error:'重複なしで4つのPASSKEYを選択してください'});const client=await pool.connect();try{await client.query('BEGIN');let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}if(m.status!=='in_progress'){await client.query('ROLLBACK');return res.status(409).json({error:'対戦は進行中ではありません'})}if(Number(m.turn_player_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(409).json({error:'現在は相手のターンです'})}if(m.turn_started_at&&Date.now()<new Date(m.turn_started_at).getTime()){await client.query('ROLLBACK');return res.status(409).json({error:'BATTLE STARTING...'})}if(m.turn_started_at&&new Date(m.turn_started_at).getTime()<=Date.now()-60000){const next=Number(m.turn_player_id)===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);await client.query(`UPDATE quick_matches SET turn_player_id=$1,turn_no=turn_no+1,turn_started_at=NOW(),live_selection='' WHERE id=$2`,[next,id]);await client.query('COMMIT');return res.status(409).json({error:'TIME OUT：相手のターンへ移行しました'})}const isChallenger=Number(m.challenger_id)===Number(req.userId);if(!isChallenger&&Number(m.opponent_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(403).json({error:'このマッチに参加していません'})}const targetSecret=isChallenger?m.opponent_secret:m.challenger_secret;const playerName=isChallenger?m.challenger_name:m.opponent_name;const score=hbScore(targetSecret,code);await client.query(`INSERT INTO hit_blow_guesses(match_id,player_id,player_name,turn_no,guess,hits,blows) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,req.userId,playerName,m.turn_no,code,score.hits,score.blows]);if(score.hits===4){const winnerId=Number(req.userId),loserId=isChallenger?Number(m.opponent_id):Number(m.challenger_id);const winner=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[winnerId])).rows[0];const loser=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[loserId])).rows[0];const wager=Number(m.wager);if(!winner||!loser||Number(loser.points)<wager){await client.query('ROLLBACK');return res.status(409).json({error:'ポイント状態が変化したため勝敗を確定できません。運営に確認してください'})}const winnerPoints=Number(winner.points)+wager,loserPoints=Number(loser.points)-wager;await client.query('UPDATE users SET points=$1 WHERE id=$2',[winnerPoints,winnerId]);await client.query('UPDATE users SET points=$1 WHERE id=$2',[loserPoints,loserId]);await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[winnerId,wager,`QUICK HIT&BLOW #${id} 勝利`,'match_win',loserId,loser.username]);await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[loserId,-wager,`QUICK HIT&BLOW #${id} 敗北`,'match_loss',winnerId,winner.username]);m=(await client.query(`UPDATE quick_matches SET status='completed',winner_user_id=$1,winner_name=$2,completed_at=NOW(),live_selection='' WHERE id=$3 RETURNING *`,[winnerId,winner.username,id])).rows[0];await client.query('COMMIT');if(loserPoints===0)scheduleElimination(loserId);return res.json({ok:true,result:score,completed:true,match:publicQuickMatch(m,req.userId)});}const next=isChallenger?Number(m.opponent_id):Number(m.challenger_id);m=(await client.query(`UPDATE quick_matches SET turn_player_id=$1,turn_no=turn_no+1,turn_started_at=NOW(),live_selection='' WHERE id=$2 RETURNING *`,[next,id])).rows[0];await client.query('COMMIT');res.json({ok:true,result:score,completed:false,match:publicQuickMatch(m,req.userId)});}catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}});

function jankenWinner(a,b){
  if(a===b)return 0;
  if((a==='rock'&&b==='scissors')||(a==='scissors'&&b==='paper')||(a==='paper'&&b==='rock'))return 1;
  return 2;
}
const JANKEN_ROUND_MS=15000;
const JANKEN_RESULT_GAP_MS=6200; // next 15s selection window starts after the round result overlay closes
const JANKEN_HANDS=['rock','paper','scissors'];
function randomJanken(){return JANKEN_HANDS[Math.floor(Math.random()*JANKEN_HANDS.length)]}

async function resolveJankenRound(client,m){
  if(!m||m.game_type!=='janken'||m.status!=='in_progress')return m;
  const started=m.janken_round_started_at?new Date(m.janken_round_started_at).getTime():0;
  if(!started || Date.now()<started+JANKEN_ROUND_MS)return m;

  const challengerChoice=m.challenger_janken_choice||randomJanken();
  const opponentChoice=m.opponent_janken_choice||randomJanken();
  const outcome=jankenWinner(challengerChoice,opponentChoice);
  let winnerId=null,result='draw',cw=Number(m.challenger_janken_wins||0),ow=Number(m.opponent_janken_wins||0);
  if(outcome===1){winnerId=Number(m.challenger_id);result='challenger';cw++;}
  if(outcome===2){winnerId=Number(m.opponent_id);result='opponent';ow++;}
  await client.query(`INSERT INTO janken_rounds(match_id,round_no,challenger_choice,opponent_choice,winner_user_id,result) VALUES($1,$2,$3,$4,$5,$6)`,[m.id,Number(m.janken_round||1),challengerChoice,opponentChoice,winnerId,result]);

  const complete=cw>=3||ow>=3;
  if(complete){
    const finalWinnerId=cw>=3?Number(m.challenger_id):Number(m.opponent_id),loserId=finalWinnerId===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);
    const winner=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[finalWinnerId])).rows[0];
    const loser=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[loserId])).rows[0];
    const wager=Number(m.wager);
    if(!winner||!loser||Number(loser.points)<wager)throw Object.assign(new Error('ポイント状態が変化したため勝敗を確定できません。運営に確認してください'),{status:409});
    const wp=Number(winner.points)+wager,lp=Number(loser.points)-wager;
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[wp,finalWinnerId]);
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[lp,loserId]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[finalWinnerId,wager,`QUICK JANKEN #${m.id} 勝利`,'match_win',loserId,loser.username]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[loserId,-wager,`QUICK JANKEN #${m.id} 敗北`,'match_loss',finalWinnerId,winner.username]);
    m=(await client.query(`UPDATE quick_matches SET challenger_janken_wins=$1,opponent_janken_wins=$2,challenger_janken_choice=NULL,opponent_janken_choice=NULL,status='completed',winner_user_id=$3,winner_name=$4,completed_at=NOW() WHERE id=$5 RETURNING *`,[cw,ow,finalWinnerId,winner.username,m.id])).rows[0];
    if(lp===0)scheduleElimination(loserId);
    return m;
  }

  m=(await client.query(`UPDATE quick_matches SET challenger_janken_wins=$1,opponent_janken_wins=$2,challenger_janken_choice=NULL,opponent_janken_choice=NULL,janken_round=janken_round+$3,janken_round_started_at=NOW() + ($5 * INTERVAL '1 millisecond') WHERE id=$4 RETURNING *`,[cw,ow,result==='draw'?0:1,m.id,JANKEN_RESULT_GAP_MS])).rows[0];
  return m;
}

app.get('/api/quick-matches/:id/janken-state',requireUser,async(req,res,next)=>{
  const id=Number(req.params.id),client=await pool.connect();
  try{
    await client.query('BEGIN');
    let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    const uid=Number(req.userId);
    if(Number(m.challenger_id)!==uid&&Number(m.opponent_id)!==uid){await client.query('ROLLBACK');return res.status(403).json({error:'このマッチに参加していません'})}
    if(m.game_type!=='janken'){await client.query('ROLLBACK');return res.status(400).json({error:'このマッチはJANKENではありません'})}
    if(m.status==='in_progress')m=await resolveJankenRound(client,m);
    await client.query('COMMIT');
    const full=(await query(`${quickSelect} WHERE q.id=$1`,[id])).rows[0];
    const rounds=await query('SELECT round_no,challenger_choice,opponent_choice,winner_user_id,result,created_at FROM janken_rounds WHERE match_id=$1 ORDER BY id',[id]);
    res.json({match:publicQuickMatch(full,uid),rounds:rounds.rows.map(x=>({roundNo:Number(x.round_no),challengerChoice:x.challenger_choice,opponentChoice:x.opponent_choice,winnerUserId:x.winner_user_id?Number(x.winner_user_id):null,result:x.result,createdAt:x.created_at}))});
  }catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}
});

app.post('/api/quick-matches/:id/janken-choice',requireUser,async(req,res,next)=>{
  const id=Number(req.params.id),choice=String(req.body.choice||'');
  if(!JANKEN_HANDS.includes(choice))return res.status(400).json({error:'手を選択してください'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    if(m.game_type!=='janken'||m.status!=='in_progress'){await client.query('ROLLBACK');return res.status(409).json({error:'現在じゃんけんを選択できません'})}
    const uid=Number(req.userId),isC=Number(m.challenger_id)===uid,isO=Number(m.opponent_id)===uid;
    if(!isC&&!isO){await client.query('ROLLBACK');return res.status(403).json({error:'このマッチに参加していません'})}
    const started=m.janken_round_started_at?new Date(m.janken_round_started_at).getTime():0;
    if(started&&Date.now()<started){await client.query('ROLLBACK');return res.status(409).json({error:'次ラウンド準備中です'})}
    if(started&&Date.now()>=started+JANKEN_ROUND_MS){m=await resolveJankenRound(client,m);await client.query('COMMIT');return res.status(409).json({error:'このラウンドの選択時間は終了しました'})}
    const col=isC?'challenger_janken_choice':'opponent_janken_choice';
    m=(await client.query(`UPDATE quick_matches SET ${col}=$1 WHERE id=$2 RETURNING *`,[choice,id])).rows[0];
    await client.query('COMMIT');
    res.json({ok:true,changeable:true,match:publicQuickMatch(m,uid)});
  }catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}
});

// ---------------------------------------------------------------------------

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
app.get('/rule',(req,res)=>res.sendFile(path.join(__dirname,'public','rule.html')));
app.get('/match',(req,res)=>res.sendFile(path.join(__dirname,'public','match.html')));
app.get('/hit-blow',(req,res)=>res.sendFile(path.join(__dirname,'public','hit-blow.html')));
app.get('/janken',(req,res)=>res.sendFile(path.join(__dirname,'public','janken.html')));
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
