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
  function resumeSeGraph(){try{if(seCtx&&seCtx.state==='suspended')seCtx.resume().catch(()=>{})}catch(e){}}
  function applySeVolume(){
    const master=window.NexusAudioSettings?.master ?? Number(localStorage.getItem('nexusMasterVolume') ?? 1);
    const se=window.NexusAudioSettings?.se ?? Number(localStorage.getItem('nexusSeVolume') ?? .62);
    const base=clamp(master*se);
    ensureSeGraph();
    if(seGain&&seCtx){
      try{seGain.gain.setTargetAtTime(base,seCtx.currentTime,.015)}catch(e){seGain.gain.value=base}
      try{clickAudio.volume=1;avatarAudio.volume=1}catch(e){}
    }else{
      try{clickAudio.volume=clamp(base*.94);avatarAudio.volume=base}catch(e){}
    }
  }
  applySeVolume();
  window.addEventListener('nexus-audio-settings',applySeVolume);
  window.addEventListener('storage',e=>{if(['nexusMasterVolume','nexusSeVolume'].includes(e.key))applySeVolume()});
  document.addEventListener('pointerdown',()=>{ensureSeGraph();resumeSeGraph()},{passive:true});

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

  function isModulePath(url){try{const u=new URL(url,location.href);return u.origin===location.origin && ['/','/ranking','/history','/rule'].includes(u.pathname)}catch(e){return false}}
  function labelFor(url,fallback='MODULE'){try{const p=new URL(url,location.href).pathname;return p==='/'?'HOME':p==='/ranking'?'RANKING':p==='/history'?'HISTORY':p==='/rule'?'RULE':fallback}catch(e){return fallback}}

  function showModule(url,label){
    const wrap=ensureModuleFrame();if(!wrap){location.href=url;return}
    runTransition(label,()=>{if(new URL(url,location.href).pathname==='/'){wrap.classList.add('hidden');const frame=wrap.querySelector('#moduleFrame');frame.removeAttribute('src');history.pushState({nexusModule:'home'},'', '/');window.NexusAudioSettings?.sync?.();window.NexusBGM?.sync?.();window.NexusBGM?.setTrack?.('home');window.NexusBGM?.play?.();return}const frame=wrap.querySelector('#moduleFrame');wrap.classList.remove('hidden');frame.src=url+(url.includes('?')?'&':'?')+'embed=1';history.pushState({nexusModule:label.toLowerCase()},'',new URL(url,location.href).pathname);window.NexusBGM?.setTrack?.('home')});
  }
  function navigate(url,label='MODULE'){const account=document.getElementById('account');const canUseFrame=window.self===window.top && account && !account.classList.contains('hidden') && isModulePath(url);if(canUseFrame){showModule(url,label);return}runTransition(label,()=>{location.href=url})}

  document.addEventListener('click',e=>{
    const avatar=e.target.closest('.avatar-choice');if(avatar){playAvatar();return}
    const action=e.target.closest('button,a');
    if(action && !document.body.classList.contains('hitblow-page') && !document.body.classList.contains('janken-page') && !document.body.classList.contains('chinchiro-page') && !action.classList.contains('bgm-control') && !action.hasAttribute('data-no-se')) playClick();
    const nav=e.target.closest('[data-nexus-nav]');
    if(nav){e.preventDefault();const url=nav.getAttribute('href')||nav.dataset.href||'/';const label=nav.dataset.nexusNav||labelFor(url);if(window.self!==window.top && window.parent){window.parent.postMessage({type:'nexus-module-nav',url,label},location.origin)}else navigate(url,label)}
  },true);

  window.addEventListener('message',e=>{
    if(e.origin!==location.origin||!e.data)return;
    if(e.data.type==='nexus-open-settings'){window.NexusAudioSettings?.open?.();return}
    if(e.data.type==='nexus-module-nav'){showModule(e.data.url||'/',e.data.label||labelFor(e.data.url||'/'))}
  });
  window.addEventListener('popstate',()=>{if(window.self!==window.top)return;const p=location.pathname;const wrap=document.getElementById('moduleFrameOverlay');if(!wrap)return;if(p==='/'){wrap.classList.add('hidden');return}if(p==='/ranking'||p==='/history'||p==='/rule'){const frame=wrap.querySelector('#moduleFrame');wrap.classList.remove('hidden');frame.src=p+'?embed=1'}});

  window.NexusUI={playClick,playAvatar,navigate};
})();
