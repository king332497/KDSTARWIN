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
  // Identity is synchronized silently from an existing real name field.
  // No modal is shown on the landing page. Other pages can call
  // window.KBRealtime.setIdentity(fullName) after their own verified name step.
  const setIdentity = async fullName => {
    const normalized=String(fullName||'').replace(/\s+/g,' ').trim();
    if(normalized.length<3) return null;
    if(state.user?.full_name===normalized) return state.user;
    const data=await api('/api/user/identity',{method:'POST',body:JSON.stringify({full_name:normalized})});
    state.user={...state.user,...data};
    applyIdentity();
    return state.user;
  };

  const readExistingIdentity = () => {
    const selectors=['[data-kb-full-name]','input[name="full_name"]','input[name="nama_lengkap"]','#fullName','#namaLengkap','#resultName'];
    for(const selector of selectors){
      const el=$(selector);
      if(!el) continue;
      const raw=('value' in el ? el.value : el.textContent);
      const value=String(raw||'').replace(/\s+/g,' ').trim();
      if(value.length>=3 && !/^(pengguna|user|nama lengkap)$/i.test(value)) return value;
    }
    return '';
  };

  const syncIdentityFromPage = async () => {
    const existing=readExistingIdentity();
    if(existing) await setIdentity(existing);
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

  // Public integration hook for the existing website flow.
  // Example after the site's own name form succeeds:
  // window.KBRealtime.setIdentity('Budi Santoso');
  window.KBRealtime=Object.freeze({ setIdentity });

  document.addEventListener('change',ev=>{
    const el=ev.target;
    if(!el?.matches?.('[data-kb-full-name],input[name="full_name"],input[name="nama_lengkap"],#fullName,#namaLengkap')) return;
    setIdentity(el.value).catch(()=>{});
  });

  launcher.addEventListener('click',()=>setState('menu')); menuClose?.addEventListener('click',()=>setState('closed'));
  openLive?.addEventListener('click',()=>setState('chat')); closeButton?.addEventListener('click',()=>setState('menu'));
  input?.addEventListener('input',()=>{ send.disabled=!input.value.trim(); if(!state.typing){state.typing=true;typingUpdate(true);} clearTimeout(state.typingTimer); state.typingTimer=setTimeout(()=>{state.typing=false;typingUpdate(false);},800); });
  form.addEventListener('submit',ev=>{ev.preventDefault();sendMessage(input.value);});
  quickButtons.forEach(b=>b.addEventListener('click',()=>sendMessage(b.dataset.kbChatQuick)));
  document.addEventListener('keydown',ev=>{if(ev.key==='Escape'){ if(root.classList.contains('is-chat-open'))setState('menu'); else if(root.classList.contains('is-menu-open'))setState('closed'); }});

  (async()=>{
    try{
      const data=await api('/api/user/bootstrap'); state.csrf=data.session.csrf_token; state.user=data.user; state.routes=data.routes||[]; setUnread(data.unread_messages||0); applyIdentity();
      await syncIdentityFromPage(); installPresence(); connectEvents();
    }catch(e){ showFatal(e.data?.error==='BLOCKED'?'Akses diblokir':'Session tidak tersedia',e.message||'Tidak dapat memulai session.'); }
  })();
})();