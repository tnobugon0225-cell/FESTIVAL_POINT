const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace-this-secret-before-public-use';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const BASE_URL = process.env.BASE_URL || '';
const STARTING_POINTS = Math.max(1, Number(process.env.STARTING_POINTS || 10));

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'festival.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_code TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  device_id TEXT,
  points INTEGER NOT NULL DEFAULT 10 CHECK(points >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS point_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT,
  action_type TEXT NOT NULL DEFAULT 'adjust',
  counterpart_user_id INTEGER,
  counterpart_name TEXT,
  staff_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (counterpart_user_id) REFERENCES users(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS idx_users_code ON users(public_code);
CREATE INDEX IF NOT EXISTS idx_history_user ON point_history(user_id, id DESC);
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'public_code', 'public_code TEXT');
ensureColumn('users', 'device_id', 'device_id TEXT');
ensureColumn('users', 'auth_token_hash', 'auth_token_hash TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device ON users(device_id) WHERE device_id IS NOT NULL`);
ensureColumn('point_history', 'action_type', "action_type TEXT NOT NULL DEFAULT 'adjust'");
ensureColumn('point_history', 'counterpart_user_id', 'counterpart_user_id INTEGER');
ensureColumn('point_history', 'counterpart_name', 'counterpart_name TEXT');
ensureColumn('point_history', 'staff_id', 'staff_id INTEGER');

function makeCode() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n >= 10000) throw new Error('参加者上限（10,000人）に達しています');
  let code;
  do { code = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); }
  while (db.prepare('SELECT 1 FROM users WHERE public_code = ?').get(code));
  return code;
}

// v2以前の英数字コードを4桁番号へ移行
for (const u of db.prepare(`SELECT id FROM users WHERE public_code IS NULL OR public_code='' OR public_code NOT GLOB '[0-9][0-9][0-9][0-9]'`).all()) {
  db.prepare('UPDATE users SET public_code=? WHERE id=?').run(makeCode(), u.id);
}

// 既存の『ノノンガ』アカウントは最低10ptにそろえる（10pt以上は変更しない）
const nononga = db.prepare('SELECT id,points FROM users WHERE username=? COLLATE NOCASE').get('ノノンガ');
if (nononga && nononga.points < 10) {
  db.prepare('UPDATE users SET points=10 WHERE id=?').run(nononga.id);
}

if (!db.prepare('SELECT id FROM staff LIMIT 1').get()) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare('INSERT INTO staff (username, password_hash, role) VALUES (?, ?, ?)').run(ADMIN_USERNAME, hash, 'admin');
  console.log(`Created initial admin account: ${ADMIN_USERNAME}`);
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
// 動的APIはブラウザ/CDNにキャッシュさせない。ポイント・履歴・ランキングを常に最新化する。
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'festival.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 }
}));

function cleanName(v) { return String(v || '').trim().replace(/\s+/g, ' '); }
function cleanReason(v) { return cleanName(v).slice(0, 80); }
function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function newDeviceId() { return crypto.randomBytes(24).toString('hex'); }
function getOrCreateDeviceId(req, res) {
  let id = readCookie(req, 'festival.device');
  if (!/^[a-f0-9]{48}$/.test(id)) id = newDeviceId();
  res.cookie('festival.device', id, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 365 });
  return id;
}
function bindDeviceCookie(res, deviceId) {
  if (!deviceId) return;
  res.cookie('festival.device', deviceId, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 365 });
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function getBearer(req) { const h=String(req.headers.authorization||''); return h.startsWith('Bearer ')?h.slice(7).trim():''; }
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
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.uid || !data.exp || Date.now() > Number(data.exp)) return null;
    return Number(data.uid);
  } catch { return null; }
}
function getParticipantToken(req) {
  return String(req.headers['x-participant-token'] || getBearer(req) || '');
}
function requireUser(req, res, next) {
  let userId = null;

  // 参加者専用の署名トークンを最優先。Render上でもセッションCookieに依存しない。
  const signedUid = verifyParticipantToken(getParticipantToken(req));
  if (signedUid) {
    const row = db.prepare('SELECT id FROM users WHERE id=?').get(signedUid);
    if (row) userId = row.id;
  }

  // 旧バージョンのBearerトークンとの互換性。
  if (!userId) {
    const legacy = getBearer(req);
    if (legacy && !legacy.includes('.')) {
      const row = db.prepare('SELECT id FROM users WHERE auth_token_hash=?').get(hashToken(legacy));
      if (row) userId = row.id;
    }
  }

  // 最後にセッションへフォールバック。
  if (!userId && req.session && req.session.userId) {
    const row = db.prepare('SELECT id FROM users WHERE id=?').get(req.session.userId);
    if (row) userId = row.id;
    else req.session.userId = null;
  }

  if (!userId) return res.status(401).json({ error: '参加者ログインが必要です', code: 'AUTH_REQUIRED' });
  req.userId = userId;
  next();
}
function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.status(403).json({ error: 'スタッフ権限が必要です' });
  const s = db.prepare('SELECT id,username,role,active FROM staff WHERE id=?').get(req.session.staffId);
  if (!s || !s.active) return res.status(403).json({ error: 'スタッフ権限が無効です' });
  req.staff = s; next();
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

// 参加者同士のポイント譲渡の軽い連打対策（1アカウントにつき2秒に1回）
const transferCooldown = new Map();
function userTransferGuard(req, res, next) {
  const now = Date.now(), last = transferCooldown.get(req.userId) || 0;
  if (now - last < 2000) return res.status(429).json({ error: 'ポイント譲渡が早すぎます。2秒ほど待ってください' });
  transferCooldown.set(req.userId, now); next();
}

function preserveCounterpartName(userId, username) {
  db.prepare(`UPDATE point_history SET counterpart_name=COALESCE(counterpart_name, ?), counterpart_user_id=NULL WHERE counterpart_user_id=?`).run(username, userId);
}
function deleteUserHard(userId) {
  const u = db.prepare('SELECT id,username FROM users WHERE id=?').get(userId);
  if (!u) return null;
  preserveCounterpartName(u.id, u.username);
  db.prepare('DELETE FROM point_history WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  return u;
}
const eliminationTimers = new Map();
function scheduleElimination(userId) {
  if (eliminationTimers.has(userId)) return;
  const timer = setTimeout(() => {
    eliminationTimers.delete(userId);
    try {
      const u = db.prepare('SELECT id,points FROM users WHERE id=?').get(userId);
      if (u && u.points === 0) db.transaction(() => deleteUserHard(userId))();
    } catch (e) { console.error('Delayed elimination failed:', e); }
  }, 5000);
  eliminationTimers.set(userId, timer);
}
function maybeEliminate(userId) {
  const u = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(userId);
  if (u && u.points === 0) { scheduleElimination(userId); return { eliminated: true, username: u.username }; }
  return { eliminated: false };
}

app.post('/api/register', (req, res) => {
  res.status(403).json({ error: '参加者アカウントはスタッフのみ作成できます' });
});

app.post('/api/login', loginGuard('participant'), async (req, res) => {
  const loginId = cleanName(req.body.loginId || req.body.username), password = String(req.body.password || '');
  const user = /^\d{4}$/.test(loginId)
    ? db.prepare('SELECT * FROM users WHERE public_code=?').get(loginId)
    : db.prepare('SELECT * FROM users WHERE username=?').get(loginId);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) { failAttempt(req); return res.status(401).json({ error: 'IDまたはパスワードが違います' }); }
  // 参加者アカウントはスタッフのみ発行するため、端末識別Cookieは使用しない。
  // スタッフログインと同じシンプルなセッション方式に統一する。
  // 古い退場済みセッションを完全に破棄してから、新しい参加者セッションを作る。
  await regenerate(req);
  req.session.userId = user.id;
  req.session.staffId = null;
  const authToken = issueParticipantToken(user.id);
  // 旧トークンは無効化。新方式はDB保存不要。
  db.prepare('UPDATE users SET auth_token_hash=NULL WHERE id=?').run(user.id);
  await saveSession(req);
  clearAttempt(req);
  const freshUser = db.prepare('SELECT id,public_code,username,points,created_at FROM users WHERE id=?').get(user.id);
  res.json({ ok: true, user: freshUser, authToken });
});
app.post('/api/logout', requireUser, (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', requireUser, (req, res) => {
  const u = db.prepare('SELECT id,public_code,username,points,created_at FROM users WHERE id=?').get(req.userId);
  res.json(u);
});
app.get('/api/my-history', requireUser, (req, res) => {
  res.json(db.prepare(`SELECT h.id,h.delta,h.reason,h.action_type,h.created_at,COALESCE(c.username,h.counterpart_name) counterpart
    FROM point_history h LEFT JOIN users c ON c.id=h.counterpart_user_id
    WHERE h.user_id=? ORDER BY h.id DESC LIMIT 40`).all(req.userId));
});
app.get('/api/my-qr', requireUser, async (req, res) => {
  const u = db.prepare('SELECT public_code FROM users WHERE id=?').get(req.userId);
  const requestBase = `${req.protocol}://${req.get('host')}`;
  const base = (BASE_URL || requestBase).replace(/\/$/, '');
  const payload = `${base}/admin?code=${encodeURIComponent(u.public_code)}`;
  const dataUrl = await QRCode.toDataURL(payload, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
  res.json({ code: u.public_code, dataUrl, url: payload });
});
app.get('/api/ranking', (req, res) => {
  res.json(db.prepare('SELECT username,points FROM users WHERE points > 0 ORDER BY points DESC,id ASC LIMIT 100').all());
});

// 参加者 → 参加者 の自主ポイント譲渡
app.post('/api/transfer', requireUser, userTransferGuard, (req, res) => {
  const toCode = String(req.body.toCode || '').trim();
  const amount = Number(req.body.amount);
  const reason = cleanReason(req.body.reason);
  if (!/^\d{4}$/.test(toCode)) return res.status(400).json({ error: '相手のIDを4桁で入力してください' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return res.status(400).json({ error: '譲渡ポイントは1〜100,000の整数で入力してください' });
  if (reason.length < 2) return res.status(400).json({ error: '譲渡理由を2文字以上で入力してください' });
  const from = db.prepare('SELECT id,username,public_code,points FROM users WHERE id=?').get(req.userId);
  const to = db.prepare('SELECT id,username,public_code,points FROM users WHERE public_code=? AND points>0').get(toCode);
  if (!to) return res.status(404).json({ error: 'そのIDの参加者は見つかりません' });
  if (from.points <= 0) return res.status(410).json({ error: 'このアカウントは退場処理中です' });
  if (from.id === to.id) return res.status(400).json({ error: '自分自身には送れません' });
  if (from.points < amount) return res.status(400).json({ error: '所持ポイントを超える譲渡はできません' });
  const senderWillBeEliminated = from.points === amount;
  db.transaction(() => {
    db.prepare('UPDATE users SET points=points-? WHERE id=?').run(amount, from.id);
    db.prepare('UPDATE users SET points=points+? WHERE id=?').run(amount, to.id);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES(?,?,?,?,?,?)`).run(from.id,-amount,reason,'participant_transfer_out',to.id,to.username);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name) VALUES(?,?,?,?,?,?)`).run(to.id,amount,reason,'participant_transfer_in',from.id,from.username);
    if (senderWillBeEliminated) scheduleElimination(from.id);
  })();
  if (senderWillBeEliminated) {
    return res.json({ ok: true, eliminated: true, message: 'GAME OVER', deleteAfterMs: 5000 });
  }
  const updated = db.prepare('SELECT points FROM users WHERE id=?').get(from.id);
  res.json({ ok: true, eliminated: false, to: to.username, amount, points: updated.points });
});

app.post('/api/staff/login', loginGuard('staff'), async (req, res) => {
  const username = cleanName(req.body.username), password = String(req.body.password || '');
  const s = db.prepare('SELECT * FROM staff WHERE username=? AND active=1').get(username);
  if (!s || !(await bcrypt.compare(password, s.password_hash))) { failAttempt(req); return res.status(401).json({ error: 'スタッフIDまたはパスワードが違います' }); }
  await regenerate(req);
  req.session.staffId = s.id;
  await saveSession(req);
  clearAttempt(req);
  res.json({ ok: true, username: s.username, role: s.role });
});
app.post('/api/staff/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/staff/status', (req, res) => {
  if (!req.session.staffId) return res.json({ loggedIn: false });
  const s = db.prepare('SELECT id,username,role,active FROM staff WHERE id=?').get(req.session.staffId);
  res.json({ loggedIn: !!(s && s.active), staff: s && s.active ? s : null });
});
app.get('/api/staff/users', requireStaff, (req, res) => {
  const q = cleanName(req.query.q), code = String(req.query.code || '').trim(), all = String(req.query.all || '') === '1';
  let rows;
  if (code) rows = db.prepare('SELECT id,public_code,username,points,created_at FROM users WHERE public_code=? LIMIT 1').all(code);
  else if (q) rows = db.prepare('SELECT id,public_code,username,points,created_at FROM users WHERE username LIKE ? OR public_code LIKE ? ORDER BY points DESC LIMIT 100').all(`%${q}%`,`%${q}%`);
  else if (all) rows = db.prepare('SELECT id,public_code,username,points,created_at FROM users ORDER BY username COLLATE NOCASE ASC LIMIT 10000').all();
  else rows = [];
  res.json(rows);
});

app.post('/api/staff/participants', requireStaff, async (req, res) => {
  const username = cleanName(req.body.username), password = String(req.body.password || '');
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '参加者名は2〜20文字で入力してください' });
  if (!/^[^<>]{2,20}$/.test(username)) return res.status(400).json({ error: '参加者名に使用できない文字が含まれています' });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: '参加者パスワードは6〜72文字で入力してください' });
  try {
    const hash = await bcrypt.hash(password, 12), code = makeCode();
    const info = db.prepare('INSERT INTO users (public_code,username,password_hash,points,device_id) VALUES (?,?,?,?,NULL)').run(code, username, hash, STARTING_POINTS);
    res.json({ ok: true, id: Number(info.lastInsertRowid), username, code, startingPoints: STARTING_POINTS });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'その参加者名は現在使用中です' });
    console.error(e); return res.status(500).json({ error: '参加者アカウント作成に失敗しました' });
  }
});

app.post('/api/staff/users/:id/points', requireStaff, (req, res) => {
  const id = Number(req.params.id), delta = Number(req.body.delta), reason = cleanReason(req.body.reason);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return res.status(400).json({ error: '1〜100,000の整数で入力してください' });
  const u = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '参加者が見つかりません' });
  if (u.points + delta < 0) return res.status(400).json({ error: 'ポイントは0未満にできません' });
  const becomesZero = u.points + delta === 0;
  db.transaction(() => {
    db.prepare('UPDATE users SET points=points+? WHERE id=?').run(delta,id);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,staff_id) VALUES(?,?,?,?,?)`).run(id,delta,reason||null,'adjust',req.staff.id);
    if (becomesZero) scheduleElimination(id);
  })();
  if (becomesZero) return res.json({ id,username:u.username,points:0,eliminated:true });
  res.json({ ...db.prepare('SELECT id,username,points FROM users WHERE id=?').get(id), eliminated:false });
});

app.post('/api/staff/transfer', requireStaff, (req, res) => {
  const fromId = Number(req.body.fromId), toId = Number(req.body.toId), amount = Number(req.body.amount), reason = cleanReason(req.body.reason);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return res.status(400).json({ error: '移動ポイントは1〜100,000の整数で入力してください' });
  if (fromId === toId) return res.status(400).json({ error: '同じ参加者には移動できません' });
  const from = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(fromId), to = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(toId);
  if (!from || !to) return res.status(404).json({ error: '参加者が見つかりません' });
  if (from.points < amount) return res.status(400).json({ error: `${from.username}のポイントが不足しています` });
  const eliminateFrom = from.points === amount;
  db.transaction(() => {
    db.prepare('UPDATE users SET points=points-? WHERE id=?').run(amount, fromId);
    db.prepare('UPDATE users SET points=points+? WHERE id=?').run(amount, toId);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name,staff_id) VALUES(?,?,?,?,?,?,?)`).run(fromId,-amount,reason||null,'transfer_out',toId,to.username,req.staff.id);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,counterpart_name,staff_id) VALUES(?,?,?,?,?,?,?)`).run(toId,amount,reason||null,'transfer_in',fromId,from.username,req.staff.id);
    if (eliminateFrom) scheduleElimination(fromId);
  })();
  res.json({ ok:true, eliminated:eliminateFrom, from:{ id:from.id,username:from.username,points:Math.max(0,from.points-amount) }, to:db.prepare('SELECT id,username,points FROM users WHERE id=?').get(toId) });
});

app.delete('/api/staff/users/:id', requireAdmin, (req,res) => {
  const id = Number(req.params.id), u = db.prepare('SELECT id,username FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error:'参加者が見つかりません' });
  db.transaction(() => deleteUserHard(id))();
  res.json({ ok:true, username:u.username });
});

app.get('/api/staff/history', requireStaff, (req, res) => {
  res.json(db.prepare(`SELECT h.id,u.username,h.delta,h.reason,h.action_type,COALESCE(c.username,h.counterpart_name) counterpart,s.username staff_name,h.created_at
    FROM point_history h JOIN users u ON u.id=h.user_id
    LEFT JOIN users c ON c.id=h.counterpart_user_id LEFT JOIN staff s ON s.id=h.staff_id
    ORDER BY h.id DESC LIMIT 150`).all());
});

app.get('/api/staff/accounts', requireAdmin, (req,res) => res.json(db.prepare('SELECT id,username,role,active,created_at FROM staff ORDER BY id').all()));
app.post('/api/staff/accounts', requireAdmin, async (req,res) => {
  const username=cleanName(req.body.username), password=String(req.body.password||''), role=req.body.role==='admin'?'admin':'staff';
  if(username.length<2||username.length>30) return res.status(400).json({error:'スタッフIDは2〜30文字で入力してください'});
  if(password.length<8||password.length>72) return res.status(400).json({error:'スタッフパスワードは8〜72文字で入力してください'});
  try { const hash=await bcrypt.hash(password,12); const info=db.prepare('INSERT INTO staff(username,password_hash,role) VALUES(?,?,?)').run(username,hash,role); res.json({ok:true,id:Number(info.lastInsertRowid)}); }
  catch(e){ if(String(e.message).includes('UNIQUE')) return res.status(409).json({error:'そのスタッフIDは使用済みです'}); console.error(e); return res.status(500).json({error:'スタッフ追加に失敗しました'}); }
});
app.post('/api/staff/accounts/:id/toggle', requireAdmin, (req,res) => {
  const id=Number(req.params.id); if(id===req.staff.id) return res.status(400).json({error:'自分自身は無効化できません'});
  const s=db.prepare('SELECT id,active FROM staff WHERE id=?').get(id); if(!s) return res.status(404).json({error:'スタッフが見つかりません'});
  db.prepare('UPDATE staff SET active=? WHERE id=?').run(s.active?0:1,id); res.json({ok:true});
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NEXUS POINT ARENA: http://localhost:${PORT}`);
  console.log(`Starting points: ${STARTING_POINTS}`);
  if (SESSION_SECRET.startsWith('replace-this')) console.log('WARNING: SESSION_SECRETを本番用に変更してください。');
  if (ADMIN_PASSWORD === 'change-me-now') console.log('WARNING: 初期管理者パスワードを変更してください。');
});
