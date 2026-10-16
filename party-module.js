'use strict';
// Party feature: all changes use PostgreSQL transactions; never trust a client-supplied user id.
const express = require('express');
const router = express.Router();
const err = (status,message) => Object.assign(new Error(message),{status});
const num = v => Number.isSafeInteger(Number(v)) && Number(v)>0 ? Number(v) : 0;
async function init(pool){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS parties(id BIGSERIAL PRIMARY KEY,name VARCHAR(30) NOT NULL,leader_id BIGINT REFERENCES users(id) ON DELETE SET NULL,points INTEGER NOT NULL DEFAULT 0,wins INTEGER NOT NULL DEFAULT 0,draws INTEGER NOT NULL DEFAULT 0,losses INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS party_members(party_id BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(party_id,user_id),UNIQUE(user_id));
 CREATE TABLE IF NOT EXISTS party_applications(id BIGSERIAL PRIMARY KEY,name VARCHAR(30) NOT NULL,applicant_id BIGINT REFERENCES users(id) ON DELETE CASCADE,member_ids BIGINT[] NOT NULL,status VARCHAR(12) NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),reviewed_at TIMESTAMPTZ);
 CREATE TABLE IF NOT EXISTS party_application_votes(application_id BIGINT NOT NULL REFERENCES party_applications(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,status VARCHAR(12) NOT NULL DEFAULT 'pending',responded_at TIMESTAMPTZ,PRIMARY KEY(application_id,user_id));
 CREATE TABLE IF NOT EXISTS party_invites(id BIGSERIAL PRIMARY KEY,party_id BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,status VARCHAR(12) NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(party_id,user_id));
 CREATE TABLE IF NOT EXISTS party_chat(id BIGSERIAL PRIMARY KEY,party_id BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,sender_id BIGINT REFERENCES users(id) ON DELETE SET NULL,sender_name VARCHAR(20) NOT NULL,message VARCHAR(120) NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS party_point_adjustments(id BIGSERIAL PRIMARY KEY,party_id BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,delta INTEGER NOT NULL,reason VARCHAR(80) NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS party_contributions(id BIGSERIAL PRIMARY KEY,party_id BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,player_name VARCHAR(20) NOT NULL,source VARCHAR(10) NOT NULL,match_id BIGINT NOT NULL,result VARCHAR(4) NOT NULL,points INTEGER NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(source,match_id,party_id));
 UPDATE party_applications SET status='rejected',reviewed_at=NOW() WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM party_application_votes v WHERE v.application_id=party_applications.id);
 INSERT INTO app_settings(setting_key,setting_value) VALUES('party_roster_locked','off') ON CONFLICT DO NOTHING;
 CREATE OR REPLACE FUNCTION clear_party_rank_title_on_leave() RETURNS TRIGGER AS $$
 BEGIN
   UPDATE users SET selected_title_key='rookie' WHERE id=OLD.user_id AND LEFT(selected_title_key,6)='party_';
   RETURN OLD;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS party_title_membership_exit ON party_members;
 CREATE TRIGGER party_title_membership_exit AFTER DELETE ON party_members FOR EACH ROW EXECUTE FUNCTION clear_party_rank_title_on_leave();
 CREATE OR REPLACE FUNCTION clear_party_rank_title_on_points_change() RETURNS TRIGGER AS $$
 DECLARE rank_letter TEXT;
 BEGIN
   rank_letter:=CASE WHEN NEW.points>=150 THEN 's' WHEN NEW.points>=100 THEN 'a' WHEN NEW.points>=60 THEN 'b' WHEN NEW.points>=30 THEN 'c' WHEN NEW.points>=10 THEN 'd' ELSE 'e' END;
   UPDATE users u SET selected_title_key='rookie' FROM party_members pm
     WHERE pm.user_id=u.id AND pm.party_id=NEW.id AND LEFT(u.selected_title_key,6)='party_'
       AND u.selected_title_key<>'party_'||rank_letter;
   RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS party_title_points_change ON parties;
 CREATE TRIGGER party_title_points_change AFTER UPDATE OF points ON parties FOR EACH ROW WHEN (OLD.points IS DISTINCT FROM NEW.points) EXECUTE FUNCTION clear_party_rank_title_on_points_change();

 `);
}
async function locked(c){return (await c.query("SELECT setting_value FROM app_settings WHERE setting_key='party_roster_locked'")).rows[0]?.setting_value==='on';}
async function member(c,id){return (await c.query('SELECT p.*,pm.joined_at FROM parties p JOIN party_members pm ON pm.party_id=p.id WHERE pm.user_id=$1',[id])).rows[0]||null;}
async function transact(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
// Match credit is committed atomically with the game's winner; no extra client requests.
async function credit(c,source,matchId,player1,player2,winner){
 const a=num(player1),b=num(player2);if(!a||!b||a===b)return;
 const ps=await c.query(`SELECT pm.user_id,pm.party_id,u.username FROM party_members pm JOIN users u ON u.id=pm.user_id WHERE pm.user_id=ANY($1::bigint[])`,[[a,b]]);
 if(ps.rows.length!==2||String(ps.rows[0].party_id)===String(ps.rows[1].party_id))return;
 for(const x of ps.rows){const win=num(winner)===Number(x.user_id),draw=!num(winner),result=draw?'draw':win?'win':'loss',pts=draw?1:win?2:0;
 const inserted=await c.query('INSERT INTO party_contributions(party_id,user_id,player_name,source,match_id,result,points) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',[x.party_id,x.user_id,x.username,source,matchId,result,pts]);
 if(inserted.rowCount)await c.query(`UPDATE parties SET points=points+$2,wins=wins+$3,draws=draws+$4,losses=losses+$5 WHERE id=$1`,[x.party_id,pts,win?1:0,draw?1:0,!win&&!draw?1:0]);
 }
}
async function beforeDelete(c,userId){
 // A disappearing participant invalidates any unfinished formation involving them.
 await c.query("UPDATE party_applications SET status='rejected',reviewed_at=NOW() WHERE status IN ('collecting','pending') AND $1=ANY(member_ids)",[userId]);
 const p=await member(c,userId);if(!p)return;
 // Preserve the contribution snapshot but remove the membership via FK cascade.
 if(Number(p.leader_id)===Number(userId)){
 const next=(await c.query('SELECT user_id FROM party_members WHERE party_id=$1 AND user_id<>$2 ORDER BY joined_at,user_id LIMIT 1',[p.id,userId])).rows[0];
 await c.query('UPDATE parties SET leader_id=$1 WHERE id=$2',[next?.user_id||null,p.id]);
 }
}
function install(app,pool,requireUser,requireStaff){
 router.use((req,res,next)=>{if(req.method!=='POST'||req.path.startsWith('/staff/'))return next();requireUser(req,res,async()=>{try{const r=await pool.query('SELECT is_official FROM users WHERE id=$1',[req.userId]);if(r.rows[0]?.is_official)return res.status(403).json({error:'運営アカウントはパーティーに参加できません'});next()}catch(e){next(e)}})});
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(e=>res.status(e.status||500).json({error:e.status?e.message:'処理に失敗しました'}));
 const me=async id=>member(pool,id);
 const assertLeader=(p,id)=>{if(!p||Number(p.leader_id)!==Number(id))throw err(403,'リーダーのみ操作できます');};
 const assertUnlocked=async c=>{if(await locked(c))throw err(409,'大会期間中はメンバーを変更できません');};
 router.get('/mine',requireUser,wrap(async(req,res)=>{
 const p=await me(req.userId);
 const apps=await pool.query(`SELECT a.id,a.name,a.status,a.created_at,
 (SELECT COUNT(*)::int FROM party_application_votes v WHERE v.application_id=a.id AND v.status='accepted') accepted_count,
 (SELECT COUNT(*)::int FROM party_application_votes v WHERE v.application_id=a.id) invite_count,
 (SELECT json_agg(json_build_object('name',u.username,'code',u.public_code,'status',v.status) ORDER BY u.id) FROM party_application_votes v JOIN users u ON u.id=v.user_id WHERE v.application_id=a.id) invite_statuses
 FROM party_applications a WHERE a.applicant_id=$1 ORDER BY a.id DESC LIMIT 5`,[req.userId]);
 const formationInvites=await pool.query(`SELECT a.id,a.name,u.username applicant_name FROM party_application_votes v JOIN party_applications a ON a.id=v.application_id JOIN users u ON u.id=a.applicant_id WHERE v.user_id=$1 AND v.status='pending' AND a.status='collecting' ORDER BY a.id DESC`,[req.userId]);
 const invites=await pool.query(`SELECT i.id,p.name FROM party_invites i JOIN parties p ON p.id=i.party_id WHERE i.user_id=$1 AND i.status='pending' ORDER BY i.id DESC`,[req.userId]);
 let members=[];if(p){members=(await pool.query('SELECT u.id,u.public_code,u.username,pm.joined_at FROM party_members pm JOIN users u ON u.id=pm.user_id WHERE pm.party_id=$1 ORDER BY pm.joined_at,u.id',[p.id])).rows;}
 res.json({party:p,members,applications:apps.rows,formationInvites:formationInvites.rows,invites:invites.rows,locked:await locked(pool)});
 }));
 router.get('/ranking',wrap(async(req,res)=>{const r=await pool.query('SELECT id,name,points,wins,draws,losses FROM parties ORDER BY points DESC,wins DESC,id LIMIT 100');res.json(r.rows);}));
 // Shared public statistics. Contributions are snapshots: deletion of a player does not erase them.
 async function partyStats(partyId){
  const rows=(await pool.query(`SELECT pc.user_id,pc.player_name,pc.result,pc.points,
    CASE WHEN pc.source='custom' THEN 'custom'
         WHEN qm.game_type IN ('janken','chinchiro','hitblow') THEN qm.game_type
         ELSE 'other' END AS game
    FROM party_contributions pc
    LEFT JOIN quick_matches qm ON pc.source='quick' AND qm.id=pc.match_id
    WHERE pc.party_id=$1 ORDER BY pc.id`,[partyId])).rows;
  const games=['janken','chinchiro','hitblow','custom','other'];
  const empty=()=>({wins:0,draws:0,losses:0,points:0});
  const byGame=Object.fromEntries(games.map(g=>[g,empty()]));
  const byPlayer=new Map();
  for(const r of rows){
   const game=games.includes(r.game)?r.game:'other';
   const key=r.user_id==null?'deleted:'+r.player_name:'user:'+r.user_id;
   if(!byPlayer.has(key))byPlayer.set(key,{userId:r.user_id==null?null:String(r.user_id),name:r.player_name,...empty(),byGame:Object.fromEntries(games.map(g=>[g,empty()]))});
   const player=byPlayer.get(key),field=r.result==='win'?'wins':r.result==='draw'?'draws':'losses';
   for(const dest of [byGame[game],player,player.byGame[game]]){dest[field]++;dest.points+=Number(r.points)||0;}
  }
  return {byGame,players:[...byPlayer.values()]};
 }
 router.get('/stats/:id',wrap(async(req,res)=>{
  const id=num(req.params.id);
  if(!(await pool.query('SELECT 1 FROM parties WHERE id=$1',[id])).rowCount)throw err(404,'パーティーが見つかりません');
  res.json(await partyStats(id));
 }));
 router.get('/detail/:id',wrap(async(req,res)=>{
  const id=num(req.params.id);
  const p=(await pool.query('SELECT id,name,points,wins,draws,losses,created_at FROM parties WHERE id=$1',[id])).rows[0];
  if(!p)throw err(404,'パーティーが見つかりません');
  const members=(await pool.query('SELECT u.id,u.username FROM party_members pm JOIN users u ON u.id=pm.user_id WHERE pm.party_id=$1 ORDER BY pm.joined_at',[id])).rows;
  const stats=await partyStats(id);
  res.json({party:p,members,stats,contributions:stats.players});
 }));
 router.get('/affiliations',requireUser,wrap(async(req,res)=>{
 const ids=String(req.query.ids||'').split(',').map(num).filter(Boolean).slice(0,5);
 if(!ids.length)return res.json({});
 const r=await pool.query('SELECT pm.user_id,p.name FROM party_members pm JOIN parties p ON p.id=pm.party_id WHERE pm.user_id=ANY($1::bigint[])',[ids]);
 res.json(Object.fromEntries(r.rows.map(x=>[String(x.user_id),x.name])));
 }));
 router.post('/apply',requireUser,wrap(async(req,res)=>{
 const name=String(req.body.name||'').trim(),codes=req.body.codes;
 if(name.length<2||name.length>30||!Array.isArray(codes)||codes.length!==3||codes.some(x=>!/^\d{4}$/.test(String(x)))||new Set(codes.map(String)).size!==3)throw err(400,'パーティー名（2〜30文字）と異なる3人の4桁IDを入力してください');
 await transact(pool,async c=>{
 await c.query('SELECT pg_advisory_xact_lock(8742301)');await assertUnlocked(c);
 if(await member(c,req.userId))throw err(409,'すでに所属しています');
 const users=(await c.query('SELECT id,public_code FROM users WHERE public_code=ANY($1::text[])',[codes.map(String)])).rows;
 if(users.length!==3||!users.some(u=>Number(u.id)===req.userId))throw err(400,'申請者自身を含む実在の3人を指定してください');
 const ids=users.map(x=>Number(x.id));
 if((await c.query('SELECT 1 FROM party_members WHERE user_id=ANY($1::bigint[]) LIMIT 1',[ids])).rowCount)throw err(409,'すでに所属しているプレイヤーがいます');
 const active=(await c.query("SELECT 1 FROM party_applications WHERE status IN ('collecting','pending') AND member_ids && $1::bigint[] LIMIT 1",[ids])).rowCount;
 if(active)throw err(409,'指定したメンバーの中に、別の結成申請の回答・審査待ちの人がいます');
 const app=(await c.query("INSERT INTO party_applications(name,applicant_id,member_ids,status) VALUES($1,$2,$3,'collecting') RETURNING id",[name,req.userId,ids])).rows[0];
 for(const id of ids.filter(id=>id!==Number(req.userId)))await c.query('INSERT INTO party_application_votes(application_id,user_id) VALUES($1,$2)',[app.id,id]);
 });res.json({ok:true});
 }));
 router.post('/applications/:id/respond',requireUser,wrap(async(req,res)=>{
 const decision=String(req.body.decision||'');if(!['accept','reject'].includes(decision))throw err(400,'操作が不正です');
 await transact(pool,async c=>{
 await c.query('SELECT pg_advisory_xact_lock(8742301)');await assertUnlocked(c);
 const a=(await c.query("SELECT * FROM party_applications WHERE id=$1 AND status='collecting' FOR UPDATE",[num(req.params.id)])).rows[0];
 if(!a)throw err(404,'結成招待はすでに終了しています');
 const v=(await c.query("SELECT * FROM party_application_votes WHERE application_id=$1 AND user_id=$2 AND status='pending' FOR UPDATE",[a.id,req.userId])).rows[0];
 if(!v)throw err(403,'回答できる招待がありません');
 if(decision==='accept'){
 if(await member(c,req.userId))throw err(409,'すでに別パーティーに所属しています');
 }
 await c.query('UPDATE party_application_votes SET status=$1,responded_at=NOW() WHERE application_id=$2 AND user_id=$3',[decision==='accept'?'accepted':'rejected',a.id,req.userId]);
 if(decision==='reject')await c.query("UPDATE party_applications SET status='rejected',reviewed_at=NOW() WHERE id=$1",[a.id]);
 else if(!(await c.query("SELECT 1 FROM party_application_votes WHERE application_id=$1 AND status<>'accepted' LIMIT 1",[a.id])).rowCount){
 await c.query("UPDATE party_applications SET status='pending' WHERE id=$1",[a.id]);
 }
 });res.json({ok:true});
 }));
 router.post('/applications/:id/cancel',requireUser,wrap(async(req,res)=>{
 await transact(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8742301)');
 const r=await c.query("UPDATE party_applications SET status='cancelled',reviewed_at=NOW() WHERE id=$1 AND applicant_id=$2 AND status IN ('collecting','pending') RETURNING id",[num(req.params.id),req.userId]);
 if(!r.rowCount)throw err(409,'この申請は取り消せません');});res.json({ok:true});
 }));
 router.post('/invite',requireUser,wrap(async(req,res)=>{const code=String(req.body.code||'');if(!/^\d{4}$/.test(code))throw err(400,'4桁のIDを入力してください');await transact(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8742301)');await assertUnlocked(c);const p=await member(c,req.userId);assertLeader(p,req.userId);const count=(await c.query('SELECT COUNT(*)::int n FROM party_members WHERE party_id=$1',[p.id])).rows[0].n;if(count>=3)throw err(409,'3人までです');const target=(await c.query('SELECT id,is_official FROM users WHERE public_code=$1',[code])).rows[0];if(target?.is_official)throw err(403,'運営アカウントは招待できません');if(!target)throw err(404,'プレイヤーが見つかりません');if(await member(c,target.id))throw err(409,'すでに所属しています');await c.query("INSERT INTO party_invites(party_id,user_id,status) VALUES($1,$2,'pending') ON CONFLICT(party_id,user_id) DO UPDATE SET status='pending',created_at=NOW()",[p.id,target.id]);});res.json({ok:true});}));
 router.post('/invites/:id/:decision',requireUser,wrap(async(req,res)=>{const decision=req.params.decision;if(!['accept','reject'].includes(decision))throw err(400,'操作が不正です');await transact(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8742301)');await assertUnlocked(c);const i=(await c.query("SELECT * FROM party_invites WHERE id=$1 AND user_id=$2 AND status='pending' FOR UPDATE",[num(req.params.id),req.userId])).rows[0];if(!i)throw err(404,'招待が見つかりません');if(decision==='accept'){if(await member(c,req.userId))throw err(409,'すでに所属しています');const count=(await c.query('SELECT COUNT(*)::int n FROM party_members WHERE party_id=$1',[i.party_id])).rows[0].n;if(count>=3)throw err(409,'満員です');await c.query('INSERT INTO party_members(party_id,user_id) VALUES($1,$2)',[i.party_id,req.userId]);}await c.query('UPDATE party_invites SET status=$1 WHERE id=$2',[decision==='accept'?'accepted':'rejected',i.id]);});res.json({ok:true});}));
 router.post('/remove',requireUser,wrap(async(req,res)=>{await transact(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8742301)');await assertUnlocked(c);const p=await member(c,req.userId);assertLeader(p,req.userId);const target=num(req.body.userId);if(target===req.userId)throw err(400,'先にリーダーを譲渡してください');const r=await c.query('DELETE FROM party_members WHERE party_id=$1 AND user_id=$2 RETURNING user_id',[p.id,target]);if(!r.rowCount)throw err(404,'所属メンバーではありません');});res.json({ok:true});}));
 router.post('/transfer',requireUser,wrap(async(req,res)=>{await transact(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8742301)');const p=await member(c,req.userId);assertLeader(p,req.userId);const target=num(req.body.userId);if(target===req.userId||!(await c.query('SELECT 1 FROM party_members WHERE party_id=$1 AND user_id=$2',[p.id,target])).rowCount)throw err(400,'譲渡先を選択してください');await c.query('UPDATE parties SET leader_id=$1 WHERE id=$2',[target,p.id]);});res.json({ok:true});}));
 router.post('/disband',requireUser,wrap(async(req,res)=>{await transact(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8742301)');await assertUnlocked(c);const p=await member(c,req.userId);assertLeader(p,req.userId);await c.query('DELETE FROM parties WHERE id=$1',[p.id]);});res.json({ok:true});}));
 router.get('/chat',requireUser,wrap(async(req,res)=>{const p=await me(req.userId);if(!p)throw err(403,'所属していません');const r=await pool.query('SELECT id,sender_name,message,created_at FROM party_chat WHERE party_id=$1 ORDER BY id DESC LIMIT 60',[p.id]);res.json(r.rows.reverse());}));
 router.post('/chat',requireUser,wrap(async(req,res)=>{const message=String(req.body.message||'').trim();if(!message||Array.from(message).length>120)throw err(400,'メッセージは1〜120文字です');await transact(pool,async c=>{const p=await member(c,req.userId);if(!p)throw err(403,'所属していません');const last=(await c.query('SELECT created_at FROM party_chat WHERE sender_id=$1 ORDER BY id DESC LIMIT 1',[req.userId])).rows[0];if(last&&Date.now()-new Date(last.created_at).getTime()<3000)throw err(429,'3秒あけて送信してください');const u=(await c.query('SELECT username FROM users WHERE id=$1',[req.userId])).rows[0];await c.query('INSERT INTO party_chat(party_id,sender_id,sender_name,message) VALUES($1,$2,$3,$4)',[p.id,req.userId,u.username,message]);});res.json({ok:true});}));
 router.get('/staff/parties',requireStaff,wrap(async(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,60);
  if(!q)return res.json([]);
  const rows=await pool.query(`SELECT p.id,p.name,p.points,p.wins,p.draws,p.losses,
   COALESCE(json_agg(json_build_object('name',u.username,'code',u.public_code,'leader',u.id=p.leader_id) ORDER BY pm.joined_at) FILTER (WHERE u.id IS NOT NULL),'[]'::json) members
   FROM parties p LEFT JOIN party_members pm ON pm.party_id=p.id LEFT JOIN users u ON u.id=pm.user_id
   WHERE ($1='' OR p.name ILIKE '%'||$1||'%' OR EXISTS (SELECT 1 FROM party_members pm2 JOIN users u2 ON u2.id=pm2.user_id WHERE pm2.party_id=p.id AND (u2.username ILIKE '%'||$1||'%' OR u2.public_code=$1)))
   GROUP BY p.id ORDER BY p.points DESC,p.id LIMIT 100`,[q]);
  res.json(rows.rows);
 }));
 router.get('/staff/parties/:id/history',requireStaff,wrap(async(req,res)=>{
  const r=await pool.query('SELECT delta,reason,created_at FROM party_point_adjustments WHERE party_id=$1 ORDER BY id DESC LIMIT 30',[num(req.params.id)]);res.json(r.rows);
 }));
 router.post('/staff/parties/:id/points',requireStaff,wrap(async(req,res)=>{
  const id=num(req.params.id),delta=Number(req.body.delta),reason=String(req.body.reason||'').trim();
  if(!id||!Number.isSafeInteger(delta)||delta===0||Math.abs(delta)>1000000||!reason||reason.length>80)throw err(400,'整数のポイントと変更理由（80文字以内）を入力してください');
  const result=await transact(pool,async c=>{
   const r=await c.query('UPDATE parties SET points=points+$1 WHERE id=$2 AND points+$1>=0 RETURNING id,name,points',[delta,id]);
   if(!r.rowCount)throw err(409,'パーティーが存在しないか、ポイントがマイナスになります');
   await c.query('INSERT INTO party_point_adjustments(party_id,delta,reason) VALUES($1,$2,$3)',[id,delta,reason]);return r.rows[0];
  });res.json(result);
 }));
 router.get('/staff/applications',requireStaff,wrap(async(req,res)=>{
 const r=await pool.query(`SELECT a.id,a.name,a.member_ids,a.status,a.created_at,u.username applicant_name,
 ARRAY(SELECT u2.public_code||' / '||u2.username FROM users u2 WHERE u2.id=ANY(a.member_ids) ORDER BY array_position(a.member_ids,u2.id)) member_names,
 (SELECT COUNT(*)::int FROM party_application_votes v WHERE v.application_id=a.id) vote_total,
 (SELECT COUNT(*)::int FROM party_application_votes v WHERE v.application_id=a.id AND v.status='accepted') vote_accepted,
 (SELECT COUNT(*)::int FROM party_application_votes v WHERE v.application_id=a.id AND v.status='rejected') vote_rejected
 FROM party_applications a LEFT JOIN users u ON u.id=a.applicant_id WHERE a.status='pending' ORDER BY a.id`);
 res.json(r.rows.map(a=>({...a,ready:a.member_ids.length===3&&a.vote_total===2&&a.vote_accepted===2&&a.vote_rejected===0})));
}));
 router.post('/staff/applications/:id/:decision',requireStaff,wrap(async(req,res)=>{const decision=req.params.decision;if(!['approve','reject'].includes(decision))throw err(400,'不正な操作です');await transact(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8742301)');await assertUnlocked(c);const a=(await c.query("SELECT * FROM party_applications WHERE id=$1 AND status='pending' FOR UPDATE",[num(req.params.id)])).rows[0];if(!a)throw err(404,'申請が見つかりません');if(decision==='approve'){const votes=(await c.query('SELECT user_id,status FROM party_application_votes WHERE application_id=$1',[a.id])).rows;if(votes.length!==2||votes.some(v=>v.status!=='accepted')||votes.some(v=>!a.member_ids.map(Number).includes(Number(v.user_id))))throw err(409,'全員の結成同意が確認できません');const ids=a.member_ids.map(Number);const found=(await c.query('SELECT id,is_official FROM users WHERE id=ANY($1::bigint[])',[ids])).rows;if(found.some(u=>u.is_official))throw err(403,'運営アカウントはパーティーを結成できません');if(found.length!==3||!ids.includes(Number(a.applicant_id)))throw err(409,'申請者のアカウントが存在しません');if((await c.query('SELECT 1 FROM party_members WHERE user_id=ANY($1::bigint[]) LIMIT 1',[ids])).rowCount)throw err(409,'すでに別パーティーに所属しています');const p=(await c.query('INSERT INTO parties(name,leader_id) VALUES($1,$2) RETURNING id',[a.name,a.applicant_id])).rows[0];for(const id of ids)await c.query('INSERT INTO party_members(party_id,user_id) VALUES($1,$2)',[p.id,id]);}await c.query('UPDATE party_applications SET status=$1,reviewed_at=NOW() WHERE id=$2',[decision==='approve'?'approved':'rejected',a.id]);});res.json({ok:true});}));
 router.get('/staff/lock',requireStaff,wrap(async(req,res)=>res.json({locked:await locked(pool)})));
 router.post('/staff/lock',requireStaff,wrap(async(req,res)=>{await pool.query("UPDATE app_settings SET setting_value=$1,updated_at=NOW() WHERE setting_key='party_roster_locked'",[req.body.locked?'on':'off']);res.json({ok:true});}));
 app.use('/api/party',router);
}
module.exports={init,install,credit,beforeDelete};
