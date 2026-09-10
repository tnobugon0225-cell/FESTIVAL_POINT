(()=>{
  const TRACKS={
    home:'/bgm/shinsou-douchou.mp3',
    matching:'/bgm/memory-sphere.mp3',
    battle:'/bgm/reconnection.mp3',
    victory:'/bgm/theseus-no-fune.mp3'
  };
  const LABELS={home:'深層同調',matching:'Memory Sphere',battle:'Reconnection',victory:'テセウスの船'};
  const audio=new Audio();
  audio.loop=true;
  audio.preload='auto';
  audio.volume=.42;
  let current='';
  let blocked=false;
  let enabled=localStorage.getItem('nexusBgmEnabled')!=='0';
  let control=null;

  function ensureControl(){
    if(control||!document.body)return;
    control=document.createElement('button');
    control.type='button';
    control.className='bgm-control';
    control.setAttribute('aria-label','BGM ON/OFF');
    control.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();toggle();});
    document.body.appendChild(control);
    paint();
  }
  function paint(){
    if(!control)return;
    const title=current?LABELS[current]||'BGM':'BGM';
    control.innerHTML=`<span>${enabled?'♪':'×'}</span><b>${enabled?'BGM ON':'BGM OFF'}</b><small>${title}</small>`;
    control.classList.toggle('off',!enabled);
    control.classList.toggle('blocked',blocked&&enabled);
    control.classList.toggle('hidden',!current);
  }
  async function play(){
    if(!enabled||!current)return;
    try{await audio.play();blocked=false;}catch(e){blocked=true;}
    paint();
  }
  function setTrack(name){
    if(!TRACKS[name])return;
    ensureControl();
    if(current===name){if(enabled&&audio.paused)play();return;}
    current=name;
    const next=TRACKS[name];
    if(audio.src.endsWith(next)){play();paint();return;}
    audio.pause();
    audio.src=next;
    audio.currentTime=0;
    paint();
    play();
  }
  function clearTrack(){audio.pause();audio.removeAttribute('src');audio.load();current='';blocked=false;paint();}
  function toggle(){
    enabled=!enabled;
    localStorage.setItem('nexusBgmEnabled',enabled?'1':'0');
    blocked=false;
    if(enabled)play(); else audio.pause();
    paint();
  }
  function unlock(){
    if(enabled&&current&&audio.paused)play();
  }
  document.addEventListener('pointerdown',unlock,{passive:true});
  document.addEventListener('keydown',unlock,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&enabled&&current)play();});
  audio.addEventListener('ended',()=>{if(enabled){audio.currentTime=0;play();}});
  window.NexusBGM={setTrack,clearTrack,toggle,play,get enabled(){return enabled},get current(){return current}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ensureControl);else ensureControl();
})();
