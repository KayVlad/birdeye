const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store}=require('../store.cjs');
const {createServer}=require('../server.cjs');
const now=Date.parse('2026-09-23T12:00:00Z');
const task=(extra={})=>({id:'check',name:'Health check',language:'Python',script:'print("hello")',enabled:true,groupId:'',timeout:5,timing:{type:'request'},...extra});
function setup(t,tasks=[task()]){const store=new Store(':memory:');t.after(()=>store.close());store.saveConfig({revision:0,tasks,groups:[]},now);return store;}

test('configuration validates server-side and rejects stale revisions atomically',t=>{
  const s=setup(t);
  assert.throws(()=>s.saveConfig({revision:0,tasks:[],groups:[]}),/another session/);
  assert.throws(()=>s.saveConfig({revision:1,tasks:[task({script:''})],groups:[]}),/script/);
  assert.throws(()=>s.saveConfig({revision:1,tasks:[task({timing:{type:'cron',expression:'* * * * nope'}})],groups:[]}),/numbers/);
  assert.equal(s.tasks().length,1);assert.equal(s.revision(),1);
});
test('claim is idempotent, script snapshots survive edits, active jobs do not overlap',t=>{
  const s=setup(t);const run=s.tx(()=>s.enqueue('check','Manual',null,{},now));
  assert.throws(()=>s.tx(()=>s.enqueue('check','Manual')),/already/);
  const first=s.claim('claim-1',now);assert.equal(first.id,run);
  assert.equal(s.claim('claim-1',now).id,run);assert.equal(s.claim('claim-2',now),null);
  s.saveConfig({revision:1,tasks:[task({script:'print("changed")'})],groups:[]},now);
  assert.equal(s.claim('claim-1').task.script,'print("hello")');
});
test('one-off dispatch and completion survive database restart',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'birdeye-db-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'app.db');let s=new Store(file);
  s.saveConfig({revision:0,tasks:[task({timing:{type:'once',at:'2026-09-23T12:01'}})],groups:[]},now);
  s.tick(now+60000);const run=s.claim('once-claim',now+60000);
  s.finish(run.id,{claimKey:'once-claim',status:'Success',exitCode:0},now+60001);s.close();
  s=new Store(file);try{s.tick(now+62000);assert.equal(s.state().runs.length,1);assert.equal(s.tasks()[0].onceDone,true);}finally{s.close();}
});
test('late schedules skip backlog; repeating schedules retain anchors',t=>{
  const s=setup(t,[task({timing:{type:'repeat',mode:'interval',every:1,unit:'minutes',start:'2026-09-23T12:01'}})]);
  s.tick(now+10*60000);assert.equal(s.state().runs.length,0);assert.equal(s.tasks()[0].nextAt,now+11*60000);
  s.tick(now+11*60000);assert.equal(s.state().runs.length,1);s.tick(now+11*60000);assert.equal(s.state().runs.length,1);
});
test('startup deduplicates by host boot across service restarts and retention pruning',t=>{
  const s=setup(t,[task({timing:{type:'startup',delay:30}})]);
  s.hello({boot:'boot-one',hostname:'host',bootAt:now},now);s.tick(now+29000);assert.equal(s.state().runs.length,0);
  s.tick(now+30000);const r=s.claim('boot-claim',now+30000);s.finish(r.id,{claimKey:'boot-claim',status:'Success',exitCode:0},now+31000);
  const later=now+31*86400000;s.hello({boot:'boot-one',hostname:'host',bootAt:now},later);s.tick(later);s.tick(later+1);assert.equal(s.state().runs.length,0);
  s.hello({boot:'boot-two',hostname:'host',bootAt:later},later);s.tick(later+30000);assert.equal(s.state().runs.length,1);
});
test('expired lease is interrupted, never requeued; late completion does not invent success',t=>{
  const s=setup(t);s.enqueue('check','Manual',null,{},now);const r=s.claim('claim',now);
  s.tick(now+61000);assert.equal(s.state().runs[0].status,'Interrupted');assert.equal(s.claim('new',now+61000),null);
  assert.equal(s.progress(r.id,{claimKey:'claim',entries:[]},now+62000).cancel,true);
  s.finish(r.id,{claimKey:'claim',status:'Success',exitCode:0});assert.equal(s.state().runs[0].status,'Interrupted');
});
test('a new host boot cancels startup jobs waiting from an earlier boot',t=>{
  const s=setup(t,[task({timing:{type:'startup',delay:0}})]);
  s.hello({boot:'first',hostname:'host',bootAt:now},now);s.tick(now);
  s.hello({boot:'second',hostname:'host',bootAt:now+1000},now+1000);s.tick(now+1000);
  assert.deepEqual(s.state().runs.map(r=>r.status).sort(),['Cancelled','Queued']);
  assert.equal(s.claim('new-boot',now+1000).status,'Running');
});
test('output retries deduplicate, streams and sequence preserved, wrong claims denied',t=>{
  const s=setup(t);s.enqueue('check','Manual');const r=s.claim('claim');
  const entries=[{seq:0,stream:'stdout',time:'2026-09-23T12:00:00Z',message:'hello\n'},{seq:1,stream:'stderr',time:'2026-09-23T12:00:01Z',message:'warning\n'}];
  s.progress(r.id,{claimKey:'claim',entries});s.progress(r.id,{claimKey:'claim',entries});assert.equal(s.runOutput(r.id).length,2);
  assert.throws(()=>s.progress(r.id,{claimKey:'wrong',entries}),/Unknown claim/);
  s.cancel(r.id);assert.equal(s.progress(r.id,{claimKey:'claim',entries:[]}).cancel,true);
});
test('pause cancels queued jobs and group deletion preserves tasks',t=>{
  const s=setup(t);s.enqueue('check','Manual');s.saveConfig({revision:1,tasks:[task({enabled:false})],groups:[]},now);
  assert.equal(s.state().runs[0].status,'Cancelled');assert.equal(s.tasks().length,1);assert.equal(s.claim('claim'),null);
});
test('HTTP authentication separates admins, workers and per-task webhook tokens',async t=>{
  const s=setup(t);const server=createServer(s,{adminToken:'a'.repeat(64),workerToken:'w'.repeat(64)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(url,token,method='GET',body)=>fetch(base+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert.equal((await request('/api/state','')).status,401);
  assert.equal((await request('/api/state','w'.repeat(64))).status,401);
  assert.equal((await request('/api/worker/claim','a'.repeat(64),'POST',{claimKey:'x'})).status,401);
  assert.equal((await request('/api/state','a'.repeat(64))).status,200);
  assert.equal((await request('/api/hooks/check','bad','POST',{})).status,401);
  const hook=s.tasks()[0].hookToken;
  const accepted=await request('/api/hooks/check',hook,'POST',{hello:'world'});assert.equal(accepted.status,202);
  assert.equal((await request('/api/hooks/check',hook,'POST',{})).status,409);
  const run=await (await request('/api/worker/claim','w'.repeat(64),'POST',{claimKey:'http-claim'})).json();
  assert.deepEqual(run.run.event,{hello:'world'});
  assert.equal((await request('/api/state',hook)).status,401);
  assert.equal((await request('/worker/worker.py','a'.repeat(64))).status,404);
});
