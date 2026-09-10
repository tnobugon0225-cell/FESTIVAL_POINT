(()=>{
  const clickAudio=new Audio('/se/ui-click.mp3');
  clickAudio.preload='auto';
  clickAudio.volume=.58;
  let navigating=false;
  function playClick(){
    try{clickAudio.currentTime=0;clickAudio.play().catch(()=>{});}catch(e){}
  }
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
      </div>`;
    document.body.appendChild(el);return el;
  }
  function navigate(url,label='MODULE'){
    if(navigating)return;navigating=true;
    const el=ensureTransition();const t=el.querySelector('#moduleTransitionTarget');if(t)t.textContent=label;
    el.classList.remove('hidden');requestAnimationFrame(()=>el.classList.add('active'));
    setTimeout(()=>{location.href=url},620);
  }
  document.addEventListener('click',e=>{
    const action=e.target.closest('button,a');
    if(action && !action.classList.contains('bgm-control') && !action.hasAttribute('data-no-se')) playClick();
    const nav=e.target.closest('[data-nexus-nav]');
    if(nav){e.preventDefault();navigate(nav.getAttribute('href')||nav.dataset.href||'/',nav.dataset.nexusNav||'MODULE');}
  },true);
  window.NexusUI={playClick,navigate};
})();
