(()=>{
  const clickAudio=new Audio('/se/ui-click.mp3');
  clickAudio.preload='auto';
  const avatarAudio=new Audio('/se/avatar-select.mp3');
  avatarAudio.preload='auto';
  let navigating=false;
  const TRANSITION_MS=3000;

  let seCtx=null,seGain=null,clickSource=null,avatarSource=null;
  function clamp(v){return Math.max(0,Math.min(1,Number(v)||0))}
  function ensureSeGraph(){
    try{
      if(!seCtx){const Ctx=window.AudioContext||window.webkitAudioContext;if(Ctx)seCtx=new Ctx()}
      if(seCtx&&!seGain){seGain=seCtx.createGain();seGain.connect(seCtx.destination)}
      if(seCtx&&seGain&&!clickSource){clickSource=seCtx.createMediaElementSource(clickAudio);clickSource.connect(seGain)}
      if(seCtx&&seGain&&!avatarSource){avatarSource=seCtx.createMediaElementSource(avatarAudio);avatarSource.connect(seGain)}
    }catch(e){}
  }
  function resumeSeGraph(){
    try{
      if(seCtx&&seCtx.state!=='running'&&typeof seCtx.resume==='function')seCtx.resume().then(applySeVolume).catch(()=>{});
    }catch(e){}
  }
  function applySeVolume(){
    const master=window.NexusAudioSettings?.master ?? Number(localStorage.getItem('nexusMasterVolume') ?? 1);
    const se=window.NexusAudioSettings?.se ?? Number(localStorage.getItem('nexusSeVolume') ?? .62);
    const base=clamp(master*se);
    if(seGain&&seCtx){
      try{seGain.gain.cancelScheduledValues(seCtx.currentTime)}catch(e){}
      try{seGain.gain.setTargetAtTime(base,seCtx.currentTime,.012)}catch(e){seGain.gain.value=base}
      try{clickAudio.volume=1;avatarAudio.volume=1;clickAudio.muted=false;avatarAudio.muted=false}catch(e){}
    }else{
      try{clickAudio.volume=clamp(base*.94);avatarAudio.volume=base;clickAudio.muted=base<=0;avatarAudio.muted=base<=0}catch(e){}
    }
  }
  applySeVolume();
  window.addEventListener('nexus-audio-settings',applySeVolume);
  window.addEventListener('storage',e=>{if(['nexusMasterVolume','nexusSeVolume'].includes(e.key))applySeVolume()});
  document.addEventListener('pointerdown',()=>{ensureSeGraph();resumeSeGraph();applySeVolume()},{passive:true});

  function playAudio(a){try{ensureSeGraph();resumeSeGraph();applySeVolume();a.currentTime=0;a.play().catch(()=>{});}catch(e){}}
  function playClick(){playAudio(clickAudio)}
  function playAvatar(){playAudio(avatarAudio)}

  function ensureTransition(){
    let el=document.getElementById('moduleTransition');
    if(el)return el;
    el=document.createElement('div');el.id='moduleTransition';el.className='module-transition hidden';el.innerHTML=`
      <div class="module-transition-grid"></div>
      <div class="module-transition-core">
        <div class="module-transition-ring"><i></i><i></i><i></i></div>
        <div class="module-transition-brand">NEXUS:ZERO</div>
        <div class="module-transition-status">SWITCHING MODULE</div>
        <strong id="moduleTransitionTarget">HOME</strong>
        <div class="module-transition-bar"><span></span></div>
        <small class="module-transition-percent" id="moduleTransitionPercent">0%</small>
      </div>`;
    document.body.appendChild(el);return el;
  }

  function ensureModuleFrame(){
    if(window.self!==window.top)return null;
    let wrap=document.getElementById('moduleFrameOverlay');
    if(wrap)return wrap;
    wrap=document.createElement('div');wrap.id='moduleFrameOverlay';wrap.className='module-frame-overlay hidden';
    wrap.innerHTML='<iframe id="moduleFrame" title="NEXUS module" loading="eager"></iframe>';
    document.body.appendChild(wrap);
    return wrap;
  }

  function runTransition(label,done){
    if(navigating)return;
    navigating=true;
    const el=ensureTransition();
    const target=el.querySelector('#moduleTransitionTarget');
    const pct=el.querySelector('#moduleTransitionPercent');
    if(target)target.textContent=label;
    if(pct)pct.textContent='0%';
    el.classList.remove('hidden');
    el.classList.remove('active');
    void el.offsetWidth;
    requestAnimationFrame(()=>el.classList.add('active'));
    const start=performance.now();
    const tick=now=>{const p=Math.min(100,Math.round((now-start)/TRANSITION_MS*100));if(pct)pct.textContent=p+'%';if(p<100)requestAnimationFrame(tick)};
    requestAnimationFrame(tick);
    setTimeout(()=>{Promise.resolve().then(done).finally(()=>{setTimeout(()=>{el.classList.remove('active');setTimeout(()=>{el.classList.add('hidden');navigating=false;},180)},120)})},TRANSITION_MS);
  }

  function isModulePath(url){try{const u=new URL(url,location.href);return u.origin===location.origin && ['/','/ranking','/history','/rule','/network','/party'].includes(u.pathname)}catch(e){return false}}
  function labelFor(url,fallback='MODULE'){try{const p=new URL(url,location.href).pathname;return p==='/'?'HOME':p==='/ranking'?'RANKING':p==='/history'?'HISTORY':p==='/rule'?'RULE':p==='/network'?'NETWORK':p==='/party'?'PARTY':fallback}catch(e){return fallback}}

  function showModule(url,label){
    const wrap=ensureModuleFrame();if(!wrap){location.href=url;return}
    runTransition(label,()=>{if(new URL(url,location.href).pathname==='/'){wrap.classList.add('hidden');const frame=wrap.querySelector('#moduleFrame');frame.removeAttribute('src');history.pushState({nexusModule:'home'},'', '/');window.NexusAudioSettings?.sync?.();window.NexusBGM?.sync?.();window.NexusBGM?.setTrack?.('home');window.NexusBGM?.play?.();return}const frame=wrap.querySelector('#moduleFrame');wrap.classList.remove('hidden');frame.src=url+(url.includes('?')?'&':'?')+'embed=1';history.pushState({nexusModule:label.toLowerCase()},'',new URL(url,location.href).pathname);window.NexusBGM?.setTrack?.('home')});
  }
  function navigate(url,label='MODULE'){const account=document.getElementById('account');const canUseFrame=window.self===window.top && account && !account.classList.contains('hidden') && isModulePath(url);if(canUseFrame){showModule(url,label);return}runTransition(label,()=>{location.href=url})}

  document.addEventListener('click',e=>{
    const avatar=e.target.closest('.avatar-choice');if(avatar){playAvatar();return}
    const action=e.target.closest('button,a');
    if(action && !document.body.classList.contains('hitblow-page') && !document.body.classList.contains('janken-page') && !document.body.classList.contains('chinchiro-page') && !action.classList.contains('bgm-control') && !action.hasAttribute('data-no-se')) playClick();
    const nav=e.target.closest('[data-nexus-nav],a[href="/party"],a[href^="/party?"]');
    if(nav){
      const url=nav.getAttribute('href')||nav.dataset.href||'/';
      const label=labelFor(url,nav.dataset.nexusNav||'MODULE');
      e.preventDefault();
      if(window.self!==window.top && window.parent){
        window.parent.postMessage({type:'nexus-module-nav',url,label},location.origin);
      }else{
        navigate(url,label);
      }
    }
  },true);

  window.addEventListener('message',e=>{
    if(e.origin!==location.origin||!e.data)return;
    if(e.data.type==='nexus-open-settings'){window.NexusAudioSettings?.open?.();return}
    if(e.data.type==='nexus-module-nav'){showModule(e.data.url||'/',e.data.label||labelFor(e.data.url||'/'))}
  });
  window.addEventListener('popstate',()=>{if(window.self!==window.top)return;const p=location.pathname;const wrap=document.getElementById('moduleFrameOverlay');if(!wrap)return;if(p==='/'){wrap.classList.add('hidden');return}if(p==='/ranking'||p==='/history'||p==='/rule'||p==='/network'||p==='/party'){const frame=wrap.querySelector('#moduleFrame');wrap.classList.remove('hidden');frame.src=p+'?embed=1'}});

  let pressLock=false;
  function pulsePress(el,done,delay=190){
    if(pressLock)return;
    pressLock=true;
    if(el){el.classList.remove('nexus-pressing');void el.offsetWidth;el.classList.add('nexus-pressing')}
    document.body.classList.add('nexus-ui-shift');
    setTimeout(()=>{
      if(el)el.classList.remove('nexus-pressing');
      document.body.classList.remove('nexus-ui-shift');
      pressLock=false;
      try{done?.()}catch(e){console.error(e)}
    },delay);
  }
  document.addEventListener('pointerdown',e=>{
    const el=e.target.closest('button,a,.art-choice,.art-menu-root,.quick-game-card');
    if(!el||el.disabled)return;
    el.classList.add('nexus-touch-down');
    setTimeout(()=>el.classList.remove('nexus-touch-down'),140);
  },{passive:true});

  window.NexusUI={playClick,playAvatar,navigate,pulsePress};
})();

// Party affiliations are displayed only on battle player cards; no client supplied party names.
(()=>{
 const cache=new Map(),inFlight=new Set();let queued=false;
 const escapeText=v=>String(v??'');
 function compactResult(){
  // Preserve game logic and the result countdown; only regroup existing nodes.
  document.querySelectorAll('.hb-result').forEach(result=>{
   if(result.querySelector('.nexus-result-points-grid'))return;
   const personal=[...result.children].find(el=>el.tagName==='STRONG');
   const party=result.querySelector('.nexus-party-result');
   if(!personal||!party)return;
   const grid=document.createElement('div');grid.className='nexus-result-points-grid';
   const personalBox=document.createElement('div');personalBox.className='nexus-personal-points';
   const label=document.createElement('small');label.textContent='個人ポイント';
   personalBox.append(label,personal);
   party.before(grid);grid.append(personalBox,party);
  });
 }
 function fitBattlePartyName(badge){
  if(!badge.closest('.battle-person'))return;
  const card=badge.closest('.battle-person');
  const available=Math.max(40,card.clientWidth-12);
  badge.style.fontSize='10px';
  badge.style.letterSpacing='0';
  const text=badge.textContent||'';
  const canvas=fitBattlePartyName.canvas||(fitBattlePartyName.canvas=document.createElement('canvas'));
  const ctx=canvas.getContext('2d');
  if(!ctx)return;
  const weight=getComputedStyle(badge).fontWeight||'800';
  const family=getComputedStyle(badge).fontFamily||'sans-serif';
  let size=10;
  while(size>6.5){ctx.font=`${weight} ${size}px ${family}`;if(ctx.measureText(text).width+16<=available)break;size-=.25}
  badge.style.fontSize=`${size}px`;
 }
 function paint(){
  compactResult();
  document.querySelectorAll('.battle-person[data-party-user],.prebattle-player[data-party-user]').forEach(card=>{
   const id=card.dataset.partyUser;
   const existing=card.querySelector('.nexus-party-affiliation');
   if(!cache.has(id)){if(existing)existing.remove();return}
   const name=cache.get(id);
   if(!name){if(existing)existing.remove();return}
   if(existing){if(existing.textContent!==name)existing.textContent=name;fitBattlePartyName(existing);return}
   const badge=document.createElement('span');badge.className='nexus-party-affiliation';badge.textContent=name;
   const strong=card.querySelector('.prebattle-meta strong, strong');if(strong){strong.insertAdjacentElement('afterend',badge);fitBattlePartyName(badge)}
  });
  document.querySelectorAll('.nexus-party-result').forEach(el=>{
   const a=el.dataset.partySelf,b=el.dataset.partyRival;
   if(!cache.has(a)||!cache.has(b))return;
   const self=cache.get(a),rival=cache.get(b);
   const eligible=!!self&&!!rival&&self!==rival;
   const outcome=el.dataset.partyOutcome;
   const pt=outcome==='win'?2:outcome==='draw'?1:0;
   const signature=eligible?`${self}:${pt}`:'not-eligible';
   if(el.dataset.rendered===signature)return;
   el.dataset.rendered=signature;
   if(eligible){el.replaceChildren();const small=document.createElement('small');small.textContent='PARTY POINTS';const big=document.createElement('b');big.textContent=`+${pt} pt`;const name=document.createElement('span');name.textContent=self;el.append(small,big,name)}
   else{el.textContent='パーティーポイント対象外'}
  });
 }
 async function update(){
  queued=false;
  const ids=[...new Set([...document.querySelectorAll('.battle-person[data-party-user],.prebattle-player[data-party-user],.nexus-party-result[data-party-self],.nexus-party-result[data-party-rival]')].flatMap(x=>[x.dataset.partyUser,x.dataset.partySelf,x.dataset.partyRival].filter(Boolean)))].filter(x=>/^\d+$/.test(x)&&Number(x)>0&&!cache.has(x)&&!inFlight.has(x));
  paint();if(!ids.length)return;
  ids.forEach(id=>inFlight.add(id));
  try{
   const token=localStorage.getItem('nexusParticipantToken')||'';
   const res=await fetch('/api/party/affiliations?ids='+encodeURIComponent(ids.join(',')),{headers:{'X-Participant-Token':token,Authorization:'Bearer '+token},credentials:'same-origin'});
   if(!res.ok)return;
   const data=await res.json();ids.forEach(id=>cache.set(id,data[id]||''));paint();
  }catch(e){}finally{ids.forEach(id=>inFlight.delete(id))}
 }
 function schedule(){if(queued)return;queued=true;queueMicrotask(update)}
 const style=document.createElement('style');style.textContent=`
 .battle-person .nexus-party-affiliation,.prebattle-player .nexus-party-affiliation{display:block;box-sizing:border-box;max-width:100%;min-width:0;margin:4px auto 0;padding:4px 7px;border:1px solid rgba(66,205,255,.55);border-radius:6px;background:rgba(4,35,67,.86);box-shadow:0 0 10px rgba(16,135,255,.18);color:#8fe7ff;font-size:clamp(9px,2.2vw,11px);font-weight:800;letter-spacing:0;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal;line-height:1.3}
 .battle-person{min-width:0}
 .battle-person .nexus-party-affiliation{width:max-content;max-width:100%}
 /* Align affiliation badges with the avatar column on both sides of the VS row. */
 .hitblow-page #hbPlayers .battle-person .nexus-party-affiliation,
 .janken-page #jkPlayers .battle-person .nexus-party-affiliation,
 .chinchiro-page #ccPlayers .battle-person .nexus-party-affiliation,
 .match-page #battlePlayers .battle-person .nexus-party-affiliation{
   grid-column:1 / -1!important;grid-row:4!important;justify-self:start!important;align-self:start!important;
   width:max-content!important;max-width:100%!important;margin:3px 0 0!important;
   padding:3px 5px!important;min-width:0!important;text-align:left!important;
   font-size:clamp(7px,1.7vw,10px)!important;white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important;
 }
 .hitblow-page #hbPlayers .battle-person:last-child .nexus-party-affiliation,
 .janken-page #jkPlayers .battle-person:last-child .nexus-party-affiliation,
 .chinchiro-page #ccPlayers .battle-person:last-child .nexus-party-affiliation,
 .match-page #battlePlayers .battle-person:last-child .nexus-party-affiliation{
   grid-column:1 / -1!important;justify-self:end!important;text-align:right!important;
 }
 .battle-person>strong{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .battle-player-row{min-width:0}
 @media(max-width:480px){.battle-person .nexus-party-affiliation{padding:3px 5px;font-size:9px}.battle-person{padding-left:5px!important;padding-right:5px!important}}
 
 .prebattle-player .nexus-party-affiliation{font-size:clamp(8px,2vw,11px);max-width:100%;padding:2px 7px;margin:3px auto 0;line-height:1.25;white-space:nowrap;letter-spacing:0;overflow:hidden;text-overflow:ellipsis}
 .prebattle-meta{max-width:min(62vw,370px)!important}
 .nexus-party-result{margin:12px auto;padding:10px 14px;max-width:340px;border:1px solid rgba(79,216,255,.38);border-radius:8px;background:rgba(4,28,51,.78);color:#d8f8ff;font-size:12px;line-height:1.5;letter-spacing:0;text-align:center}
 .nexus-party-result:empty{display:none}
 .nexus-party-result b{display:block;color:#74eaff;font-size:17px;margin:3px 0}
 .nexus-party-result small{display:block;color:#a0bfd3;font-size:10px}
 .nexus-result-points-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;align-items:stretch;width:min(100%,540px);margin:12px auto}
 .nexus-result-points-grid .nexus-personal-points,.nexus-result-points-grid .nexus-party-result{min-width:0;max-width:none;margin:0;padding:11px 7px;border:1px solid rgba(79,216,255,.38);border-radius:8px;background:rgba(4,28,51,.78);display:flex;flex-direction:column;justify-content:center;align-items:center;gap:4px;line-height:1.35;letter-spacing:0}
 .nexus-result-points-grid .nexus-personal-points small{font-size:10px;color:#a0bfd3}
 .nexus-result-points-grid .nexus-personal-points>strong{font-size:clamp(19px,5vw,27px);line-height:1.2;margin:0;color:#fff}
 .nexus-result-points-grid .nexus-party-result b{font-size:clamp(18px,4.8vw,25px);margin:0}
 .nexus-result-points-grid .nexus-party-result span{font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .nexus-result-points-grid .nexus-party-result{font-size:11px}
 .hb-result{padding:14px 8px!important}
 .hb-result h2{margin:5px 0 8px!important}
 .hb-result>p{margin:7px 0 9px!important;font-size:clamp(13px,3.5vw,18px)!important}
 .hb-result .nexus-result-points-grid + div{margin-top:10px}
 .match-page .winner-line{padding:12px!important;letter-spacing:.06em}
 .match-page .winner-line .nexus-party-result{margin:8px auto!important;padding:8px!important}
 @media(max-width:380px){.nexus-result-points-grid{gap:6px}.nexus-result-points-grid .nexus-personal-points,.nexus-result-points-grid .nexus-party-result{padding:9px 5px}}
 
 `;document.head.appendChild(style);
 new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('.battle-person[data-party-user],.prebattle-player[data-party-user],.nexus-party-result,.hb-result')||n.querySelector?.('.battle-person[data-party-user],.prebattle-player[data-party-user],.nexus-party-result,.hb-result')))))schedule()}).observe(document.documentElement,{subtree:true,childList:true});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule);else schedule();
})();
