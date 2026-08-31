'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');

const PORT=32177;
const BASE=`http://127.0.0.1:${PORT}`;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kb-rt-test-'));
const dbPath=path.join(tmp,'test.sqlite');
const adminEmail='super@test.local', adminPassword='StrongAdminPassword123!';
const server=spawn(process.execPath,[path.join(__dirname,'..','server.js')],{env:{...process.env,PORT:String(PORT),KB_DB_PATH:dbPath,KB_ADMIN_EMAIL:adminEmail,KB_ADMIN_PASSWORD:adminPassword,KB_TEST_MODE:'1'},stdio:['ignore','pipe','pipe']});
server.stdout.on('data',d=>process.stdout.write('[server] '+d)); server.stderr.on('data',d=>process.stderr.write('[server] '+d));

class Client{
  constructor(){this.cookies=new Map();this.csrf=''}
  cookieHeader(){return [...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ')}
  absorb(res){const arr=res.headers.getSetCookie?res.headers.getSetCookie():[];for(const raw of arr){const pair=raw.split(';',1)[0];const i=pair.indexOf('=');if(i>0)this.cookies.set(pair.slice(0,i),decodeURIComponent(pair.slice(i+1)))} }
  async req(url,opts={}){const headers={...(opts.headers||{})};if(this.cookies.size)headers.cookie=this.cookieHeader();if(opts.body&&!headers['content-type'])headers['content-type']='application/json';if(this.csrf&&opts.method&&opts.method!=='GET')headers['x-csrf-token']=this.csrf;const res=await fetch(BASE+url,{...opts,headers});this.absorb(res);let data=null;const text=await res.text();try{data=text?JSON.parse(text):null}catch{data=text}return {status:res.status,data,headers:res.headers}}
}

async function waitServer(){for(let i=0;i<50;i++){try{const r=await fetch(BASE+'/admin');if(r.status===200)return}catch{}await new Promise(r=>setTimeout(r,100))}throw new Error('server did not start')}

async function openSSE(client,url){const ctrl=new AbortController();const res=await fetch(BASE+url,{headers:{cookie:client.cookieHeader()},signal:ctrl.signal});assert.equal(res.status,200);const reader=res.body.getReader(),dec=new TextDecoder();let buf='';const queues=new Map(),waiters=new Map();
  const push=(event,data)=>{if(waiters.get(event)?.length){waiters.get(event).shift()(data);return}if(!queues.has(event))queues.set(event,[]);queues.get(event).push(data)};
  (async()=>{try{while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let cut;while((cut=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,cut);buf=buf.slice(cut+2);let event='message',data='';for(const line of block.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))data+=line.slice(5).trim()}if(data){try{push(event,JSON.parse(data))}catch{push(event,data)}}}}}catch(e){if(e.name!=='AbortError')console.error(e)}})();
  return {wait(event,ms=1500){if(queues.get(event)?.length)return Promise.resolve(queues.get(event).shift());return new Promise((resolve,reject)=>{if(!waiters.has(event))waiters.set(event,[]);const fn=d=>{clearTimeout(t);resolve(d)};waiters.get(event).push(fn);const t=setTimeout(()=>{const a=waiters.get(event)||[];const i=a.indexOf(fn);if(i>=0)a.splice(i,1);reject(new Error('timeout '+event))},ms)})},close(){ctrl.abort()}};
}

(async()=>{
  const results=[]; const ok=(name)=>{results.push(name);console.log('✓',name)};
  try{
    await waitServer();
    await fetch(BASE+'/api/test/reset',{method:'POST'});

    const A=new Client(), B=new Client(), Admin=new Client();
    let r=await A.req('/api/user/bootstrap',{method:'GET'}); assert.equal(r.status,200);A.csrf=r.data.session.csrf_token;const aId=r.data.user.id;
    r=await A.req('/api/user/identity',{method:'POST',body:JSON.stringify({full_name:'Budi Santoso'})});assert.equal(r.status,200);
    r=await B.req('/api/user/bootstrap',{method:'GET'});assert.equal(r.status,200);B.csrf=r.data.session.csrf_token;const bId=r.data.user.id;
    r=await B.req('/api/user/identity',{method:'POST',body:JSON.stringify({full_name:'Siti Rahma'})});assert.equal(r.status,200);

    r=await Admin.req('/api/admin/login',{method:'POST',body:JSON.stringify({email:adminEmail,password:adminPassword})});assert.equal(r.status,200);
    r=await Admin.req('/api/admin/me',{method:'GET'});assert.equal(r.status,200);Admin.csrf=r.data.csrf_token;
    const adminSSE=await openSSE(Admin,'/events/admin'); await adminSSE.wait('ready');

    r=await Admin.req('/api/admin/users',{method:'GET'});assert.equal(r.status,200);const ua=r.data.users.find(x=>x.id===aId),ub=r.data.users.find(x=>x.id===bId);assert.notEqual(aId,bId);ok('1. Kedua user muncul sebagai user/session terpisah');
    assert.equal(ua.full_name,'Budi Santoso');assert.equal(ub.full_name,'Siti Rahma');ok('2. Nama canonical masing-masing tetap sinkron di Admin API');

    await A.req('/api/user/presence',{method:'POST',body:JSON.stringify({page:'/#proses'})});const presA=await adminSSE.wait('presence.updated');assert.equal(presA.user_id,aId);assert.equal(presA.current_page,'/#proses');
    await B.req('/api/user/presence',{method:'POST',body:JSON.stringify({page:'/#jenis-pinjaman'})});const presB=await adminSSE.wait('presence.updated');assert.equal(presB.user_id,bId);assert.equal(presB.current_page,'/#jenis-pinjaman');
    r=await Admin.req('/api/admin/users',{method:'GET'});assert.equal(r.data.users.find(x=>x.id===aId).current_page,'/#proses');assert.equal(r.data.users.find(x=>x.id===bId).current_page,'/#jenis-pinjaman');ok('3. Current Page berubah realtime melalui Admin SSE dan tetap terpisah');

    let sendA=await A.req('/api/chat/messages',{method:'POST',body:JSON.stringify({message:'Pesan khusus User A'})});assert.equal(sendA.data.status,'DELIVERED');const liveA=await adminSSE.wait('chat.message');assert.equal(liveA.user_id,aId);
    let sendB=await B.req('/api/chat/messages',{method:'POST',body:JSON.stringify({message:'Pesan khusus User B'})});assert.equal(sendB.data.status,'DELIVERED');const liveB=await adminSSE.wait('chat.message');assert.equal(liveB.user_id,bId);
    r=await Admin.req(`/api/admin/users/${encodeURIComponent(aId)}/messages`,{method:'GET'});assert(r.data.messages.some(m=>m.body==='Pesan khusus User A'));assert(!r.data.messages.some(m=>m.body==='Pesan khusus User B'));
    r=await Admin.req(`/api/admin/users/${encodeURIComponent(bId)}/messages`,{method:'GET'});assert(r.data.messages.some(m=>m.body==='Pesan khusus User B'));assert(!r.data.messages.some(m=>m.body==='Pesan khusus User A'));ok('4. Chat realtime User A dan User B tidak tertukar');

    const sseA=await openSSE(A,'/events/user'),sseB=await openSSE(B,'/events/user');await sseA.wait('ready');await sseB.wait('ready');
    const bNoNav=sseB.wait('navigate',700).then(()=>false).catch(()=>true);
    r=await Admin.req(`/api/admin/users/${encodeURIComponent(aId)}/navigate`,{method:'POST',body:JSON.stringify({route_id:'products'})});assert.equal(r.status,200);const navA=await sseA.wait('navigate');assert.equal(navA.path,'/#jenis-pinjaman');assert.equal(await bNoNav,true);ok('5. Assist Navigation hanya dikirim ke User A, bukan User B');

    r=await Admin.req(`/api/admin/users/${encodeURIComponent(aId)}/block`,{method:'POST',body:JSON.stringify({reason:'Integration test block'})});assert.equal(r.status,200);
    r=await A.req('/api/user/bootstrap',{method:'GET'});assert.equal(r.status,403);r=await A.req('/',{method:'GET'});assert.equal(r.status,403);ok('6. User BLOCKED benar-benar ditolak backend pada API dan halaman website');
    r=await Admin.req(`/api/admin/users/${encodeURIComponent(aId)}/unblock`,{method:'POST',body:JSON.stringify({})});assert.equal(r.status,200);r=await A.req('/api/user/bootstrap',{method:'GET'});assert.equal(r.status,200);A.csrf=r.data.session.csrf_token;ok('7. Unblock memulihkan akses sesuai authentication/session policy');

    r=await Admin.req(`/api/admin/users/${encodeURIComponent(bId)}/terminate`,{method:'POST',body:JSON.stringify({reason:'Integration test terminate'})});assert.equal(r.status,200);r=await B.req('/api/user/bootstrap',{method:'GET'});assert.equal(r.status,401);assert.equal(r.data.error,'SESSION_TERMINATED');ok('8. Terminate Session benar-benar mencabut session backend');

    r=await Admin.req('/api/admin/audit',{method:'GET'});const actions=r.data.audit.map(x=>x.action);for(const a of ['ASSIST_NAVIGATION','BLOCK','UNBLOCK','TERMINATE'])assert(actions.includes(a));const blockAudit=r.data.audit.find(x=>x.action==='BLOCK');assert.equal(blockAudit.reason,'Integration test block');assert(blockAudit.admin_id);assert.equal(blockAudit.target_user_id,aId);ok('9. Semua tindakan sensitif diuji tercatat di Audit Log dengan admin/target/state/reason');

    r=await Admin.req(`/api/admin/users/${encodeURIComponent(aId)}/navigate`,{method:'POST',body:JSON.stringify({route_id:'https://example.com/evil'})});assert.equal(r.status,422);assert.equal(r.data.error,'ROUTE_NOT_ALLOWED');ok('10. Assist Navigation menolak URL/route di luar allowlist');

    r=await Admin.req('/api/admin/admins',{method:'POST',body:JSON.stringify({full_name:'Operator Test',email:'operator@test.local',role:'OPERATOR',password:'OperatorStrongPass123!'})});assert.equal(r.status,201);
    r=await Admin.req('/api/admin/admins',{method:'POST',body:JSON.stringify({full_name:'Support Test',email:'support@test.local',role:'CUSTOMER_SUPPORT',password:'SupportStrongPass123!'})});assert.equal(r.status,201);
    const Op=new Client(),CS=new Client();r=await Op.req('/api/admin/login',{method:'POST',body:JSON.stringify({email:'operator@test.local',password:'OperatorStrongPass123!'})});assert.equal(r.status,200);r=await Op.req('/api/admin/me',{method:'GET'});Op.csrf=r.data.csrf_token;r=await Op.req(`/api/admin/users/${encodeURIComponent(aId)}/block`,{method:'POST',body:JSON.stringify({reason:'must fail'})});assert.equal(r.status,403);
    r=await CS.req('/api/admin/login',{method:'POST',body:JSON.stringify({email:'support@test.local',password:'SupportStrongPass123!'})});assert.equal(r.status,200);r=await CS.req('/api/admin/me',{method:'GET'});CS.csrf=r.data.csrf_token;r=await CS.req('/api/admin/users',{method:'GET'});assert.equal(r.status,403);r=await CS.req('/api/admin/chat/users',{method:'GET'});assert.equal(r.status,200);ok('11. RBAC membatasi Operator dan Customer Support sesuai permission');

    r=await A.req('/api/chat/messages',{method:'POST',body:JSON.stringify({message:'OTP: 123456 jangan dibagikan'})});assert.equal(r.status,201);r=await Admin.req(`/api/admin/users/${encodeURIComponent(aId)}/messages`,{method:'GET'});const secretMsg=r.data.messages.find(m=>m.body.includes('OTP:'));assert(secretMsg);assert(!secretMsg.body.includes('123456'));assert(secretMsg.body.includes('[REDACTED]'));ok('12. Nilai credential berlabel sensitif pada chat direduksi sebelum tampil ke admin');

    sseA.close();sseB.close();adminSSE.close();
    console.log(`\nPASS ${results.length}/12 checks`);
  }catch(e){console.error('\nTEST FAILED:',e);process.exitCode=1}
  finally{server.kill('SIGTERM');setTimeout(()=>{try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}},250)}
})();
