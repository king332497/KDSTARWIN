(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const state={csrf:'',admin:null,permissions:new Set(),users:[],routes:[],selectedChat:null,events:null,typingTimer:null,audio:localStorage.getItem('kb_admin_audio')==='1'};
  const views=[
    ['dashboard','Dashboard','monitor'],['users','Users','monitor'],['online','Online Users','monitor'],['chat','Live Chat','chat'],['sessions','Active Sessions','monitor'],['blocked','Blocked Users','monitor'],['activity','Activity','monitor'],['audit','Audit Log','audit'],['hero','Hero Visual','content'],['admins','Admin Management','manage_admins'],['settings','Settings',null]
  ];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=iso=>iso?new Intl.DateTimeFormat('id-ID',{dateStyle:'short',timeStyle:'medium'}).format(new Date(iso)):'—';
  const api=async(url,opts={})=>{const headers={'Content-Type':'application/json',...(opts.headers||{})};if(state.csrf&&opts.method&&opts.method!=='GET')headers['X-CSRF-Token']=state.csrf;const r=await fetch(url,{credentials:'same-origin',...opts,headers});let d={};try{d=await r.json()}catch{}if(!r.ok){const e=new Error(d.message||d.error||`HTTP ${r.status}`);e.status=r.status;e.data=d;throw e}return d};
  const can=p=>!p||state.permissions.has(p);
  const toast=(msg)=>{const n=document.createElement('div');n.className='toast';n.textContent=msg;$('#toasts').appendChild(n);setTimeout(()=>n.remove(),4200)};
  const beep=()=>{if(!state.audio)return;try{const c=new (window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.frequency.value=720;g.gain.value=.04;o.connect(g);g.connect(c.destination);o.start();o.stop(c.currentTime+.12)}catch{}};
  const statusBadge=u=>`<span class="status ${u.status==='ACTIVE'?'s-active':u.status==='BLOCKED'?'s-blocked':'s-restricted'}">${esc(u.status)}</span>`;
  const navHtml=()=>views.filter(([, ,p])=>can(p)).map(([id,label])=>`<button data-nav="${id}">${esc(label)}${id==='chat'?'<span class="badge chat-badge">0</span>':''}</button>`).join('');
  const closeMobileMore=()=>{const sheet=$('#mobileMoreSheet');if(!sheet)return;sheet.classList.remove('open');sheet.setAttribute('aria-hidden','true');};
  const openMobileMore=()=>{const sheet=$('#mobileMoreSheet');if(!sheet)return;sheet.classList.add('open');sheet.setAttribute('aria-hidden','false');};
  function setupNav(){
    const allowed=views.filter(([, ,p])=>can(p));
    $('#desktopNav').innerHTML=navHtml();
    const primaryIds=['dashboard','users','chat','settings'];
    const primary=primaryIds.map(id=>allowed.find(v=>v[0]===id)).filter(Boolean);
    $('#mobileNav').innerHTML=primary.map(([id,label])=>`<button data-nav="${id}"><span class="nav-dot"></span><span>${esc(label==='Live Chat'?'Chat':label)}</span>${id==='chat'?'<span class="badge chat-badge">0</span>':''}</button>`).join('')+`<button type="button" data-mobile-more><span class="nav-dot"></span><span>Menu</span></button>`;
    const extra=allowed.filter(([id])=>!primaryIds.includes(id));
    $('#mobileMoreList').innerHTML=extra.map(([id,label])=>`<button data-nav="${id}">${esc(label)}</button>`).join('')||'<div style="padding:8px;color:#777;font-size:.75rem">Tidak ada menu tambahan.</div>';
    $$('[data-nav]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.nav)));
    $('[data-mobile-more]')?.addEventListener('click',openMobileMore);
    $('#mobileMoreClose')?.addEventListener('click',closeMobileMore);
    $('#mobileMoreSheet')?.addEventListener('click',e=>{if(e.target.id==='mobileMoreSheet')closeMobileMore();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMobileMore();});
    const first=allowed[0]; showView(first?.[0]||'settings');
  }
  function showView(id){$$('.view').forEach(v=>v.classList.toggle('active',v.dataset.view===id));$$('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===id));const meta=views.find(v=>v[0]===id);$('#pageTitle').textContent=meta?.[1]||id;closeMobileMore();window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});if(id==='chat')loadChatUsers();if(id==='audit')loadAudit();if(id==='activity')loadActivity();if(id==='hero')loadHeroContent();if(id==='admins')loadAdmins();}
  function renderStats(s){const labels=[['online_users','User Online'],['active_sessions','Active Sessions'],['active_chats','Chat Aktif'],['unread_messages','Pesan Belum Dibaca'],['new_users','User Baru'],['blocked_users','User Diblokir']];$('#stats').innerHTML=labels.map(([k,l])=>`<div class="stat"><span>${l}</span><strong>${Number(s[k]||0)}</strong></div>`).join('');}
  function renderUsers(){
    $('#dashboardUsers').innerHTML=state.users.map(u=>`<tr><td data-label="User"><strong>${esc(u.full_name)}</strong><br><small>${esc(u.id)}</small></td><td data-label="Online" class="${u.online?'online':'offline'}">${u.online?'Online':'Offline'}</td><td data-label="Halaman">${esc(u.current_page)}</td><td data-label="Progress"><div class="progress"><i style="width:${Number(u.progress)||0}%"></i></div></td><td data-label="Status">${statusBadge(u)}</td><td data-label="Session">${esc(u.session_id||'—')}</td></tr>`).join('');
    $('#usersTable').innerHTML=state.users.map(u=>`<tr><td data-label="Nama"><strong>${esc(u.full_name)}</strong></td><td data-label="User / Session"><small>${esc(u.id)}</small><br><small>${esc(u.session_id||'—')}</small></td><td data-label="Online" class="${u.online?'online':'offline'}">${u.online?'Online':'Offline'}</td><td data-label="Halaman">${esc(u.current_page)}</td><td data-label="Aktivitas">${fmt(u.last_activity)}</td><td data-label="Progress">${u.progress}%</td><td data-label="Akses">${statusBadge(u)}<br><small>${esc(u.access_state)}</small></td><td data-label="Live Chat">${esc(u.chat_status)}${u.unread_messages?` • ${u.unread_messages} unread`:''}</td><td data-label="Aksi"><div class="actions">${userActions(u)}</div></td></tr>`).join('');
    $('#onlineCards').innerHTML=cards(state.users.filter(u=>u.online),u=>`${u.current_page} • ${u.progress}%`);
    $('#sessionCards').innerHTML=cards(state.users.filter(u=>u.session_id),u=>`Session: ${u.session_id}<br>Page: ${u.current_page}`, true);
    $('#blockedCards').innerHTML=cards(state.users.filter(u=>u.status==='BLOCKED'),u=>`Alasan: ${u.blocked_reason||'—'}`, false, true);
    bindUserActions(); updateChatBadge();
  }
  function cards(list,detail,session=false,blocked=false){if(!list.length)return'<div class="list-card"><strong>Tidak ada data.</strong></div>';return list.map(u=>`<div class="list-card"><strong>${esc(u.full_name)}</strong><p>${detail(u)}</p><div class="actions" style="margin-top:10px">${session&&can('terminate')?`<button class="danger" data-action="terminate" data-user="${u.id}">Akhiri Session</button>`:''}${blocked&&can('unblock')?`<button class="secondary" data-action="unblock" data-user="${u.id}">Buka Blokir</button>`:''}</div></div>`).join('')}
  function userActions(u){let h='';if(can('navigate'))h+=`<button class="secondary" data-action="navigate" data-user="${u.id}">Pindahkan</button>`;if(can('allow'))h+=`<button class="ghost" data-action="allow" data-user="${u.id}">Izinkan</button>`;if(can('restrict'))h+=`<button class="ghost" data-action="restrict" data-user="${u.id}">Batasi</button>`;if(can('deny'))h+=`<button class="danger" data-action="deny" data-user="${u.id}">Tolak</button>`;if(u.status!=='BLOCKED'&&can('block'))h+=`<button class="danger" data-action="block" data-user="${u.id}">Blokir</button>`;if(u.status==='BLOCKED'&&can('unblock'))h+=`<button class="secondary" data-action="unblock" data-user="${u.id}">Unblock</button>`;if(can('terminate'))h+=`<button class="danger" data-action="terminate" data-user="${u.id}">Akhiri</button>`;return h||'—'}
  function modal({title,body,confirm='Konfirmasi',danger=false}){return new Promise(resolve=>{const root=$('#modalRoot');root.innerHTML=`<div class="modal"><form class="modal-card"><h3>${esc(title)}</h3>${body}<div class="modal-actions"><button type="button" class="secondary" data-cancel>Batal</button><button class="${danger?'danger':'primary'}" data-ok>${esc(confirm)}</button></div></form></div>`;const m=$('.modal',root),f=$('form',m);$('[data-cancel]',m).onclick=()=>{root.innerHTML='';resolve(null)};f.onsubmit=e=>{e.preventDefault();const data=Object.fromEntries(new FormData(f).entries());root.innerHTML='';resolve(data)}})}
  async function action(userId,act){const u=state.users.find(x=>x.id===userId);if(!u)return;if(act==='navigate'){const data=await modal({title:`Pindahkan ${u.full_name}`,body:`<div class="field"><label>Halaman</label><select name="route_id">${state.routes.map(r=>`<option value="${r.id}">${esc(r.label)} — ${esc(r.path)}</option>`).join('')}</select></div>`,confirm:'Kirim'});if(!data)return;await api(`/api/admin/users/${encodeURIComponent(userId)}/navigate`,{method:'POST',body:JSON.stringify(data)});toast(`Assist Navigation dikirim ke ${u.full_name}`);return}
    const titles={block:'Blokir User',terminate:'Akhiri Session',deny:'Tolak Akses',allow:'Izinkan User',restrict:'Batasi User',unblock:'Buka Blokir'};let body=`<p style="color:#666;line-height:1.55">Target: <strong>${esc(u.full_name)}</strong></p>`;if(act==='block')body+=`<div class="field"><label>Alasan pemblokiran (wajib)</label><textarea name="reason" required minlength="3"></textarea></div>`;else if(['terminate','deny'].includes(act))body+=`<div class="field"><label>Alasan</label><textarea name="reason"></textarea></div>`;const data=await modal({title:titles[act]||act,body,confirm:titles[act]||'Konfirmasi',danger:['block','terminate','deny'].includes(act)});if(!data)return;await api(`/api/admin/users/${encodeURIComponent(userId)}/${act}`,{method:'POST',body:JSON.stringify(data)});toast(`${titles[act]||act}: ${u.full_name}`);await refreshAll()}
  function bindUserActions(){$$('[data-action]').forEach(b=>b.onclick=()=>action(b.dataset.user,b.dataset.action).catch(e=>toast(`Gagal: ${e.message}`)))}
  async function refreshAll(){if(can('monitor')){const [d,u,r]=await Promise.all([api('/api/admin/dashboard'),api('/api/admin/users'),can('navigate')?api('/api/admin/routes'):Promise.resolve({routes:[]})]);state.users=u.users||[];state.routes=r.routes||[];renderStats(d.stats||{});renderUsers();renderRouteList()}if(can('chat'))loadChatUsers().catch(()=>{})}
  function renderRouteList(){const el=$('#routeList');if(el)el.innerHTML=(state.routes.length?state.routes.map(r=>`<div>${esc(r.label)} <code>${esc(r.path)}</code></div>`).join(''):'Tidak tersedia untuk role ini.')}
  async function loadChatUsers(){const d=await api('/api/admin/chat/users');const list=d.users||[];$('#chatUsers').innerHTML=list.length?list.map(u=>`<button class="chat-user ${state.selectedChat===u.id?'active':''}" data-chat-user="${u.id}"><span><strong>${esc(u.full_name)}</strong><small>${u.online?' • Online':' • Offline'}</small></span>${u.unread_messages?`<b>${u.unread_messages}</b>`:''}</button>`).join(''):'<div style="padding:16px;color:#777;font-size:.78rem">Belum ada percakapan.</div>';$$('[data-chat-user]').forEach(b=>b.onclick=()=>selectChat(b.dataset.chatUser));updateChatBadge(list)}
  function updateChatBadge(list=null){const n=(list||state.users).reduce((a,u)=>a+Number(u.unread_messages||0),0);$$('.chat-badge').forEach(b=>{b.textContent=n;b.style.display=n?'grid':'none'})}
  async function selectChat(uid){state.selectedChat=uid;await loadChatUsers();const d=await api(`/api/admin/users/${encodeURIComponent(uid)}/messages`);$('#chatTitle').textContent=d.user?.full_name||uid;$('#chatInput').disabled=false;$('#chatSend').disabled=false;renderChat(d.messages||[])}
  function renderChat(rows){const el=$('#chatMessages');el.innerHTML=rows.map(m=>`<div class="msg ${m.sender_type==='ADMIN'?'admin':''}">${esc(m.body)}<small>${esc(m.sender_name)} • ${fmt(m.created_at)} • ${esc(m.status)}</small></div>`).join('');el.scrollTop=el.scrollHeight}
  async function sendChat(){if(!state.selectedChat)return;const input=$('#chatInput'),message=input.value.trim();if(!message)return;await api(`/api/admin/users/${encodeURIComponent(state.selectedChat)}/messages`,{method:'POST',body:JSON.stringify({message})});input.value='';await selectChat(state.selectedChat)}
  async function loadAudit(){if(!can('audit'))return;const d=await api('/api/admin/audit');$('#auditLog').innerHTML=(d.audit||[]).map(x=>`<div class="log-item"><time>${fmt(x.created_at)}</time><div><strong>${esc(x.action)}</strong> — ${esc(x.admin_name)} → ${esc(x.target_name||x.target_user_id||'system')}<br><small>Alasan: ${esc(x.reason||'—')}</small></div><span>${esc(x.new_state?.status||'')}</span></div>`).join('')||'<div class="log-item">Belum ada audit log.</div>'}
  async function loadActivity(){if(!can('monitor'))return;const d=await api('/api/admin/activity');$('#activityLog').innerHTML=(d.activity||[]).map(x=>`<div class="log-item"><time>${fmt(x.created_at)}</time><div><strong>${esc(x.full_name)}</strong> — ${esc(x.type)}<br><small>${esc(x.detail||'')}</small></div><span>${esc(x.session_id||'')}</span></div>`).join('')||'<div class="log-item">Belum ada activity.</div>'}
  async function loadAdmins(){if(!can('manage_admins'))return;const d=await api('/api/admin/admins');$('#adminCards').innerHTML=(d.admins||[]).map(a=>`<div class="list-card"><strong>${esc(a.full_name)}</strong><p>${esc(a.email)}<br>${esc(a.role)}</p></div>`).join('')}
  let heroPendingImages=[];
  let heroLoaded=null;
  let heroPreviewTimer=null;
  let heroPreviewIndex=0;

  function heroFormPayload(extra={}) {
    return {
      chip_one_title:$('#heroChipOneTitle')?.value.trim()||'',
      chip_one_subtitle:$('#heroChipOneSubtitle')?.value.trim()||'',
      chip_two_title:$('#heroChipTwoTitle')?.value.trim()||'',
      chip_two_subtitle:$('#heroChipTwoSubtitle')?.value.trim()||'',
      caption:$('#heroCaption')?.value.trim()||'',
      image_alt:$('#heroImageAlt')?.value.trim()||'',
      ...extra
    };
  }

  function setHeroPreview(sources) {
    const img=$('#heroAdminPreview'), empty=$('#heroAdminEmpty'), thumbs=$('#heroAdminThumbs');
    if(!img||!empty)return;
    clearInterval(heroPreviewTimer); heroPreviewTimer=null; heroPreviewIndex=0;
    const list=(Array.isArray(sources)?sources:[sources]).filter(Boolean);
    if(!list.length){
      img.removeAttribute('src'); img.hidden=true; empty.hidden=false; if(thumbs)thumbs.innerHTML=''; return;
    }
    empty.hidden=true; img.hidden=false;
    const show=i=>{ heroPreviewIndex=i%list.length; img.style.opacity='0'; setTimeout(()=>{img.src=list[heroPreviewIndex];img.style.opacity='1'},120); if(thumbs)[...thumbs.children].forEach((x,n)=>x.classList.toggle('active',n===heroPreviewIndex)); };
    if(thumbs){
      thumbs.innerHTML=list.map((src,i)=>`<img class="hero-editor-thumb ${i===0?'active':''}" data-hero-thumb="${i}" src="${src}" alt="Preview ${i+1}">`).join('');
      thumbs.querySelectorAll('[data-hero-thumb]').forEach(t=>t.onclick=()=>show(Number(t.dataset.heroThumb)));
    }
    show(0);
    if(list.length>1) heroPreviewTimer=setInterval(()=>show((heroPreviewIndex+1)%list.length),2600);
  }

  async function loadHeroContent(){
    if(!can('content'))return;
    const stateEl=$('#heroSaveState');
    if(stateEl)stateEl.textContent='Memuat konfigurasi…';
    try{
      const d=await api('/api/admin/content/hero');
      const h=d.hero||{};
      heroLoaded=h;
      $('#heroChipOneTitle').value=h.chip_one_title||'';
      $('#heroChipOneSubtitle').value=h.chip_one_subtitle||'';
      $('#heroChipTwoTitle').value=h.chip_two_title||'';
      $('#heroChipTwoSubtitle').value=h.chip_two_subtitle||'';
      $('#heroCaption').value=h.caption||'';
      $('#heroImageAlt').value=h.image_alt||'';
      heroPendingImages=[];
      if($('#heroImageFile'))$('#heroImageFile').value='';
      setHeroPreview(h.image_urls?.length?h.image_urls:(h.image_url?[h.image_url]:[]));
      if(stateEl)stateEl.textContent=h.updated_at?`Terakhir disimpan ${fmt(h.updated_at)}`:'Menggunakan konfigurasi bawaan.';
    }catch(e){
      if(stateEl)stateEl.textContent=`Gagal memuat: ${e.message}`;
    }
  }

  const dataUrlBytes = dataUrl => {
    const base64=String(dataUrl||'').split(',')[1]||'';
    const padding=(base64.match(/=*$/)||[''])[0].length;
    return Math.max(0,Math.floor(base64.length*3/4)-padding);
  };

  async function optimizeHeroImage(file){
    if(!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Pilih PNG, JPG, atau WebP.');
    if(file.size>10*1024*1024) throw new Error('File sumber maksimal 10 MB.');
    const bitmap=await createImageBitmap(file);
    const maxSide=1400;
    const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
    const width=Math.max(1,Math.round(bitmap.width*scale));
    const height=Math.max(1,Math.round(bitmap.height*scale));
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{alpha:true});
    ctx.drawImage(bitmap,0,0,width,height);
    bitmap.close?.();
    for(const quality of [.86,.78,.70,.62,.54,.46]){
      const data=canvas.toDataURL('image/webp',quality);
      if(dataUrlBytes(data)<=410*1024) return data;
    }
    throw new Error('Gambar masih terlalu besar setelah optimasi. Gunakan gambar yang lebih kecil.');
  }

  async function saveHeroContent({removeImage=false}={}){
    const stateEl=$('#heroSaveState'), save=$('#heroSave');
    if(save)save.disabled=true;
    if(stateEl)stateEl.textContent='Menyimpan…';
    try{
      let staged=null;
      if(heroPendingImages.length){
        const uploadId=(crypto.randomUUID?.()||`${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g,'_');
        const mimes=[];
        for(let i=0;i<heroPendingImages.length;i++){
          if(stateEl)stateEl.textContent=`Mengunggah gambar ${i+1} dari ${heroPendingImages.length}…`;
          const uploaded=await api('/api/admin/content/hero/image-stage',{
            method:'PUT',
            body:JSON.stringify({upload_id:uploadId,slot:i,image_data:heroPendingImages[i]})
          });
          mimes.push(uploaded.mime);
        }
        staged={upload_id:uploadId,image_count:heroPendingImages.length,image_mimes:mimes};
      }
      if(stateEl)stateEl.textContent='Menerapkan Hero Visual…';
      const body=heroFormPayload({
        ...(staged||{}),
        ...(removeImage?{remove_image:true}:{})
      });
      const d=await api('/api/admin/content/hero',{method:'PUT',body:JSON.stringify(body)});
      heroPendingImages=[];
      heroLoaded=d.hero||heroLoaded;
      if($('#heroImageFile'))$('#heroImageFile').value='';
      setHeroPreview(d.hero?.image_urls?.length?d.hero.image_urls:(d.hero?.image_url?[d.hero.image_url]:[]));
      if(stateEl)stateEl.textContent=`Tersimpan ${fmt(d.hero?.updated_at)}`;
      toast('Hero Visual berhasil diperbarui');
    }catch(e){
      if(stateEl)stateEl.textContent=`Gagal: ${e.message}`;
      toast(`Gagal menyimpan Hero: ${e.message}`);
    }finally{
      if(save)save.disabled=false;
    }
  }

  function connectEvents(){state.events?.close();const es=new EventSource('/events/admin');state.events=es;es.addEventListener('chat.message',ev=>{const m=JSON.parse(ev.data);if(m.sender_type==='USER'){toast(`Pesan baru dari ${m.sender_name}`);beep()}if(state.selectedChat===m.user_id)selectChat(m.user_id).catch(()=>{});refreshAll().catch(()=>{})});es.addEventListener('chat.typing',ev=>{const d=JSON.parse(ev.data);if(state.selectedChat===d.user_id){$('#typingText').textContent=d.typing?'User sedang mengetik…':'';clearTimeout(state.typingTimer);state.typingTimer=setTimeout(()=>$('#typingText').textContent='',1800)}});['presence.updated','user.updated','user.created','session.started'].forEach(e=>es.addEventListener(e,()=>refreshAll().catch(()=>{})));es.addEventListener('content.hero.updated',()=>{if($('.view[data-view="hero"]')?.classList.contains('active'))loadHeroContent().catch(()=>{});})}
  async function boot(){try{const d=await api('/api/admin/me');state.admin=d.admin;state.csrf=d.csrf_token;state.permissions=new Set(d.permissions||[]);$('#loginView').classList.add('hidden');$('#app').classList.remove('hidden');$('#adminName').textContent=state.admin.full_name;$('#adminRole').textContent=state.admin.role;setupNav();$('#audioToggle').checked=state.audio;await refreshAll();connectEvents()}catch{}}
  $('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';const body=Object.fromEntries(new FormData(e.currentTarget).entries());try{await api('/api/admin/login',{method:'POST',body:JSON.stringify(body)});await boot()}catch(err){$('#loginError').textContent=err.message}});
  $('#chatForm').addEventListener('submit',e=>{e.preventDefault();sendChat().catch(err=>toast(err.message))});
  $('#chatInput').addEventListener('input',()=>{if(!state.selectedChat)return;api(`/api/admin/users/${encodeURIComponent(state.selectedChat)}/typing`,{method:'POST',body:JSON.stringify({typing:true})}).catch(()=>{});clearTimeout(state.typingTimer);state.typingTimer=setTimeout(()=>api(`/api/admin/users/${encodeURIComponent(state.selectedChat)}/typing`,{method:'POST',body:JSON.stringify({typing:false})}).catch(()=>{}),750)});
  $('#audioToggle').addEventListener('change',e=>{state.audio=e.target.checked;localStorage.setItem('kb_admin_audio',state.audio?'1':'0');toast(`Audio notification ${state.audio?'aktif':'nonaktif'}`)});
  $('#adminCreate').addEventListener('submit',async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget).entries());try{await api('/api/admin/admins',{method:'POST',body:JSON.stringify(body)});e.currentTarget.reset();toast('Admin ditambahkan');loadAdmins()}catch(err){toast(`Gagal: ${err.message}`)}});
  $('#heroContentForm')?.addEventListener('submit',e=>{e.preventDefault();saveHeroContent().catch(err=>toast(err.message))});
  $('#heroReload')?.addEventListener('click',()=>loadHeroContent().catch(err=>toast(err.message)));
  $('#heroResetImage')?.addEventListener('click',()=>saveHeroContent({removeImage:true}).catch(err=>toast(err.message)));
  $('#heroImageFile')?.addEventListener('change',async e=>{
    const files=[...(e.target.files||[])];
    if(!files.length)return;
    const stateEl=$('#heroSaveState');
    try{
      if(files.length>5) throw new Error('Maksimal 5 gambar.');
      if(stateEl)stateEl.textContent=`Mengoptimalkan ${files.length} gambar…`;
      const optimized=[];
      for(let i=0;i<files.length;i++){
        if(stateEl)stateEl.textContent=`Mengoptimalkan gambar ${i+1}/${files.length}…`;
        optimized.push(await optimizeHeroImage(files[i]));
      }
      heroPendingImages=optimized;
      setHeroPreview(heroPendingImages);
      const total=heroPendingImages.reduce((n,x)=>n+dataUrlBytes(x),0);
      if(stateEl)stateEl.textContent=`${heroPendingImages.length} gambar siap disimpan • ${Math.round(total/1024)} KB`;
    }catch(err){
      e.target.value='';
      heroPendingImages=[];
      if(stateEl)stateEl.textContent=`Gagal: ${err.message}`;
      toast(err.message);
    }
  });
  $$('[data-refresh]').forEach(b=>b.onclick=()=>refreshAll().catch(e=>toast(e.message)));
  boot();
})();
