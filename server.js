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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS selected_title_key VARCHAR(64) NOT NULL DEFAULT 'rookie';

    CREATE TABLE IF NOT EXISTS user_titles (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title_key VARCHAR(64) NOT NULL,
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,title_key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_titles_user ON user_titles(user_id, unlocked_at);

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id BIGSERIAL PRIMARY KEY,
      category VARCHAR(16) NOT NULL CHECK(category IN ('adjust','battle')),
      summary TEXT NOT NULL,
      user_name TEXT,
      delta INTEGER,
      counterpart_name TEXT,
      staff_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS global_chat (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_global_chat_recent ON global_chat(id DESC);

    CREATE TABLE IF NOT EXISTS friendships (
      id BIGSERIAL PRIMARY KEY,
      user_a BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      CHECK(user_a < user_b),
      UNIQUE(user_a,user_b)
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_a,status);
    CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b,status);

    CREATE TABLE IF NOT EXISTS direct_messages (
      id BIGSERIAL PRIMARY KEY,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message VARCHAR(240) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender_id,receiver_id,id DESC);

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

    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS chinchiro_round INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS chinchiro_attempt INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS challenger_chinchiro_role VARCHAR(24);
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS challenger_chinchiro_value INTEGER;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS challenger_chinchiro_dice VARCHAR(8);
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS opponent_chinchiro_role VARCHAR(24);
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS opponent_chinchiro_value INTEGER;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS opponent_chinchiro_dice VARCHAR(8);
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS challenger_chinchiro_wins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS opponent_chinchiro_wins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS chinchiro_last_round_winner_id BIGINT;
    ALTER TABLE quick_matches ADD COLUMN IF NOT EXISTS chinchiro_last_round_no INTEGER;

    CREATE TABLE IF NOT EXISTS chinchiro_rolls (
      id BIGSERIAL PRIMARY KEY,
      match_id BIGINT NOT NULL REFERENCES quick_matches(id) ON DELETE CASCADE,
      round_no INTEGER NOT NULL,
      player_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      player_name TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      dice VARCHAR(8) NOT NULL,
      role VARCHAR(24) NOT NULL,
      role_value INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chinchiro_rolls_match ON chinchiro_rolls(match_id,id);
  `);

  await query(`DELETE FROM admin_audit_log WHERE id NOT IN (SELECT id FROM admin_audit_log ORDER BY id DESC LIMIT 20)`);

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
    const s = await one('SELECT id,username,role FROM staff WHERE id=$1', [req.session.staffId]);
    if (!s) return res.status(403).json({ error: 'スタッフ権限が必要です' });
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
  }, 60000);
  eliminationTimers.set(userId, timer);
}


const TITLE_DEFS={
  rookie:{name:'ROOKIE',jp:'ルーキー',tier:'C',image:'/titles/rookie.webp'},
  rank1:{name:'1ST PLACE',jp:'1位到達者',tier:'S',image:'/titles/rank1.webp'},
  rank2:{name:'2ND PLACE',jp:'2位到達者',tier:'S',image:'/titles/rank2.webp'},
  rank3:{name:'3RD PLACE',jp:'3位到達者',tier:'S',image:'/titles/rank3.webp'},
  hitblow5:{name:'CODE SCOUT',jp:'HIT & BLOW 5戦',tier:'B',image:'/titles/hitblow5.webp'},
  hitblow10:{name:'CODE HUNTER',jp:'HIT & BLOW 10戦',tier:'A',image:'/titles/hitblow10.webp'},
  hitblow15:{name:'CODE SOVEREIGN',jp:'HIT & BLOW 15戦',tier:'S',image:'/titles/hitblow15.webp'},
  janken5:{name:'HAND INITIATE',jp:'JANKEN 5戦',tier:'B',image:'/titles/janken5.webp'},
  janken10:{name:'HAND DUELIST',jp:'JANKEN 10戦',tier:'A',image:'/titles/janken10.webp'},
  janken15:{name:'HAND MASTER',jp:'JANKEN 15戦',tier:'S',image:'/titles/janken15.webp'},
  chinchiro5:{name:'DICE RUNNER',jp:'CHINCHIRO 5戦',tier:'B',image:'/titles/chinchiro5.webp'},
  chinchiro10:{name:'DICE STRIKER',jp:'CHINCHIRO 10戦',tier:'A',image:'/titles/chinchiro10.webp'},
  chinchiro15:{name:'DICE EMPEROR',jp:'CHINCHIRO 15戦',tier:'S',image:'/titles/chinchiro15.webp'}
};
function titleMeta(key){const k=TITLE_DEFS[key]?key:'rookie';return {key:k,...TITLE_DEFS[k]}}
async function unlockTitle(userId,key,client=pool){if(!TITLE_DEFS[key])return;await client.query(`INSERT INTO user_titles(user_id,title_key) VALUES($1,$2) ON CONFLICT DO NOTHING`,[userId,key]);}
async function ensureBaseTitle(userId,client=pool){await unlockTitle(userId,'rookie',client);}
async function awardPodiumTitles(client=pool){const r=await client.query(`SELECT id FROM users WHERE points>0 ORDER BY points DESC,id ASC LIMIT 3`);for(let i=0;i<r.rows.length;i++)await unlockTitle(Number(r.rows[i].id),`rank${i+1}`,client);}
async function awardQuickBattleTitles(userId,gameType,client=pool){const r=await client.query(`SELECT COUNT(*)::int AS n FROM quick_matches WHERE status='completed' AND game_type=$1 AND (challenger_id=$2 OR opponent_id=$2)`,[gameType,userId]);const n=Number(r.rows[0]?.n||0);for(const t of [5,10,15])if(n>=t)await unlockTitle(userId,`${gameType}${t}`,client);}
async function addAudit(category,summary,{userName=null,delta=null,counterpartName=null,staffName=null}={},client=pool){await client.query(`INSERT INTO admin_audit_log(category,summary,user_name,delta,counterpart_name,staff_name) VALUES($1,$2,$3,$4,$5,$6)`,[category,summary,userName,delta,counterpartName,staffName]);await client.query(`DELETE FROM admin_audit_log WHERE id NOT IN (SELECT id FROM admin_audit_log ORDER BY id DESC LIMIT 20)`);}

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
    await ensureBaseTitle(Number(user.id));
    await awardPodiumTitles();
    await regenerate(req); req.session.userId = Number(user.id); req.session.staffId = null; await saveSession(req); clearAttempt(req);
    const authToken = issueParticipantToken(user.id);
    res.json({ ok: true, user: { id:Number(user.id), public_code:user.public_code, username:user.username, points:Number(user.points), avatar_key:user.avatar_key, created_at:user.created_at }, authToken });
  } catch (e) { next(e); }
});
app.post('/api/logout', requireUser, (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', requireUser, async (req, res, next) => {
  try {
    await ensureBaseTitle(req.userId); await awardQuickBattleTitles(req.userId,'hitblow'); await awardQuickBattleTitles(req.userId,'janken'); await awardQuickBattleTitles(req.userId,'chinchiro'); await awardPodiumTitles();
    const u = await one('SELECT id,public_code,username,points,avatar_key,selected_title_key,created_at FROM users WHERE id=$1', [req.userId]);
    const titles=await query('SELECT title_key,unlocked_at FROM user_titles WHERE user_id=$1 ORDER BY unlocked_at,title_key',[req.userId]).catch(()=>({rows:[]}));
    res.json({ ...u, id:Number(u.id), points:Number(u.points), selectedTitle:titleMeta(u.selected_title_key), titles:titles.rows.map(x=>titleMeta(x.title_key)) });
  } catch(e){ next(e); }
});
app.get('/api/titles',requireUser,async(req,res,next)=>{try{await ensureBaseTitle(req.userId);await awardQuickBattleTitles(req.userId,'hitblow');await awardQuickBattleTitles(req.userId,'janken');await awardQuickBattleTitles(req.userId,'chinchiro');await awardPodiumTitles();const u=await one('SELECT selected_title_key FROM users WHERE id=$1',[req.userId]);const r=await query('SELECT title_key,unlocked_at FROM user_titles WHERE user_id=$1',[req.userId]);const owned=new Map(r.rows.map(x=>[x.title_key,x.unlocked_at]));res.json({selectedKey:u?.selected_title_key||'rookie',titles:Object.keys(TITLE_DEFS).map(key=>({...titleMeta(key),owned:owned.has(key),unlockedAt:owned.get(key)||null}))});}catch(e){next(e)}});
app.post('/api/titles/select',requireUser,async(req,res,next)=>{try{const key=String(req.body.key||'');const owned=await one('SELECT 1 FROM user_titles WHERE user_id=$1 AND title_key=$2',[req.userId,key]);if(!owned)return res.status(403).json({error:'未獲得の称号です'});await query('UPDATE users SET selected_title_key=$1 WHERE id=$2',[key,req.userId]);res.json({ok:true,title:titleMeta(key)});}catch(e){next(e)}});
app.post('/api/me/avatar',requireUser,async(req,res,next)=>{try{const key=cleanAvatarKey(req.body.avatarKey);if(!key)return res.status(400).json({error:'アイコンを選択してください'});await query('UPDATE users SET avatar_key=$1 WHERE id=$2',[key,req.userId]);res.json({ok:true,avatarKey:key});}catch(e){next(e)}});
app.post('/api/eliminate-me',requireUser,async(req,res,next)=>{try{const u=await one('SELECT id,points FROM users WHERE id=$1',[req.userId]);if(!u)return res.json({ok:true});if(Number(u.points)!==0)return res.status(409).json({error:'0ptではありません'});await deleteUserHard(req.userId);res.json({ok:true});}catch(e){next(e)}});

app.get('/api/my-history', requireUser, async (req, res, next) => {
  try {
    const r = await query(`SELECT h.id,h.delta,h.reason,h.action_type,h.created_at,COALESCE(c.username,h.counterpart_name) counterpart
      FROM point_history h LEFT JOIN users c ON c.id=h.counterpart_user_id WHERE h.user_id=$1 ORDER BY h.id DESC LIMIT 40`, [req.userId]);
    res.json(r.rows.map(x=>({...x,id:Number(x.id),delta:Number(x.delta)})));
  } catch(e){ next(e); }
});
app.get('/api/ranking', async (req, res, next) => {
  try { await awardPodiumTitles(); const r=await query('SELECT public_code,username,points,avatar_key,selected_title_key FROM users WHERE points>0 ORDER BY points DESC,id ASC LIMIT 100'); res.json(r.rows.map(x=>({...x,points:Number(x.points)}))); } catch(e){ next(e); }
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
    challenger:{id:row.challenger_id?Number(row.challenger_id):null,name:row.challenger_name,code:row.challenger_code,avatarKey:row.challenger_avatar||null,titleKey:row.challenger_title||'rookie'},
    opponent:{id:row.opponent_id?Number(row.opponent_id):null,name:row.opponent_name,code:row.opponent_code,avatarKey:row.opponent_avatar||null,titleKey:row.opponent_title||'rookie'},
    referee:{id:row.referee_id?Number(row.referee_id):null,name:row.referee_name,code:row.referee_code,avatarKey:row.referee_avatar||null,titleKey:row.referee_title||'rookie'},
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
    const matchSelect = `SELECT m.*, cu.avatar_key AS challenger_avatar, cu.selected_title_key AS challenger_title, ou.avatar_key AS opponent_avatar, ou.selected_title_key AS opponent_title, ru.avatar_key AS referee_avatar, ru.selected_title_key AS referee_title
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
    await addAudit('battle',`CUSTOM MATCH // ${winner.username} WIN ${wager}pt`,{userName:winner.username,delta:wager,counterpartName:loser.username},client);await client.query('COMMIT');await awardPodiumTitles();if(loserPoints===0)scheduleElimination(loserId);
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
    challenger:{id:challengerId,name:row.challenger_name,code:row.challenger_code,avatarKey:row.challenger_avatar||null,titleKey:row.challenger_title||'rookie'},
    opponent:{id:opponentId,name:row.opponent_name,code:row.opponent_code,avatarKey:row.opponent_avatar||null,titleKey:row.opponent_title||'rookie'},
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
    chinchiroRound:Number(row.chinchiro_round||1),
    chinchiroAttempt:Number(row.chinchiro_attempt||0),
    challengerChinchiroRole:row.challenger_chinchiro_role||null,
    challengerChinchiroValue:row.challenger_chinchiro_value==null?null:Number(row.challenger_chinchiro_value),
    challengerChinchiroDice:row.challenger_chinchiro_dice||null,
    opponentChinchiroRole:row.opponent_chinchiro_role||null,
    opponentChinchiroValue:row.opponent_chinchiro_value==null?null:Number(row.opponent_chinchiro_value),
    opponentChinchiroDice:row.opponent_chinchiro_dice||null,
    challengerChinchiroWins:Number(row.challenger_chinchiro_wins||0),
    opponentChinchiroWins:Number(row.opponent_chinchiro_wins||0),
    chinchiroLastRoundWinnerId:row.chinchiro_last_round_winner_id?Number(row.chinchiro_last_round_winner_id):null,
    chinchiroLastRoundNo:row.chinchiro_last_round_no==null?null:Number(row.chinchiro_last_round_no),
    winnerUserId:row.winner_user_id?Number(row.winner_user_id):null,winnerName:row.winner_name||null,
    createdAt:row.created_at,matchedAt:row.matched_at,startedAt:row.started_at,completedAt:row.completed_at
  };
}
const quickSelect=`SELECT q.*, cu.avatar_key AS challenger_avatar, cu.selected_title_key AS challenger_title, ou.avatar_key AS opponent_avatar, ou.selected_title_key AS opponent_title
  FROM quick_matches q LEFT JOIN users cu ON cu.id=q.challenger_id LEFT JOIN users ou ON ou.id=q.opponent_id`;

app.post('/api/quick-matches',requireUser,async(req,res,next)=>{
  const opponentCode=String(req.body.opponentCode||'').trim();const wager=Number(req.body.wager);const gameType=String(req.body.gameType||'hitblow');
  if(!['hitblow','janken','chinchiro'].includes(gameType))return res.status(400).json({error:'このQUICK BATTLEは現在利用できません'});
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
    }else if(m.game_type==='chinchiro'){
      const first=Math.random()<0.5?Number(m.challenger_id):Number(m.opponent_id);
      m=(await client.query(`UPDATE quick_matches SET opponent_approved=TRUE,status='in_progress',matched_at=NOW(),started_at=NOW(),first_player_id=$1,turn_player_id=$1,turn_no=1,turn_started_at=NOW() + INTERVAL '4 seconds',chinchiro_round=1,chinchiro_attempt=0,challenger_chinchiro_role=NULL,challenger_chinchiro_value=NULL,challenger_chinchiro_dice=NULL,opponent_chinchiro_role=NULL,opponent_chinchiro_value=NULL,opponent_chinchiro_dice=NULL,challenger_chinchiro_wins=0,opponent_chinchiro_wins=0,chinchiro_last_round_winner_id=NULL,chinchiro_last_round_no=NULL WHERE id=$2 RETURNING *`,[first,id])).rows[0];
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

app.post('/api/quick-matches/:id/guess',requireUser,async(req,res,next)=>{const id=Number(req.params.id);const code=Array.isArray(req.body.keys)?req.body.keys.map(String).join(''):String(req.body.code||'');if(!validKeyCode(code))return res.status(400).json({error:'重複なしで4つのPASSKEYを選択してください'});const client=await pool.connect();try{await client.query('BEGIN');let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}if(m.status!=='in_progress'){await client.query('ROLLBACK');return res.status(409).json({error:'対戦は進行中ではありません'})}if(Number(m.turn_player_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(409).json({error:'現在は相手のターンです'})}if(m.turn_started_at&&Date.now()<new Date(m.turn_started_at).getTime()){await client.query('ROLLBACK');return res.status(409).json({error:'BATTLE STARTING...'})}if(m.turn_started_at&&new Date(m.turn_started_at).getTime()<=Date.now()-60000){const next=Number(m.turn_player_id)===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);await client.query(`UPDATE quick_matches SET turn_player_id=$1,turn_no=turn_no+1,turn_started_at=NOW(),live_selection='' WHERE id=$2`,[next,id]);await client.query('COMMIT');return res.status(409).json({error:'TIME OUT：相手のターンへ移行しました'})}const isChallenger=Number(m.challenger_id)===Number(req.userId);if(!isChallenger&&Number(m.opponent_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(403).json({error:'このマッチに参加していません'})}const targetSecret=isChallenger?m.opponent_secret:m.challenger_secret;const playerName=isChallenger?m.challenger_name:m.opponent_name;const score=hbScore(targetSecret,code);await client.query(`INSERT INTO hit_blow_guesses(match_id,player_id,player_name,turn_no,guess,hits,blows) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,req.userId,playerName,m.turn_no,code,score.hits,score.blows]);if(score.hits===4){const winnerId=Number(req.userId),loserId=isChallenger?Number(m.opponent_id):Number(m.challenger_id);const winner=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[winnerId])).rows[0];const loser=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[loserId])).rows[0];const wager=Number(m.wager);if(!winner||!loser||Number(loser.points)<wager){await client.query('ROLLBACK');return res.status(409).json({error:'ポイント状態が変化したため勝敗を確定できません。運営に確認してください'})}const winnerPoints=Number(winner.points)+wager,loserPoints=Number(loser.points)-wager;await client.query('UPDATE users SET points=$1 WHERE id=$2',[winnerPoints,winnerId]);await client.query('UPDATE users SET points=$1 WHERE id=$2',[loserPoints,loserId]);await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[winnerId,wager,`QUICK HIT&BLOW #${id} 勝利`,'match_win',loserId,loser.username]);await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[loserId,-wager,`QUICK HIT&BLOW #${id} 敗北`,'match_loss',winnerId,winner.username]);m=(await client.query(`UPDATE quick_matches SET status='completed',winner_user_id=$1,winner_name=$2,completed_at=NOW(),live_selection='' WHERE id=$3 RETURNING *`,[winnerId,winner.username,id])).rows[0];await addAudit('battle',`HIT & BLOW // ${winner.username} WIN ${wager}pt`,{userName:winner.username,delta:wager,counterpartName:loser.username},client);await client.query('COMMIT');await awardQuickBattleTitles(winnerId,'hitblow');await awardQuickBattleTitles(loserId,'hitblow');await awardPodiumTitles();if(loserPoints===0)scheduleElimination(loserId);return res.json({ok:true,result:score,completed:true,match:publicQuickMatch(m,req.userId)});}const next=isChallenger?Number(m.opponent_id):Number(m.challenger_id);m=(await client.query(`UPDATE quick_matches SET turn_player_id=$1,turn_no=turn_no+1,turn_started_at=NOW(),live_selection='' WHERE id=$2 RETURNING *`,[next,id])).rows[0];await client.query('COMMIT');res.json({ok:true,result:score,completed:false,match:publicQuickMatch(m,req.userId)});}catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}});


// QUICK BATTLE: CHINCHIRO -----------------------------------------------------
function rollD6(){return 1+Math.floor(Math.random()*6)}
function evalChinchiro(dice){
  const s=[...dice].sort((a,b)=>a-b);
  if(s[0]===4&&s[1]===5&&s[2]===6)return {role:'shigoro',value:100,label:'SHIGORO / 4-5-6'};
  if(s[0]===1&&s[1]===2&&s[2]===3)return {role:'hifumi',value:0,label:'HIFUMI / 1-2-3'};
  if(s[0]===s[2])return {role:'arashi',value:80+s[0],label:`ARASHI / ${s[0]}-${s[0]}-${s[0]}`};
  if(s[0]===s[1])return {role:'point',value:20+s[2],label:`POINT ${s[2]}`};
  if(s[1]===s[2])return {role:'point',value:20+s[0],label:`POINT ${s[0]}`};
  return {role:'none',value:10,label:'NO ROLE'};
}
app.get('/api/quick-matches/:id/chinchiro-state',requireUser,async(req,res,next)=>{
  const id=Number(req.params.id);
  try{
    const r=await query(`${quickSelect} WHERE q.id=$1 AND (q.challenger_id=$2 OR q.opponent_id=$2)`,[id,req.userId]);
    const row=r.rows[0];if(!row)return res.status(404).json({error:'マッチが見つかりません'});
    if(row.game_type!=='chinchiro')return res.status(400).json({error:'このマッチはCHINCHIROではありません'});
    const rolls=await query(`SELECT round_no,player_id,player_name,attempt_no,dice,role,role_value,created_at FROM chinchiro_rolls WHERE match_id=$1 ORDER BY id`,[id]);
    res.json({match:publicQuickMatch(row,req.userId),rolls:rolls.rows.map(x=>({roundNo:Number(x.round_no),playerId:Number(x.player_id),playerName:x.player_name,attemptNo:Number(x.attempt_no),dice:x.dice,role:x.role,roleValue:Number(x.role_value),createdAt:x.created_at}))});
  }catch(e){next(e)}
});
app.post('/api/quick-matches/:id/chinchiro-roll',requireUser,async(req,res,next)=>{
  const id=Number(req.params.id),client=await pool.connect();
  try{
    await client.query('BEGIN');
    let m=(await client.query('SELECT * FROM quick_matches WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!m){await client.query('ROLLBACK');return res.status(404).json({error:'マッチが見つかりません'})}
    if(m.game_type!=='chinchiro'||m.status!=='in_progress'){await client.query('ROLLBACK');return res.status(409).json({error:'現在チンチロを実行できません'})}
    if(Number(m.turn_player_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(409).json({error:'現在は相手のターンです'})}
    if(m.turn_started_at&&Date.now()<new Date(m.turn_started_at).getTime()){await client.query('ROLLBACK');return res.status(409).json({error:'BATTLE STARTING...'})}
    const isC=Number(m.challenger_id)===Number(req.userId);
    if(!isC&&Number(m.opponent_id)!==Number(req.userId)){await client.query('ROLLBACK');return res.status(403).json({error:'このマッチに参加していません'})}
    const attempt=Number(m.chinchiro_attempt||0)+1;
    if(attempt>3){await client.query('ROLLBACK');return res.status(409).json({error:'この手番のロール回数を使い切っています'})}
    const dice=[rollD6(),rollD6(),rollD6()],ev=evalChinchiro(dice),diceText=dice.join('-');
    const playerName=isC?m.challenger_name:m.opponent_name;
    await client.query(`INSERT INTO chinchiro_rolls(match_id,round_no,player_id,player_name,attempt_no,dice,role,role_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,Number(m.chinchiro_round||1),req.userId,playerName,attempt,diceText,ev.role,ev.value]);
    const final=ev.role!=='none'||attempt>=3;
    if(!final){
      m=(await client.query(`UPDATE quick_matches SET chinchiro_attempt=$1 WHERE id=$2 RETURNING *`,[attempt,id])).rows[0];
      await client.query('COMMIT');return res.json({ok:true,roll:{dice,attempt,final:false,...ev},match:publicQuickMatch(m,req.userId)});
    }
    const pfx=isC?'challenger':'opponent';
    m=(await client.query(`UPDATE quick_matches SET ${pfx}_chinchiro_role=$1,${pfx}_chinchiro_value=$2,${pfx}_chinchiro_dice=$3,chinchiro_attempt=0 WHERE id=$4 RETURNING *`,[ev.role,ev.value,diceText,id])).rows[0];
    const cDone=!!m.challenger_chinchiro_role,oDone=!!m.opponent_chinchiro_role;
    if(!(cDone&&oDone)){
      const next=isC?Number(m.opponent_id):Number(m.challenger_id);
      m=(await client.query(`UPDATE quick_matches SET turn_player_id=$1,turn_no=turn_no+1,turn_started_at=NOW() + INTERVAL '2500 milliseconds' WHERE id=$2 RETURNING *`,[next,id])).rows[0];
      await client.query('COMMIT');return res.json({ok:true,roll:{dice,attempt,final:true,...ev},match:publicQuickMatch(m,req.userId)});
    }
    const cv=Number(m.challenger_chinchiro_value),ov=Number(m.opponent_chinchiro_value);
    const roundNo=Number(m.chinchiro_round||1);
    if(cv===ov){
      const nextFirst=Number(m.first_player_id)===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);
      m=(await client.query(`UPDATE quick_matches SET chinchiro_attempt=0,challenger_chinchiro_role=NULL,challenger_chinchiro_value=NULL,challenger_chinchiro_dice=NULL,opponent_chinchiro_role=NULL,opponent_chinchiro_value=NULL,opponent_chinchiro_dice=NULL,chinchiro_last_round_winner_id=NULL,chinchiro_last_round_no=$1,first_player_id=$2,turn_player_id=$2,turn_no=turn_no+1,turn_started_at=NOW() + INTERVAL '3500 milliseconds' WHERE id=$3 RETURNING *`,[roundNo,nextFirst,id])).rows[0];
      await client.query('COMMIT');return res.json({ok:true,roll:{dice,attempt,final:true,...ev},draw:true,roundNo,match:publicQuickMatch(m,req.userId)});
    }
    const roundWinnerId=cv>ov?Number(m.challenger_id):Number(m.opponent_id);
    const cWon=roundWinnerId===Number(m.challenger_id);
    const nextCWins=Number(m.challenger_chinchiro_wins||0)+(cWon?1:0);
    const nextOWins=Number(m.opponent_chinchiro_wins||0)+(cWon?0:1);
    const matchWon=nextCWins>=2||nextOWins>=2;
    if(!matchWon){
      const nextFirst=Number(m.first_player_id)===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);
      m=(await client.query(`UPDATE quick_matches SET challenger_chinchiro_wins=$1,opponent_chinchiro_wins=$2,chinchiro_last_round_winner_id=$3,chinchiro_last_round_no=$4,chinchiro_round=chinchiro_round+1,chinchiro_attempt=0,challenger_chinchiro_role=NULL,challenger_chinchiro_value=NULL,challenger_chinchiro_dice=NULL,opponent_chinchiro_role=NULL,opponent_chinchiro_value=NULL,opponent_chinchiro_dice=NULL,first_player_id=$5,turn_player_id=$5,turn_no=turn_no+1,turn_started_at=NOW() + INTERVAL '4200 milliseconds' WHERE id=$6 RETURNING *`,[nextCWins,nextOWins,roundWinnerId,roundNo,nextFirst,id])).rows[0];
      await client.query('COMMIT');return res.json({ok:true,roll:{dice,attempt,final:true,...ev},roundWinnerId,roundNo,roundComplete:true,match:publicQuickMatch(m,req.userId)});
    }
    const winnerId=roundWinnerId;
    const loserId=winnerId===Number(m.challenger_id)?Number(m.opponent_id):Number(m.challenger_id);
    const winner=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[winnerId])).rows[0];
    const loser=(await client.query('SELECT id,username,points FROM users WHERE id=$1 FOR UPDATE',[loserId])).rows[0];
    const wager=Number(m.wager);
    if(!winner||!loser||Number(loser.points)<wager){await client.query('ROLLBACK');return res.status(409).json({error:'ポイント状態が変化したため勝敗を確定できません。運営に確認してください'})}
    const winnerPoints=Number(winner.points)+wager,loserPoints=Number(loser.points)-wager;
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[winnerPoints,winnerId]);
    await client.query('UPDATE users SET points=$1 WHERE id=$2',[loserPoints,loserId]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[winnerId,wager,`QUICK CHINCHIRO BO3 #${id} 勝利`,'match_win',loserId,loser.username]);
    await client.query(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES($1,$2,$3,$4,$5,$6)`,[loserId,-wager,`QUICK CHINCHIRO BO3 #${id} 敗北`,'match_loss',winnerId,winner.username]);
    m=(await client.query(`UPDATE quick_matches SET challenger_chinchiro_wins=$1,opponent_chinchiro_wins=$2,chinchiro_last_round_winner_id=$3,chinchiro_last_round_no=$4,status='completed',winner_user_id=$3,winner_name=$5,completed_at=NOW() WHERE id=$6 RETURNING *`,[nextCWins,nextOWins,roundWinnerId,roundNo,winner.username,id])).rows[0];
    await addAudit('battle',`CHINCHIRO BO3 // ${winner.username} WIN ${wager}pt`,{userName:winner.username,delta:wager,counterpartName:loser.username},client);await client.query('COMMIT');await awardQuickBattleTitles(winnerId,'chinchiro');await awardQuickBattleTitles(loserId,'chinchiro');await awardPodiumTitles();if(loserPoints===0)scheduleElimination(loserId);
    res.json({ok:true,roll:{dice,attempt,final:true,...ev},completed:true,roundWinnerId,roundNo,roundComplete:true,match:publicQuickMatch(m,req.userId)});
  }catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}
});

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
    await addAudit('battle',`JANKEN BO5 // ${winner.username} WIN ${wager}pt`,{userName:winner.username,delta:wager,counterpartName:loser.username},client);await awardQuickBattleTitles(finalWinnerId,'janken',client);await awardQuickBattleTitles(loserId,'janken',client);await awardPodiumTitles(client);if(lp===0)scheduleElimination(loserId);
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
    const s=await one('SELECT * FROM staff WHERE LOWER(username)=LOWER($1)',[username]);
    if(!s||!(await bcrypt.compare(password,s.password_hash))){failAttempt(req);return res.status(401).json({error:'スタッフIDまたはパスワードが違います'})}
    await regenerate(req);req.session.staffId=Number(s.id);await saveSession(req);clearAttempt(req);res.json({ok:true,username:s.username,role:s.role});
  }catch(e){next(e)}
});
app.post('/api/staff/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/staff/status',async(req,res,next)=>{try{if(!req.session.staffId)return res.json({loggedIn:false});const s=await one('SELECT id,username,role FROM staff WHERE id=$1',[req.session.staffId]);res.json({loggedIn:!!s,staff:s?{...s,id:Number(s.id)}:null})}catch(e){next(e)}});

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
    await client.query('COMMIT');await ensureBaseTitle(Number(r.rows[0].id));res.json({ok:true,id:Number(r.rows[0].id),username,code,startingPoints:STARTING_POINTS,password});
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
    await addAudit('adjust',`POINT ADJUST ${delta>0?'+':''}${delta}pt`,{userName:u.username,delta,staffName:req.staff.username},client);await client.query('COMMIT');await awardPodiumTitles();if(nextPoints===0)scheduleElimination(id);res.json({id,username:u.username,points:nextPoints,eliminated:nextPoints===0});
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
    await addAudit('adjust',`STAFF TRANSFER ${amount}pt`,{userName:from.username,delta:-amount,counterpartName:to.username,staffName:req.staff.username},client);await client.query('COMMIT');await awardPodiumTitles();if(fromPoints===0)scheduleElimination(fromId);res.json({ok:true,eliminated:fromPoints===0,from:{id:fromId,username:from.username,points:fromPoints},to:{id:toId,username:to.username,points:toPoints}});
  }catch(e){await client.query('ROLLBACK');next(e)}finally{client.release()}
});

app.delete('/api/staff/users/:id', requireAdmin, async (req,res,next)=>{try{const u=await deleteUserHard(Number(req.params.id));if(!u)return res.status(404).json({error:'参加者が見つかりません'});res.json({ok:true,username:u.username})}catch(e){next(e)}});
app.get('/api/staff/history', requireStaff, async (req,res,next)=>{try{const type=String(req.query.type||'adjust');const category=type==='battle'?'battle':'adjust';const r=await query(`SELECT id,category,summary,user_name,delta,counterpart_name,staff_name,created_at FROM admin_audit_log WHERE category=$1 ORDER BY id DESC LIMIT 20`,[category]);res.json(r.rows.map(x=>({...x,id:Number(x.id),delta:x.delta==null?null:Number(x.delta)})));}catch(e){next(e)}});
app.get('/api/staff/accounts', requireAdmin, async (req,res,next)=>{try{const r=await query('SELECT id,username,role,created_at FROM staff ORDER BY role,LOWER(username)');res.json(r.rows.map(x=>({...x,id:Number(x.id)})))}catch(e){next(e)}});
app.post('/api/staff/accounts', requireAdmin, async (req,res,next)=>{const username=cleanName(req.body.username),password=String(req.body.password||''),role=req.body.role==='admin'?'admin':'staff';if(username.length<2||username.length>30)return res.status(400).json({error:'スタッフIDは2〜30文字で入力してください'});if(password.length<8||password.length>72)return res.status(400).json({error:'スタッフパスワードは8〜72文字で入力してください'});try{const hash=await bcrypt.hash(password,12),r=await query('INSERT INTO staff(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',[username,hash,role]);res.json({ok:true,id:Number(r.rows[0].id)})}catch(e){if(e.code==='23505')return res.status(409).json({error:'そのスタッフIDは使用済みです'});next(e)}});
app.delete('/api/staff/accounts/:id', requireAdmin, async (req,res,next)=>{try{const id=Number(req.params.id);if(id===req.staff.id)return res.status(400).json({error:'現在ログイン中の自分自身は削除できません'});const target=await one('SELECT id,username,role FROM staff WHERE id=$1',[id]);if(!target)return res.status(404).json({error:'アカウントが見つかりません'});if(target.role==='admin'){const count=await one("SELECT COUNT(*)::int AS count FROM staff WHERE role='admin'");if(Number(count.count)<=1)return res.status(400).json({error:'最後の管理者は削除できません'})}await query('DELETE FROM staff WHERE id=$1',[id]);res.json({ok:true,username:target.username,role:target.role})}catch(e){next(e)}});


// NEXUS NETWORK: GLOBAL CHAT / FRIENDS / LIVE SPECTATE -----------------------
function socialProfile(row,prefix=''){const g=k=>row[prefix+k];return {id:Number(g('id')),code:g('public_code'),name:g('username'),avatarKey:g('avatar_key')||'avatar-01',title:titleMeta(g('selected_title_key')||'rookie')}}
function friendPair(a,b){a=Number(a);b=Number(b);return a<b?[a,b]:[b,a]}
async function acceptedFriend(userId,otherId,client=pool){const [a,b]=friendPair(userId,otherId);const r=await client.query("SELECT id FROM friendships WHERE user_a=$1 AND user_b=$2 AND status='accepted'",[a,b]);return r.rows[0]||null}
app.get('/api/chat/global',requireUser,async(req,res,next)=>{try{const r=await query(`SELECT c.id,c.message,c.created_at,u.id AS user_id,u.public_code,u.username,u.avatar_key,u.selected_title_key FROM global_chat c JOIN users u ON u.id=c.user_id WHERE u.points>=0 ORDER BY c.id DESC LIMIT 60`);res.json(r.rows.reverse().map(x=>({id:Number(x.id),message:x.message,createdAt:x.created_at,user:{id:Number(x.user_id),code:x.public_code,name:x.username,avatarKey:x.avatar_key||'avatar-01',title:titleMeta(x.selected_title_key||'rookie')}})))}catch(e){next(e)}});
app.post('/api/chat/global',requireUser,async(req,res,next)=>{try{const message=String(req.body.message||'').trim();if(!message||Array.from(message).length>30)return res.status(400).json({error:'全体メッセージは1〜30文字で入力してください'});const last=await one('SELECT created_at FROM global_chat WHERE user_id=$1 ORDER BY id DESC LIMIT 1',[req.userId]);if(last){const wait=15000-(Date.now()-new Date(last.created_at).getTime());if(wait>0)return res.status(429).json({error:`あと${Math.ceil(wait/1000)}秒待ってください`,retryAfterMs:wait})}const r=await query('INSERT INTO global_chat(user_id,message) VALUES($1,$2) RETURNING id,created_at',[req.userId,message]);res.json({ok:true,id:Number(r.rows[0].id),createdAt:r.rows[0].created_at,cooldownMs:15000})}catch(e){next(e)}});
app.get('/api/friends/search',requireUser,async(req,res,next)=>{try{const code=String(req.query.code||'').trim();if(!/^\d{4}$/.test(code))return res.status(400).json({error:'4桁のPLAYER IDを入力してください'});const u=await one('SELECT id,public_code,username,avatar_key,selected_title_key FROM users WHERE public_code=$1 AND points>=0',[code]);if(!u)return res.status(404).json({error:'PLAYERが見つかりません'});if(Number(u.id)===Number(req.userId))return res.status(400).json({error:'自分自身です'});const [a,b]=friendPair(req.userId,u.id);const f=await one('SELECT id,status,requested_by FROM friendships WHERE user_a=$1 AND user_b=$2',[a,b]);res.json({user:socialProfile(u),friendship:f?{id:Number(f.id),status:f.status,requestedBy:Number(f.requested_by)}:null})}catch(e){next(e)}});
app.get('/api/friends',requireUser,async(req,res,next)=>{try{const r=await query(`SELECT f.*,u.id AS other_id,u.public_code AS other_public_code,u.username AS other_username,u.avatar_key AS other_avatar_key,u.selected_title_key AS other_selected_title_key FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END WHERE f.user_a=$1 OR f.user_b=$1 ORDER BY f.status DESC,f.id DESC`,[req.userId]);res.json(r.rows.map(x=>({id:Number(x.id),status:x.status,direction:Number(x.requested_by)===Number(req.userId)?'outgoing':'incoming',user:socialProfile(x,'other_')})))}catch(e){next(e)}});
app.post('/api/friends/request',requireUser,async(req,res,next)=>{const targetId=Number(req.body.userId);if(!targetId||targetId===Number(req.userId))return res.status(400).json({error:'申請先が不正です'});try{const u=await one('SELECT id FROM users WHERE id=$1',[targetId]);if(!u)return res.status(404).json({error:'PLAYERが見つかりません'});const [a,b]=friendPair(req.userId,targetId);const ex=await one('SELECT id,status,requested_by FROM friendships WHERE user_a=$1 AND user_b=$2',[a,b]);if(ex){if(ex.status==='accepted')return res.status(409).json({error:'すでにフレンドです'});if(Number(ex.requested_by)===targetId){await query("UPDATE friendships SET status='accepted',accepted_at=NOW() WHERE id=$1",[ex.id]);return res.json({ok:true,accepted:true})}return res.status(409).json({error:'すでに申請済みです'})}await query('INSERT INTO friendships(user_a,user_b,requested_by) VALUES($1,$2,$3)',[a,b,req.userId]);res.json({ok:true,accepted:false})}catch(e){next(e)}});
app.post('/api/friends/:id/accept',requireUser,async(req,res,next)=>{try{const id=Number(req.params.id);const f=await one("SELECT * FROM friendships WHERE id=$1 AND status='pending'",[id]);if(!f)return res.status(404).json({error:'申請が見つかりません'});if(Number(f.requested_by)===Number(req.userId)||![Number(f.user_a),Number(f.user_b)].includes(Number(req.userId)))return res.status(403).json({error:'承認できません'});await query("UPDATE friendships SET status='accepted',accepted_at=NOW() WHERE id=$1",[id]);res.json({ok:true})}catch(e){next(e)}});
app.delete('/api/friends/:id',requireUser,async(req,res,next)=>{try{const id=Number(req.params.id);const r=await query('DELETE FROM friendships WHERE id=$1 AND (user_a=$2 OR user_b=$2) RETURNING id',[id,req.userId]);if(!r.rows[0])return res.status(404).json({error:'フレンド情報が見つかりません'});res.json({ok:true})}catch(e){next(e)}});
app.get('/api/friends/:userId/messages',requireUser,async(req,res,next)=>{try{const otherId=Number(req.params.userId);if(!await acceptedFriend(req.userId,otherId))return res.status(403).json({error:'フレンドのみ個別メッセージを利用できます'});const r=await query(`SELECT d.id,d.sender_id,d.receiver_id,d.message,d.created_at,s.username AS sender_name,s.avatar_key AS sender_avatar_key,s.selected_title_key AS sender_selected_title_key FROM direct_messages d JOIN users s ON s.id=d.sender_id WHERE (d.sender_id=$1 AND d.receiver_id=$2) OR (d.sender_id=$2 AND d.receiver_id=$1) ORDER BY d.id DESC LIMIT 100`,[req.userId,otherId]);res.json(r.rows.reverse().map(x=>({id:Number(x.id),senderId:Number(x.sender_id),receiverId:Number(x.receiver_id),message:x.message,createdAt:x.created_at,sender:{name:x.sender_name,avatarKey:x.sender_avatar_key||'avatar-01',title:titleMeta(x.sender_selected_title_key||'rookie')}})))}catch(e){next(e)}});
app.post('/api/friends/:userId/messages',requireUser,async(req,res,next)=>{try{const otherId=Number(req.params.userId),message=String(req.body.message||'').trim();if(!message||Array.from(message).length>100)return res.status(400).json({error:'個別メッセージは1〜100文字で入力してください'});if(!await acceptedFriend(req.userId,otherId))return res.status(403).json({error:'フレンドのみ個別メッセージを利用できます'});await query('INSERT INTO direct_messages(sender_id,receiver_id,message) VALUES($1,$2,$3)',[req.userId,otherId,message]);res.json({ok:true})}catch(e){next(e)}});
app.get('/api/live-matches',requireUser,async(req,res,next)=>{try{const q=await query(`${quickSelect} WHERE q.status IN ('setup','in_progress') ORDER BY q.id DESC LIMIT 40`);const c=await query(`SELECT m.*,cu.avatar_key challenger_avatar,cu.selected_title_key challenger_title,ou.avatar_key opponent_avatar,ou.selected_title_key opponent_title,ru.avatar_key referee_avatar,ru.selected_title_key referee_title FROM matches m LEFT JOIN users cu ON cu.id=m.challenger_id LEFT JOIN users ou ON ou.id=m.opponent_id LEFT JOIN users ru ON ru.id=m.referee_id WHERE m.status IN ('matched','in_progress') ORDER BY m.id DESC LIMIT 20`);res.json({quick:q.rows.map(x=>publicQuickMatch(x,0)),custom:c.rows.map(x=>publicMatch(x,0))})}catch(e){next(e)}});
app.get('/api/spectate/quick/:id',requireUser,async(req,res,next)=>{try{const id=Number(req.params.id);const r=await query(`${quickSelect} WHERE q.id=$1`,[id]);if(!r.rows[0])return res.status(404).json({error:'試合が見つかりません'});const m=publicQuickMatch(r.rows[0],0);const out={match:m,guesses:[],rounds:[],rolls:[]};if(m.gameType==='hitblow'){const g=await query('SELECT player_id,player_name,turn_no,guess,hits,blows,created_at FROM hit_blow_guesses WHERE match_id=$1 ORDER BY id',[id]);out.guesses=g.rows.map(x=>({...x,player_id:Number(x.player_id),turn_no:Number(x.turn_no),hits:Number(x.hits),blows:Number(x.blows)}))}else if(m.gameType==='janken'){const j=await query('SELECT round_no,challenger_choice,opponent_choice,winner_user_id,result,created_at FROM janken_rounds WHERE match_id=$1 ORDER BY id',[id]);out.rounds=j.rows.map(x=>({...x,round_no:Number(x.round_no),winner_user_id:x.winner_user_id?Number(x.winner_user_id):null}))}else if(m.gameType==='chinchiro'){const c=await query('SELECT round_no,player_id,player_name,attempt_no,dice,role,role_value,created_at FROM chinchiro_rolls WHERE match_id=$1 ORDER BY id',[id]);out.rolls=c.rows.map(x=>({...x,round_no:Number(x.round_no),player_id:Number(x.player_id),attempt_no:Number(x.attempt_no),role_value:Number(x.role_value)}))}res.json(out)}catch(e){next(e)}});

app.use(express.static(path.join(__dirname,'public')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/ranking',(req,res)=>res.sendFile(path.join(__dirname,'public','ranking.html')));
app.get('/history',(req,res)=>res.sendFile(path.join(__dirname,'public','history.html')));
app.get('/rule',(req,res)=>res.sendFile(path.join(__dirname,'public','rule.html')));
app.get('/match',(req,res)=>res.sendFile(path.join(__dirname,'public','match.html')));
app.get('/hit-blow',(req,res)=>res.sendFile(path.join(__dirname,'public','hit-blow.html')));
app.get('/janken',(req,res)=>res.sendFile(path.join(__dirname,'public','janken.html')));
app.get('/chinchiro',(req,res)=>res.sendFile(path.join(__dirname,'public','chinchiro.html')));
app.get('/network',(req,res)=>res.sendFile(path.join(__dirname,'public','network.html')));
app.get('/watch',(req,res)=>res.sendFile(path.join(__dirname,'public','watch.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'サーバー処理でエラーが発生しました'})});

(async()=>{
  try{
    await initDb();
    app.listen(PORT,'0.0.0.0',()=>{
      console.log(`NEXUS:ZERO v5.50: http://localhost:${PORT}`);
      console.log('Database: PostgreSQL');
      console.log(`Starting points: ${STARTING_POINTS}`);
      if(SESSION_SECRET.startsWith('replace-this'))console.log('WARNING: SESSION_SECRETを本番用に変更してください。');
      if(PASSWORD_ENCRYPTION_KEY===SESSION_SECRET)console.log('WARNING: PASSWORD_ENCRYPTION_KEYを本番用に別途設定することを推奨します。');
      if(ADMIN_PASSWORD==='change-me-now')console.log('WARNING: 初期管理者パスワードを変更してください。');
    });
  }catch(e){console.error('Startup failed:',e);process.exit(1)}
})();
