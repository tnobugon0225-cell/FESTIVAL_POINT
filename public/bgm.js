(()=>{
  const clamp=v=>Math.max(0,Math.min(1,Number(v)||0));
  const readVol=(key,fallback)=>{const raw=localStorage.getItem(key);return raw===null?fallback:clamp(Number(raw));};
  const state={
    master:readVol('nexusMasterVolume',1),
    bgm:readVol('nexusBgmVolume',.42),
    se:readVol('nexusSeVolume',.62)
  };

  let settingsPanel=null,settingsButton=null;
  let ctx=null,bgmSource=null,bgmGain=null;

  // iPhone/Safari note:
  // A MediaElementSource routed into a suspended AudioContext becomes silent.
  // Therefore the Web Audio graph is created ONLY from a real user gesture,
  // after the context has successfully entered the running state. Until then
  // the HTMLAudioElement plays normally so BGM is never swallowed by a
  // suspended graph.
  async function unlockAudioGraph(){
    try{
      const Ctx=window.AudioContext||window.webkitAudioContext;
      if(!Ctx)return false;
      if(!ctx)ctx=new Ctx();
      if(ctx.state==='suspended')await ctx.resume();
      if(ctx.state!=='running')return false;
      if(!bgmSource){
        bgmSource=ctx.createMediaElementSource(audio);
        bgmGain=ctx.createGain();
        bgmSource.connect(bgmGain).connect(ctx.destination);
      }
      applyVolume();
      return true;
    }catch(e){return false}
  }

  function applyVolume(){
    const effective=clamp(state.master*state.bgm);
    if(bgmGain&&ctx){
      try{bgmGain.gain.setTargetAtTime(effective,ctx.currentTime,.015)}catch(e){bgmGain.gain.value=effective}
      // iOS Safari ignores media-element volume changes, so keep the element itself at full scale
      // and control actual BGM level through Web Audio GainNode.
      try{audio.volume=1}catch(e){}
    }else{
      try{audio.volume=effective}catch(e){}
    }
  }
  function persist(){
    localStorage.setItem('nexusMasterVolume',String(state.master));
    localStorage.setItem('nexusBgmVolume',String(state.bgm));
    localStorage.setItem('nexusSeVolume',String(state.se));
    window.dispatchEvent(new CustomEvent('nexus-audio-settings',{detail:{...state}}));
  }
  window.NexusAudioSettings={
    get master(){return state.master},get bgm(){return state.bgm},get se(){return state.se},
    setMaster(v){state.master=clamp(v);applyVolume();persist();paintSettings()},
    setBgm(v){state.bgm=clamp(v);applyVolume();persist();paintSettings()},
    setSe(v){state.se=clamp(v);persist();paintSettings()},
    snapshot(){return {...state}},
    effectiveBgm(){return clamp(state.master*state.bgm)},
    effectiveSe(){return clamp(state.master*state.se)}
  };

  if(window.self!==window.top){
    window.NexusBGM={setTrack(){},clearTrack(){},toggle(){},play(){},prime(){},get enabled(){return false},get current(){return ''}};
    return;
  }

  const TRACKS={home:'/bgm/shinsou-douchou.mp3',matching:'/bgm/memory-sphere.mp3',battle:'/bgm/reconnection.mp3',victory:'/bgm/theseus-no-fune.mp3'};
  const audio=new Audio();
  audio.loop=true;audio.preload='auto';
  audio.setAttribute('playsinline','');
  let current='',blocked=false,enabled=true;
  applyVolume();

  async function play(){
    if(!enabled||!current)return;
    try{applyVolume();await audio.play();blocked=false}catch(e){blocked=true}
  }
  async function prime(name='home'){
    if(!enabled||!TRACKS[name])return;
    try{
      const next=TRACKS[name];if(!audio.src.endsWith(next)){audio.src=next;audio.load()}
      const wasMuted=audio.muted;audio.muted=true;const p=audio.play();if(p&&typeof p.then==='function')await p;audio.pause();try{audio.currentTime=0}catch(e){}audio.muted=wasMuted;blocked=false
    }catch(e){try{audio.pause();audio.muted=false}catch(_){}}
  }
  function setTrack(name){
    if(!TRACKS[name])return;
    if(current===name){if(audio.paused)play();return}
    current=name;const next=TRACKS[name];
    if(audio.src.endsWith(next)){play();return}
    audio.pause();audio.src=next;audio.currentTime=0;applyVolume();play();
  }
  function clearTrack(){audio.pause();audio.removeAttribute('src');audio.load();current='';blocked=false}
  // Kept for compatibility with older calls. The old floating ON/OFF bar is intentionally removed.
  function toggle(){enabled=!enabled;if(enabled)play();else audio.pause()}
  async function unlock(){
    localStorage.setItem('nexusAudioUnlocked','1');
    await unlockAudioGraph();
    if(enabled&&current&&audio.paused)play();
  }

  function pct(v){return Math.round(v*100)}
  function sliderRow(key,label){return `<label class="nexus-volume-row"><span><b>${label}</b><em id="${key}Value">0</em></span><input id="${key}Slider" type="range" min="0" max="100" step="1" value="0"></label>`}
  function paintSettings(){
    if(!settingsPanel)return;
    [['master',state.master],['bgm',state.bgm],['se',state.se]].forEach(([k,v])=>{const s=document.getElementById(`${k}Slider`),t=document.getElementById(`${k}Value`);if(s&&document.activeElement!==s)s.value=String(pct(v));if(t)t.textContent=`${pct(v)}%`});
  }
  function closeSettings(){settingsPanel?.classList.remove('show');settingsButton?.classList.remove('active')}
  function ensureSettings(){
    if(settingsButton||!document.body)return;
    const nav=document.querySelector('.topbar .nav-links');
    settingsButton=document.createElement('button');settingsButton.type='button';settingsButton.className='setting-nav-button';settingsButton.setAttribute('data-no-se','');settingsButton.textContent='SETTING';
    if(nav)nav.appendChild(settingsButton);else{settingsButton.classList.add('floating');document.body.appendChild(settingsButton)}
    settingsPanel=document.createElement('div');settingsPanel.className='nexus-settings-panel';settingsPanel.innerHTML=`<div class="nexus-settings-card"><div class="nexus-settings-head"><div><span>SOUND CONTROL</span><strong>SETTING</strong></div><button type="button" data-no-se class="nexus-settings-close" aria-label="閉じる">×</button></div>${sliderRow('master','MASTER')}${sliderRow('bgm','BGM')}${sliderRow('se','SE')}<p>端末の音量とは別に、NEXUS:ZERO内の音量を調整します。</p></div>`;
    document.body.appendChild(settingsPanel);
    settingsButton.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();unlock();const open=!settingsPanel.classList.contains('show');settingsPanel.classList.toggle('show',open);settingsButton.classList.toggle('active',open);paintSettings()});
    settingsPanel.querySelector('.nexus-settings-close').addEventListener('click',closeSettings);
    settingsPanel.addEventListener('click',e=>{if(e.target===settingsPanel)closeSettings()});
    ['master','bgm','se'].forEach(k=>{settingsPanel.querySelector(`#${k}Slider`).addEventListener('input',e=>{unlock();const v=Number(e.target.value)/100;if(k==='master')window.NexusAudioSettings.setMaster(v);if(k==='bgm')window.NexusAudioSettings.setBgm(v);if(k==='se')window.NexusAudioSettings.setSe(v)})});
    paintSettings();
  }

  document.addEventListener('pointerdown',unlock,{passive:true});document.addEventListener('keydown',unlock,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&enabled&&current)play()});
  window.addEventListener('pageshow',()=>{if(localStorage.getItem('nexusAudioUnlocked')==='1'&&enabled&&current)play()});
  window.addEventListener('focus',()=>{if(localStorage.getItem('nexusAudioUnlocked')==='1'&&enabled&&current&&audio.paused)play()});
  window.addEventListener('storage',e=>{if(['nexusMasterVolume','nexusBgmVolume','nexusSeVolume'].includes(e.key)){state.master=readVol('nexusMasterVolume',1);state.bgm=readVol('nexusBgmVolume',.42);state.se=readVol('nexusSeVolume',.62);applyVolume();paintSettings();window.dispatchEvent(new CustomEvent('nexus-audio-settings',{detail:{...state}}))}});
  audio.addEventListener('ended',()=>{if(enabled){audio.currentTime=0;play()}});
  window.NexusBGM={setTrack,clearTrack,toggle,play,prime,get enabled(){return enabled},get current(){return current}};
  const ready=()=>ensureSettings();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();
