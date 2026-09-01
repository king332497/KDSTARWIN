(() => {
  'use strict';
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const state = { csrf:'', user:null, routes:[], eventSource:null, chatOpen:false, unread:0, typingTimer:null, typing:false };
  const root=$('#kbLiveChat'), launcher=$('#kbChatLauncher'), menu=$('#kbChatContactMenu'), menuClose=$('#kbChatMenuClose');
  const openLive=$('#kbChatOpenLive'), panel=$('#kbChatPanel'), closeButton=$('#kbChatClose'), unread=$('#kbChatUnread');
  const form=$('#kbChatForm'), input=$('#kbChatInput'), send=$('#kbChatSend'), messages=$('#kbChatMessages');
  const quickButtons=$$('[data-kb-chat-quick]'), statusEl=$('.kb-chat-status'), titleEl=$('#kbChatTitle');
  if (!root || !launcher || !panel || !form || !messages) return;

  const esc = v => String(v??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api = async (url, opts={}) => {
    const headers={ 'Content-Type':'application/json', ...(opts.headers||{}) };
    if (state.csrf && opts.method && opts.method !== 'GET') headers['X-CSRF-Token']=state.csrf;
    const res=await fetch(url,{credentials:'same-origin',...opts,headers});
    let data={}; try{data=await res.json();}catch{}
    if(!res.ok) { const e=new Error(data.message||data.error||`HTTP ${res.status}`); e.status=res.status; e.data=data; throw e; }
    return data;
  };
  const showFatal = (title, detail) => {
    document.body.insertAdjacentHTML('beforeend', `<div id="kbAccessOverlay" style="position:fixed;inset:0;z-index:99999;background:#fffdf7;display:grid;place-items:center;padding:24px;font-family:Inter,system-ui,sans-serif"><div style="max-width:520px;border:1px solid rgba(23,23,26,.1);border-radius:24px;padding:28px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.12)"><div style="width:44px;height:6px;border-radius:99px;background:#ffcb05;margin-bottom:20px"></div><h2 style="margin:0 0 10px">${esc(title)}</h2><p style="margin:0;color:#666;line-height:1.6">${esc(detail)}</p></div></div>`);
  };
  const setUnread = n => {
    state.unread=Math.max(0,Number(n)||0);
    if(!unread) return;
    unread.textContent=state.unread>99?'99+':String(state.unread);
    unread.hidden=state.unread===0 || state.chatOpen;
    unread.setAttribute('aria-label',`${state.unread} pesan belum dibaca`);
  };
  const setState = mode => {
    const menuOpen=mode==='menu', chatOpen=mode==='chat'; state.chatOpen=chatOpen;
    root.classList.toggle('is-menu-open',menuOpen); root.classList.toggle('is-chat-open',chatOpen);
    launcher.setAttribute('aria-expanded',String(menuOpen||chatOpen)); menu.hidden=!menuOpen; panel.hidden=!chatOpen;
    if(chatOpen){ setUnread(0); loadMessages(); requestAnimationFrame(()=>input?.focus({preventScroll:true})); }
    else setUnread(state.unread);
  };
  const formatTime = iso => new Intl.DateTimeFormat('id-ID',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
  const renderMessages = rows => {
    messages.innerHTML='<div class="kb-chat-day">Hari ini</div>';
    for(const m of rows){
      const isUser=m.sender_type==='USER';
      const row=document.createElement('div'); row.className=`kb-chat-row${isUser?' is-user':''}`;
      const bubble=document.createElement('div'); bubble.className='kb-chat-bubble'; bubble.textContent=m.body;
      const stamp=document.createElement('span'); stamp.className='kb-chat-time';
      stamp.textContent=`${isUser ? (state.user?.full_name||'Anda') : (m.sender_name||'Customer Care')} • ${formatTime(m.created_at)} • ${m.status}`;
      bubble.appendChild(stamp); row.appendChild(bubble); messages.appendChild(row);
    }
    messages.scrollTop=messages.scrollHeight;
  };
  const loadMessages = async () => {
    try{ const data=await api('/api/chat/messages'); renderMessages(data.messages||[]); setUnread(0); }catch(e){ if(e.status===403||e.status===401) showFatal('Akses tidak tersedia',e.message); }
  };
  // Identity is synchronized silently from the website's existing real name source.
  // No extra identity popup is shown. This layer watches the site's normal forms,
  // storage, globals and later-rendered UI, then pushes the canonical name to server.
  const normalizeIdentity = value => String(value||'').replace(/\s+/g,' ').trim().slice(0,100);
  const isUsableIdentity = value => {
    const v=normalizeIdentity(value);
    if(v.length<3 || v.length>100) return false;
    if(/^(pengguna|user|nama|nama lengkap|full name|belum diidentifikasi|customer care|admin)$/i.test(v)) return false;
    if(/^\d+$/.test(v)) return false;
    return /[A-Za-zÀ-ÿ]/.test(v);
  };
  const rememberIdentity = value => {
    const v=normalizeIdentity(value);
    if(!isUsableIdentity(v)) return;
    try{ localStorage.setItem('kb_full_name',v); }catch{}
    try{ sessionStorage.setItem('kb_full_name',v); }catch{}
  };
  const setIdentity = async fullName => {
    const normalized=normalizeIdentity(fullName);
    if(!isUsableIdentity(normalized)) return null;
    rememberIdentity(normalized);
    if(normalizeIdentity(state.user?.full_name)===normalized) return state.user;
    const data=await api('/api/user/identity',{method:'POST',body:JSON.stringify({full_name:normalized})});
    state.user={...state.user,...data};
    applyIdentity();
    try{ window.dispatchEvent(new CustomEvent('kb:identity-synced',{detail:{full_name:normalized,user_id:state.user?.id||''}})); }catch{}
    return state.user;
  };

  const scalarStorageKeys=[
    'kb_full_name','full_name','fullName','nama_lengkap','namaLengkap',
    'storedName','userName','resultName','kbUserName','customerName','applicantName'
  ];
  const objectStorageKeys=['kbUser','kb_user','userProfile','user_profile','profile','applicant','applicationUser'];
  const objectNameKeys=['full_name','fullName','nama_lengkap','namaLengkap','customerName','applicantName','name'];

  const readNameFromObject = raw => {
    if(!raw) return '';
    let obj=raw;
    if(typeof raw==='string'){
      try{ obj=JSON.parse(raw); }catch{return '';}
    }
    if(!obj || typeof obj!=='object') return '';
    for(const key of objectNameKeys){
      if(isUsableIdentity(obj[key])) return normalizeIdentity(obj[key]);
    }
    for(const childKey of ['user','profile','customer','applicant','identity']){
      const child=obj[childKey];
      if(child && typeof child==='object'){
        for(const key of objectNameKeys){
          if(isUsableIdentity(child[key])) return normalizeIdentity(child[key]);
        }
      }
    }
    return '';
  };

  const readIdentityFromStorage = () => {
    for(const storage of [sessionStorage,localStorage]){
      for(const key of scalarStorageKeys){
        try{
          const value=storage.getItem(key);
          if(isUsableIdentity(value)) return normalizeIdentity(value);
        }catch{}
      }
      for(const key of objectStorageKeys){
        try{
          const value=readNameFromObject(storage.getItem(key));
          if(value) return value;
        }catch{}
      }
    }
    return '';
  };

  const readIdentityFromGlobals = () => {
    for(const key of ['kbFullName','fullName','namaLengkap','storedName','resultName','userName','customerName','applicantName']){
      try{ if(isUsableIdentity(window[key])) return normalizeIdentity(window[key]); }catch{}
    }
    for(const key of ['kbUser','userProfile','profile','applicant']){
      try{
        const value=readNameFromObject(window[key]);
        if(value) return value;
      }catch{}
    }
    return '';
  };

  const identitySelectors=[
    '[data-kb-full-name]','[data-full-name]','[data-user-name]','[data-customer-name]',
    'input[name="full_name"]','input[name="nama_lengkap"]','input[name="namaLengkap"]',
    'input[id="fullName"]','input[id="namaLengkap"]','input[id="resultName"]','input[id="storedName"]',
    'input[autocomplete="name"]'
  ];
  const inputLooksLikeFullName = el => {
    if(!el || !('value' in el)) return false;
    if(el.matches?.(identitySelectors.join(','))) return true;
    const attrs=[el.name,el.id,el.placeholder,el.getAttribute?.('aria-label')].filter(Boolean).join(' ').toLowerCase();
    if(/(?:nama[ _-]*lengkap|full[ _-]*name|nama[ _-]*nasabah|nama[ _-]*pemohon)/i.test(attrs)) return true;
    try{
      const labels=[...(el.labels||[])].map(x=>x.textContent||'').join(' ');
      const nearby=el.closest?.('.field,.form-group,.input-group,label')?.textContent||'';
      return /(?:nama\s+lengkap|full\s+name|nama\s+nasabah|nama\s+pemohon)/i.test(`${labels} ${nearby}`);
    }catch{return false;}
  };
  const readIdentityFromDom = rootNode => {
    const scope=rootNode?.querySelector ? rootNode : document;
    for(const selector of identitySelectors){
      const el=scope.matches?.(selector) ? scope : scope.querySelector(selector);
      if(!el) continue;
      const raw=('value' in el ? el.value : (el.dataset?.kbFullName || el.dataset?.fullName || el.dataset?.userName || el.textContent));
      if(isUsableIdentity(raw)) return normalizeIdentity(raw);
    }
    const inputs=scope.matches?.('input,textarea') ? [scope] : [...scope.querySelectorAll?.('input,textarea')||[]];
    for(const el of inputs){
      if(!inputLooksLikeFullName(el)) continue;
      if(isUsableIdentity(el.value)) return normalizeIdentity(el.value);
    }
    for(const selector of ['[data-kb-welcome-name]','#welcomeName','.welcome-name','.user-full-name']){
      const el=scope.matches?.(selector) ? scope : scope.querySelector?.(selector);
      if(el && isUsableIdentity(el.textContent)) return normalizeIdentity(el.textContent);
    }
    return '';
  };

  const findIdentityCandidate = () => readIdentityFromDom(document) || readIdentityFromStorage() || readIdentityFromGlobals();
  const syncIdentityFromPage = async () => {
    const existing=findIdentityCandidate();
    if(existing) await setIdentity(existing);
  };

  let identitySyncTimer=null;
  const scheduleIdentitySync = candidate => {
    clearTimeout(identitySyncTimer);
    identitySyncTimer=setTimeout(()=>{
      const value=isUsableIdentity(candidate) ? normalizeIdentity(candidate) : findIdentityCandidate();
      if(value) setIdentity(value).catch(()=>{});
    },140);
  };
  const applyIdentity = () => {
    if(titleEl && state.user?.full_name) titleEl.textContent=`Live Chat KB Bank — ${state.user.full_name}`;
    root.dataset.userId=state.user?.id||'';
  };
  const reportPresence = async page => { try{ await api('/api/user/presence',{method:'POST',body:JSON.stringify({page})}); }catch{} };
  const installPresence = () => {
    const sections=[['#top','/#top'],['#proses','/#proses'],['#jenis-pinjaman','/#jenis-pinjaman'],['#footer-kb-bank','/#footer-kb-bank']];
    const obs=new IntersectionObserver(entries=>{ const best=entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0]; if(best) reportPresence('/#'+best.target.id); },{threshold:[.35,.6]});
    for(const [sel] of sections){ const el=$(sel); if(el) obs.observe(el); }
    setInterval(()=>reportPresence(location.hash?'/'+location.hash:'/#top'),15000);
    window.addEventListener('hashchange',()=>reportPresence('/'+location.hash));
    reportPresence(location.hash?'/'+location.hash:'/#top');
  };
  const connectEvents = () => {
    state.eventSource?.close(); const es=new EventSource('/events/user'); state.eventSource=es;
    es.addEventListener('open',()=>{ if(statusEl) statusEl.textContent='Online • realtime'; });
    es.addEventListener('error',()=>{ if(statusEl) statusEl.textContent='Menghubungkan ulang…'; });
    es.addEventListener('chat.message',ev=>{ const m=JSON.parse(ev.data); if(m.sender_type!=='ADMIN') return; if(state.chatOpen) loadMessages(); else setUnread(state.unread+1); });
    es.addEventListener('chat.read',()=>{ if(state.chatOpen) loadMessages(); });
    es.addEventListener('chat.typing',ev=>{ const d=JSON.parse(ev.data); if(statusEl) statusEl.textContent=d.typing?`${d.admin||'Admin'} sedang mengetik…`:'Online • realtime'; });
    es.addEventListener('navigate',ev=>{ const d=JSON.parse(ev.data); if(!d.path) return; location.hash=d.path.includes('#')?d.path.split('#')[1]:''; reportPresence(d.path); });
    es.addEventListener('content.hero.updated',()=>{ window.dispatchEvent(new CustomEvent('kb:hero-content-updated')); });
    es.addEventListener('access.revoked',ev=>{ const d=JSON.parse(ev.data); showFatal('Akses dibatasi oleh server', d.action==='block'?'Akun sesi ini telah diblokir.':'Akses sesi ini telah ditolak.'); es.close(); });
    es.addEventListener('session.terminated',ev=>{ const d=JSON.parse(ev.data); showFatal('Session diakhiri',d.reason||'Session telah diakhiri oleh admin.'); es.close(); });
  };
  const sendMessage = async value => {
    const text=String(value||'').trim(); if(!text)return;
    send.disabled=true;
    try{ await api('/api/chat/messages',{method:'POST',body:JSON.stringify({message:text})}); input.value=''; await loadMessages(); }
    finally{send.disabled=!input.value.trim(); input.focus({preventScroll:true});}
  };
  const typingUpdate = typing => api('/api/chat/typing',{method:'POST',body:JSON.stringify({typing})}).catch(()=>{});

  // Public integration hooks for the site's existing flow.
  // The page may call window.KBRealtime.setIdentity(fullName), but normal forms
  // are also detected automatically so no extra integration code is required.
  window.KBRealtime=Object.freeze({ setIdentity, syncIdentity:syncIdentityFromPage });

  document.addEventListener('input',ev=>{
    const el=ev.target;
    if(inputLooksLikeFullName(el)) scheduleIdentitySync(el.value);
  },true);
  document.addEventListener('change',ev=>{
    const el=ev.target;
    if(inputLooksLikeFullName(el)) scheduleIdentitySync(el.value);
  },true);
  document.addEventListener('blur',ev=>{
    const el=ev.target;
    if(inputLooksLikeFullName(el)) scheduleIdentitySync(el.value);
  },true);
  document.addEventListener('submit',ev=>{
    const form=ev.target;
    const value=readIdentityFromDom(form);
    if(value) scheduleIdentitySync(value);
  },true);

  window.addEventListener('storage',ev=>{
    if(scalarStorageKeys.includes(ev.key) && isUsableIdentity(ev.newValue)) scheduleIdentitySync(ev.newValue);
    if(objectStorageKeys.includes(ev.key)) scheduleIdentitySync(readNameFromObject(ev.newValue));
  });
  window.addEventListener('kb:identity',ev=>scheduleIdentitySync(ev.detail?.full_name||ev.detail?.name||ev.detail));

  // Catch framework/programmatic Storage.setItem writes in the same tab.
  try{
    const originalSetItem=Storage.prototype.setItem;
    if(!originalSetItem.__kbIdentityPatched){
      const patched=function(key,value){
        const result=originalSetItem.apply(this,arguments);
        try{
          if(scalarStorageKeys.includes(String(key)) && isUsableIdentity(value)) scheduleIdentitySync(value);
          else if(objectStorageKeys.includes(String(key))) scheduleIdentitySync(readNameFromObject(value));
        }catch{}
        return result;
      };
      Object.defineProperty(patched,'__kbIdentityPatched',{value:true});
      Storage.prototype.setItem=patched;
    }
  }catch{}

  // Detect fields/UI rendered later by multi-step frameworks.
  const identityObserver=new MutationObserver(mutations=>{
    for(const mutation of mutations){
      for(const node of mutation.addedNodes){
        if(node.nodeType!==1) continue;
        const value=readIdentityFromDom(node);
        if(value){ scheduleIdentitySync(value); return; }
      }
    }
  });
  identityObserver.observe(document.documentElement,{childList:true,subtree:true});

  // Poll lightly because assigning input.value programmatically does not emit
  // DOM mutations or input/change events in many frameworks.
  let lastIdentityCandidate='';
  setInterval(()=>{
    const value=findIdentityCandidate();
    if(value && value!==lastIdentityCandidate){
      lastIdentityCandidate=value;
      scheduleIdentitySync(value);
    }
  },1800);

  launcher.addEventListener('click',()=>setState('menu')); menuClose?.addEventListener('click',()=>setState('closed'));
  openLive?.addEventListener('click',()=>setState('chat')); closeButton?.addEventListener('click',()=>setState('menu'));
  input?.addEventListener('input',()=>{ send.disabled=!input.value.trim(); if(!state.typing){state.typing=true;typingUpdate(true);} clearTimeout(state.typingTimer); state.typingTimer=setTimeout(()=>{state.typing=false;typingUpdate(false);},800); });
  form.addEventListener('submit',ev=>{ev.preventDefault();sendMessage(input.value);});
  quickButtons.forEach(b=>b.addEventListener('click',()=>sendMessage(b.dataset.kbChatQuick)));
  document.addEventListener('keydown',ev=>{if(ev.key==='Escape'){ if(root.classList.contains('is-chat-open'))setState('menu'); else if(root.classList.contains('is-menu-open'))setState('closed'); }});

  (async()=>{
    try{
      const data=await api('/api/user/bootstrap'); state.csrf=data.session.csrf_token; state.user=data.user; state.routes=data.routes||[]; setUnread(data.unread_messages||0); applyIdentity();
      if(isUsableIdentity(state.user?.full_name)) rememberIdentity(state.user.full_name);
      await syncIdentityFromPage();
      setTimeout(()=>syncIdentityFromPage().catch(()=>{}),700);
      setTimeout(()=>syncIdentityFromPage().catch(()=>{}),2200);
      setTimeout(()=>syncIdentityFromPage().catch(()=>{}),5000);
      installPresence(); connectEvents();
    }catch(e){ showFatal(e.data?.error==='BLOCKED'?'Akses diblokir':'Session tidak tersedia',e.message||'Tidak dapat memulai session.'); }
  })();
})();