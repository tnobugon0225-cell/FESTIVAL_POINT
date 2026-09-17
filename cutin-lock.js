/* NEXUS:ZERO CUT-IN LOCK v6.49
   Canonical cut-in renderer. Keep battle pages dependent on this file instead of duplicating cut-in mappings. */
(function(){
  'use strict';
  const AVATAR_RE=/^avatar-(0[1-9]|1[0-2])$/;
  window.cutinArtSrc=function(p,side){
    const k=String(p&&p.avatarKey||'');
    if(AVATAR_RE.test(k) && (side==='top'||side==='bottom')) return `/cutin-assets/${k}-${side}.webp`;
    return '';
  };
  window.cutinPlayer=function(p,side){
    const art=window.cutinArtSrc(p,side);
    const cls=side==='top'?'prebattle-a':'prebattle-b';
    if(art){
      const slotStyle=side==='top'?' style="top:20.5vh!important;bottom:auto!important"':'';
      const metaPos=side==='top'?'top:53%!important;':'top:62%!important;left:17%!important;right:auto!important;';
      return `<div class="prebattle-player ${cls} prebattle-art-player"${slotStyle}><img class="prebattle-cutart" src="${art}" alt=""><div class="prebattle-meta" style="${metaPos}transform:translateY(-50%)!important;width:max-content!important;min-width:0!important;max-width:min(58vw,350px)!important;box-sizing:border-box!important;background:rgba(2,7,15,.38)!important;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);padding:2px 10px 3px!important;border:1px solid rgba(255,255,255,.09)!important;border-radius:6px!important;box-shadow:0 2px 9px rgba(0,0,0,.18)!important;display:inline-flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;gap:0!important;white-space:nowrap!important;"><img class="prebattle-title-img" src="${titleImage(p)}" alt="${esc(titleName(p))}" style="width:132px!important;height:31px!important;min-width:132px!important;max-width:132px!important;object-fit:contain!important;display:block!important;"><strong>${esc(p.name)}</strong></div></div>`;
    }
    return `<div class="prebattle-player ${cls}"><img src="${avatarSrc(p.avatarKey)}"><img class="prebattle-title-img" src="${titleImage(p)}" alt="${esc(titleName(p))}"><strong>${esc(p.name)}</strong></div>`;
  };
})();
