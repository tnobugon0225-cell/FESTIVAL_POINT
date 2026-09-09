const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace-this-secret-before-public-use';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const BASE_URL = process.env.BASE_URL || ''; // 空ならアクセス元のURLを自動利用

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
  points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
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
  staff_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (counterpart_user_id) REFERENCES users(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS idx_users_code ON users(public_code);
CREATE INDEX IF NOT EXISTS idx_history_user ON point_history(user_id, id DESC);
`);

// Migrate older starter DBs if present.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'public_code', 'public_code TEXT');
ensureColumn('point_history', 'action_type', "action_type TEXT NOT NULL DEFAULT 'adjust'");
ensureColumn('point_history', 'counterpart_user_id', 'counterpart_user_id INTEGER');
ensureColumn('point_history', 'staff_id', 'staff_id INTEGER');
for (const u of db.prepare('SELECT id FROM users WHERE public_code IS NULL OR public_code = ?').all('')) {
  db.prepare('UPDATE users SET public_code = ? WHERE id = ?').run(makeCode(), u.id);
}

if (!db.prepare('SELECT id FROM staff LIMIT 1').get()) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare('INSERT INTO staff (username, password_hash, role) VALUES (?, ?, ?)').run(ADMIN_USERNAME, hash, 'admin');
  console.log(`Created initial admin account: ${ADMIN_USERNAME}`);
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'festival.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

function makeCode() { return crypto.randomBytes(6).toString('hex').toUpperCase(); }
function cleanName(v) { return String(v || '').trim().replace(/\s+/g, ' '); }
function requireUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '参加者ログインが必要です' });
  next();
}
function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.status(403).json({ error: 'スタッフ権限が必要です' });
  const s = db.prepare('SELECT id, username, role, active FROM staff WHERE id = ?').get(req.session.staffId);
  if (!s || !s.active) return res.status(403).json({ error: 'スタッフ権限が無効です' });
  req.staff = s; next();
}
function requireAdmin(req, res, next) {
  requireStaff(req, res, () => req.staff.role === 'admin' ? next() : res.status(403).json({ error: '管理者権限が必要です' }));
}
function regenerate(req) { return new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve())); }

// Lightweight login throttling for festival use.
const attempts = new Map();
function loginGuard(scope) {
  return (req, res, next) => {
    const key = `${scope}:${req.ip}`; const now = Date.now();
    const item = attempts.get(key) || { count: 0, reset: now + 10 * 60 * 1000 };
    if (now > item.reset) { item.count = 0; item.reset = now + 10 * 60 * 1000; }
    if (item.count >= 20) return res.status(429).json({ error: 'ログイン試行が多すぎます。少し時間を置いてください' });
    req.rateKey = key; req.rateItem = item; next();
  };
}
function failAttempt(req) { req.rateItem.count++; attempts.set(req.rateKey, req.rateItem); }
function clearAttempt(req) { attempts.delete(req.rateKey); }

app.post('/api/register', loginGuard('participant'), async (req, res) => {
  const username = cleanName(req.body.username);
  const password = String(req.body.password || '');
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'ニックネームは2〜20文字で入力してください' });
  if (!/^[^<>]{2,20}$/.test(username)) return res.status(400).json({ error: 'ニックネームに使用できない文字が含まれています' });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'パスワードは6〜72文字で入力してください' });
  try {
    const hash = await bcrypt.hash(password, 12);
    let code; do { code = makeCode(); } while (db.prepare('SELECT 1 FROM users WHERE public_code = ?').get(code));
    const info = db.prepare('INSERT INTO users (public_code, username, password_hash) VALUES (?, ?, ?)').run(code, username, hash);
    await regenerate(req); req.session.userId = Number(info.lastInsertRowid); clearAttempt(req);
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'そのニックネームはすでに使われています' });
    console.error(e); res.status(500).json({ error: '登録に失敗しました' });
  }
});

app.post('/api/login', loginGuard('participant'), async (req, res) => {
  const username = cleanName(req.body.username); const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) { failAttempt(req); return res.status(401).json({ error: 'ニックネームまたはパスワードが違います' }); }
  await regenerate(req); req.session.userId = user.id; clearAttempt(req); res.json({ ok: true });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', requireUser, (req, res) => {
  const u = db.prepare('SELECT id, public_code, username, points, created_at FROM users WHERE id = ?').get(req.session.userId);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' }); res.json(u);
});
app.get('/api/my-history', requireUser, (req, res) => {
  res.json(db.prepare(`SELECT h.delta,h.reason,h.action_type,h.created_at,c.username counterpart
    FROM point_history h LEFT JOIN users c ON c.id=h.counterpart_user_id
    WHERE h.user_id=? ORDER BY h.id DESC LIMIT 30`).all(req.session.userId));
});
app.get('/api/my-qr', requireUser, async (req, res) => {
  const u = db.prepare('SELECT public_code FROM users WHERE id=?').get(req.session.userId);
  // BASE_URL が設定されていればそれを優先。未設定なら、QRを開いた端末が実際に使っているURLを利用します。
  // 例: http://192.168.1.23:3000 または https://example.com
  const requestBase = `${req.protocol}://${req.get('host')}`;
  const base = (BASE_URL || requestBase).replace(/\/$/, '');
  const payload = `${base}/admin?code=${encodeURIComponent(u.public_code)}`;
  const dataUrl = await QRCode.toDataURL(payload, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
  res.json({ code: u.public_code, dataUrl, url: payload });
});
app.get('/api/ranking', (req, res) => {
  res.json(db.prepare('SELECT username, points FROM users ORDER BY points DESC, id ASC LIMIT 100').all());
});

app.post('/api/staff/login', loginGuard('staff'), async (req, res) => {
  const username = cleanName(req.body.username); const password = String(req.body.password || '');
  const s = db.prepare('SELECT * FROM staff WHERE username=? AND active=1').get(username);
  if (!s || !(await bcrypt.compare(password, s.password_hash))) { failAttempt(req); return res.status(401).json({ error: 'スタッフIDまたはパスワードが違います' }); }
  await regenerate(req); req.session.staffId = s.id; clearAttempt(req); res.json({ ok: true, username: s.username, role: s.role });
});
app.post('/api/staff/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/staff/status', (req, res) => {
  if (!req.session.staffId) return res.json({ loggedIn: false });
  const s = db.prepare('SELECT id,username,role,active FROM staff WHERE id=?').get(req.session.staffId);
  res.json({ loggedIn: !!(s && s.active), staff: s && s.active ? s : null });
});
app.get('/api/staff/users', requireStaff, (req, res) => {
  const q = cleanName(req.query.q); const code = String(req.query.code || '').trim().toUpperCase();
  let rows;
  if (code) rows = db.prepare('SELECT id,public_code,username,points,created_at FROM users WHERE public_code=? LIMIT 1').all(code);
  else if (q) rows = db.prepare('SELECT id,public_code,username,points,created_at FROM users WHERE username LIKE ? ORDER BY points DESC LIMIT 100').all(`%${q}%`);
  else rows = db.prepare('SELECT id,public_code,username,points,created_at FROM users ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
});

app.post('/api/staff/users/:id/points', requireStaff, (req, res) => {
  const id = Number(req.params.id), delta = Number(req.body.delta), reason = cleanName(req.body.reason).slice(0, 100);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return res.status(400).json({ error: '1〜100,000の整数で入力してください' });
  const u = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '参加者が見つかりません' });
  if (u.points + delta < 0) return res.status(400).json({ error: 'ポイントは0未満にできません' });
  db.transaction(() => {
    db.prepare('UPDATE users SET points=points+? WHERE id=?').run(delta,id);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,staff_id) VALUES(?,?,?,?,?)`).run(id,delta,reason||null,'adjust',req.staff.id);
  })();
  res.json(db.prepare('SELECT id,username,points FROM users WHERE id=?').get(id));
});

app.post('/api/staff/transfer', requireStaff, (req, res) => {
  const fromId = Number(req.body.fromId), toId = Number(req.body.toId), amount = Number(req.body.amount);
  const reason = cleanName(req.body.reason).slice(0,100);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return res.status(400).json({ error: '移動ポイントは1〜100,000の整数で入力してください' });
  if (fromId === toId) return res.status(400).json({ error: '同じ参加者には移動できません' });
  const from = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(fromId);
  const to = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(toId);
  if (!from || !to) return res.status(404).json({ error: '参加者が見つかりません' });
  if (from.points < amount) return res.status(400).json({ error: `${from.username}のポイントが不足しています` });
  db.transaction(() => {
    db.prepare('UPDATE users SET points=points-? WHERE id=?').run(amount, fromId);
    db.prepare('UPDATE users SET points=points+? WHERE id=?').run(amount, toId);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,staff_id) VALUES(?,?,?,?,?,?)`).run(fromId,-amount,reason||null,'transfer_out',toId,req.staff.id);
    db.prepare(`INSERT INTO point_history(user_id,delta,reason,action_type,counterpart_user_id,staff_id) VALUES(?,?,?,?,?,?)`).run(toId,amount,reason||null,'transfer_in',fromId,req.staff.id);
  })();
  res.json({ ok:true, from: db.prepare('SELECT id,username,points FROM users WHERE id=?').get(fromId), to: db.prepare('SELECT id,username,points FROM users WHERE id=?').get(toId) });
});

app.get('/api/staff/history', requireStaff, (req, res) => {
  res.json(db.prepare(`SELECT h.id,u.username,h.delta,h.reason,h.action_type,c.username counterpart,s.username staff_name,h.created_at
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
  catch(e){ if(String(e.message).includes('UNIQUE')) return res.status(409).json({error:'そのスタッフIDは使用済みです'}); throw e; }
});
app.post('/api/staff/accounts/:id/toggle', requireAdmin, (req,res) => {
  const id=Number(req.params.id); if(id===req.staff.id) return res.status(400).json({error:'自分自身は無効化できません'});
  const s=db.prepare('SELECT id,active FROM staff WHERE id=?').get(id); if(!s) return res.status(404).json({error:'スタッフが見つかりません'});
  db.prepare('UPDATE staff SET active=? WHERE id=?').run(s.active?0:1,id); res.json({ok:true});
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`Festival Points: ${BASE_URL}`);
  if (SESSION_SECRET.startsWith('replace-this')) console.log('WARNING: SESSION_SECRETを本番用に変更してください。');
  if (ADMIN_PASSWORD === 'change-me-now') console.log('WARNING: 初期管理者パスワードを変更してください。');
});
