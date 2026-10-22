'use strict';
const {DatabaseSync}=require('node:sqlite');
const {randomUUID,randomBytes}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const S=require('../site/dist/scheduling.js');
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||value.length>max)fail(`Invalid ${label}`);return value.trim();}
function id(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value))fail('Invalid ID');return value;}
class Store {
  constructor(filename){
    if(filename!==':memory:')fs.mkdirSync(path.dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename,{timeout:5000});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO config VALUES(1,0);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL,next_at INTEGER,once_done INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,snapshot TEXT NOT NULL,trigger TEXT NOT NULL,
        occurrence TEXT UNIQUE,status TEXT NOT NULL,created INTEGER NOT NULL,started INTEGER,finished INTEGER,
        claim_key TEXT UNIQUE,lease_until INTEGER,cancel INTEGER NOT NULL DEFAULT 0,exit_code INTEGER,detail TEXT NOT NULL DEFAULT '',event TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS run_queue ON runs(status,created);
      CREATE TABLE IF NOT EXISTS output(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,seq INTEGER NOT NULL,
        stream TEXT NOT NULL,time TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS worker(id INTEGER PRIMARY KEY CHECK(id=1),boot TEXT NOT NULL,boot_at INTEGER NOT NULL,seen INTEGER NOT NULL,hostname TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS log_files(path TEXT PRIMARY KEY,content TEXT NOT NULL,error TEXT,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS service_status(name TEXT PRIMARY KEY,seen INTEGER NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS boot_dispatch(occurrence TEXT PRIMARY KEY,run_id TEXT NOT NULL)');
  }
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  revision(){return this.db.prepare('SELECT revision FROM config').get().revision;}
  tasks(){return this.db.prepare('SELECT * FROM tasks ORDER BY rowid').all().map(row=>({...JSON.parse(row.data),nextAt:row.next_at,onceDone:!!row.once_done}));}
  task(taskId){const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);if(!row)fail('Task not found',404);return row;}
  saveConfig(body,now=Date.now()){
    if(!body||typeof body!=='object')fail('Invalid configuration');
    return this.tx(()=>{
      if(body.revision!==this.revision())fail('Configuration changed in another session. Reload and try again.',409);
      if(!Array.isArray(body.tasks)||body.tasks.length>500||!Array.isArray(body.groups)||body.groups.length>100)fail('Too many tasks or groups');
      const groupIds=new Set(),names=new Set(),taskIds=new Set();
      const colors=['green','blue','purple','amber','rose','teal','orange','slate'];
      const groups=body.groups.map(g=>{if(!g||typeof g!=='object')fail('Invalid group');const gid=id(g.id),name=text(g.name,32,'group name');if(groupIds.has(gid)||names.has(name.toLowerCase())||!colors.includes(g.color))fail('Invalid or duplicate group');groupIds.add(gid);names.add(name.toLowerCase());return {id:gid,name,color:g.color};});
      const tasks=body.tasks.map(t=>{
        if(!t||typeof t!=='object')fail('Invalid task');
        const tid=id(t.id);if(taskIds.has(tid))fail('Duplicate task');taskIds.add(tid);
        if(!['Python','JavaScript','Shell'].includes(t.language)||typeof t.enabled!=='boolean')fail('Invalid runtime or enabled state');
        if(t.groupId&&!groupIds.has(t.groupId))fail('Unknown task group');
        const old=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(tid),previous=old&&JSON.parse(old.data);
        if(!t.timing||JSON.stringify(t.timing).length>1000)fail('Invalid timing');
        try{S.validate(t.timing,new Date(now),previous?.timing.type==='once'&&previous.timing.at===t.timing.at);}catch(e){fail(e instanceof TypeError?'Invalid schedule fields':e.message);}
        const timeout=Number(t.timeout??300);if(!Number.isInteger(timeout)||timeout<1||timeout>3600)fail('Timeout must be 1–3600 seconds');
        const data={id:tid,name:text(t.name,70,'task name'),script:text(t.script,65536,'script'),language:t.language,enabled:t.enabled,groupId:t.groupId||'',timing:t.timing,timeout,
          hookToken:previous?.hookToken||randomBytes(32).toString('hex'),description:S.describe(t.timing)};
        const timingChanged=!previous||JSON.stringify(previous.timing)!==JSON.stringify(t.timing);
        const reset=timingChanged||previous.enabled!==data.enabled;
        const next=reset?(S.nextDates(data.timing,new Date(now),1)[0]?.getTime()??null):old.next_at;
        return {data,next,done:timingChanged?0:old.once_done};
      });
      for(const row of this.db.prepare('SELECT id FROM tasks').all())if(!taskIds.has(row.id))this.db.prepare('DELETE FROM tasks WHERE id=?').run(row.id);
      this.db.prepare('DELETE FROM groups').run();
      for(const g of groups)this.db.prepare('INSERT INTO groups VALUES(?,?)').run(g.id,JSON.stringify(g));
      for(const {data,next,done} of tasks){
        this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,next_at=excluded.next_at,once_done=excluded.once_done').run(data.id,JSON.stringify(data),next,done);
      }
      // Pausing/deleting a task cancels its waiting jobs. Running jobs use their saved script snapshot.
      for(const run of this.db.prepare("SELECT id,task_id FROM runs WHERE status='Queued'").all()){
        if(!tasks.some(t=>t.data.id===run.task_id&&t.data.enabled))this.db.prepare("UPDATE runs SET status='Cancelled',finished=?,detail='Task paused or removed' WHERE id=?").run(now,run.id);
      }
      this.db.prepare('UPDATE config SET revision=revision+1').run();
      return {revision:this.revision()};
    });
  }
  enqueue(taskId,trigger,occurrence=null,event={},now=Date.now()){
    const row=this.task(taskId),task=JSON.parse(row.data);
    if(!task.enabled)fail('Task is paused',409);
    if(occurrence){
      const boot=this.db.prepare('SELECT run_id FROM boot_dispatch WHERE occurrence=?').get(occurrence);if(boot)return boot.run_id;
      const previous=this.db.prepare('SELECT id FROM runs WHERE occurrence=?').get(occurrence);if(previous)return previous.id;
    }
    // One outstanding run per task prevents overlapping maintenance jobs and unbounded webhook queues.
    if(this.db.prepare("SELECT id FROM runs WHERE task_id=? AND status IN ('Queued','Running')").get(taskId))fail('This task already has a queued or running job',409);
    const runId=randomUUID();
    this.db.prepare("INSERT INTO runs(id,task_id,snapshot,trigger,occurrence,status,created,event) VALUES(?,?,?,?,?,'Queued',?,?)").run(runId,taskId,JSON.stringify(task),trigger,occurrence,now,JSON.stringify(event));
    if(occurrence?.startsWith('boot:'))this.db.prepare('INSERT INTO boot_dispatch VALUES(?,?)').run(occurrence,runId);
    return runId;
  }
  tick(now=Date.now()){
    this.tx(()=>{
      this.db.prepare("INSERT INTO service_status VALUES('scheduler',?) ON CONFLICT(name) DO UPDATE SET seen=excluded.seen").run(now);
      this.db.prepare("UPDATE runs SET status='Interrupted',finished=?,detail='Worker lease expired; outcome uncertain. Not retried.' WHERE status='Running' AND lease_until<?").run(now,now);
      const worker=this.db.prepare('SELECT * FROM worker WHERE id=1').get();
      for(const row of this.db.prepare('SELECT * FROM tasks').all()){
        const t=JSON.parse(row.data);if(!t.enabled)continue;
        if(t.timing.type==='startup'){
          if(worker&&worker.seen>now-60000&&now>=worker.boot_at+t.timing.delay*1000){
            try{this.enqueue(t.id,'Startup',`boot:${t.id}:${worker.boot}`,{},now);}catch(e){if(e.status!==409)throw e;}
          }
        } else if(row.next_at!==null&&row.next_at<=now&&!row.once_done){
          // Persist the next occurrence in the same transaction as enqueueing.
          // Skip occurrences more than 60s late rather than replaying a backlog.
          if(now-row.next_at<=60000){try{this.enqueue(t.id,'Schedule',`time:${t.id}:${row.next_at}`,{},now);}catch(e){if(e.status!==409)throw e;}}
          const next=S.nextDates(t.timing,new Date(now),1)[0]?.getTime()??null;
          this.db.prepare('UPDATE tasks SET next_at=?,once_done=? WHERE id=?').run(next,t.timing.type==='once'?1:0,t.id);
        }
      }
      // Bound terminal history by age and count; boot dispatch keys survive pruning.
      this.db.prepare('DELETE FROM runs WHERE finished<?').run(now-30*86400000);
      this.db.prepare('DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE finished IS NOT NULL ORDER BY finished DESC,rowid DESC LIMIT -1 OFFSET 1000)').run();
    });
  }
  hello(body,now=Date.now()){
    const boot=id(body.boot),hostname=text(body.hostname,120,'hostname');
    if(!Number.isFinite(body.bootAt)||body.bootAt>now+60000||body.bootAt<0)fail('Invalid boot timestamp');
    return this.tx(()=>{
      const previous=this.db.prepare('SELECT boot FROM worker WHERE id=1').get();
      if(previous&&previous.boot!==boot)this.db.prepare("UPDATE runs SET status='Cancelled',finished=?,detail='Host boot changed before startup execution' WHERE status='Queued' AND trigger='Startup'").run(now);
      this.db.prepare('INSERT INTO worker VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET boot=excluded.boot,boot_at=excluded.boot_at,seen=excluded.seen,hostname=excluded.hostname').run(boot,body.bootAt,now,hostname);
      return {ok:true};
    });
  }
  claim(key,now=Date.now()){
    id(key);
    return this.tx(()=>{
      let run=this.db.prepare('SELECT * FROM runs WHERE claim_key=?').get(key);
      if(!run){
        if(this.db.prepare("SELECT id FROM runs WHERE status='Running'").get())return null;
        run=this.db.prepare("SELECT * FROM runs WHERE status='Queued' ORDER BY created,rowid LIMIT 1").get();
        if(!run)return null;
        this.db.prepare("UPDATE runs SET status='Running',claim_key=?,started=?,lease_until=? WHERE id=?").run(key,now,now+60000,run.id);
        run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(run.id);
      }
      return {id:run.id,status:run.status,task:JSON.parse(run.snapshot),event:JSON.parse(run.event)};
    });
  }
  owned(runId,key){const row=this.db.prepare('SELECT * FROM runs WHERE id=? AND claim_key=?').get(id(runId),id(key));if(!row)fail('Unknown claim',404);return row;}
  progress(runId,body,now=Date.now()){
    return this.tx(()=>{
      const run=this.owned(runId,body.claimKey);
      if(!Array.isArray(body.entries)||body.entries.length>512)fail('Invalid output batch');
      let bytes=this.db.prepare('SELECT COALESCE(SUM(length(CAST(message AS BLOB))),0) AS size FROM output WHERE run_id=?').get(runId).size;
      for(const e of body.entries){
        if(!Number.isInteger(e.seq)||e.seq<0||!['stdout','stderr','system'].includes(e.stream)||typeof e.message!=='string'||e.message.length>8192||typeof e.time!=='string'||e.time.length>40)fail('Invalid output entry');
        if(this.db.prepare('SELECT seq FROM output WHERE run_id=? AND seq=?').get(runId,e.seq))continue;
        bytes+=Buffer.byteLength(e.message);if(bytes>2*1024*1024)fail('Run output limit exceeded',413);
        this.db.prepare('INSERT INTO output VALUES(?,?,?,?,?)').run(runId,e.seq,e.stream,e.time,e.message);
      }
      if(run.status==='Running')this.db.prepare('UPDATE runs SET lease_until=? WHERE id=?').run(now+60000,runId);
      return {cancel:!!run.cancel||run.status!=='Running',status:run.status};
    });
  }
  finish(runId,body,now=Date.now()){
    if(!['Success','Failed','Timed out','Cancelled','Interrupted'].includes(body.status)||!(body.exitCode===null||Number.isInteger(body.exitCode)))fail('Invalid completion');
    return this.tx(()=>{
      const row=this.owned(runId,body.claimKey);
      if(row.status==='Running')this.db.prepare("UPDATE runs SET status=?,exit_code=?,finished=?,lease_until=NULL,detail=? WHERE id=? AND status='Running'").run(body.status,body.exitCode,now,String(body.detail||'').slice(0,500),runId);
      return {ok:true};
    });
  }
  cancel(runId,now=Date.now()){
    return this.tx(()=>{
      const row=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id(runId));if(!row)fail('Run not found',404);
      if(row.status==='Queued')this.db.prepare("UPDATE runs SET status='Cancelled',finished=? WHERE id=? AND status='Queued'").run(now,runId);
      else if(row.status==='Running')this.db.prepare("UPDATE runs SET cancel=1 WHERE id=? AND status='Running'").run(runId);
      return {ok:true};
    });
  }
  logSnapshot(body,now=Date.now()){
    if(!Array.isArray(body.files)||body.files.length>20)fail('Invalid log catalog');
    this.tx(()=>{
      this.db.prepare('DELETE FROM log_files').run();
      for(const file of body.files){
        if(typeof file.path!=='string'||!file.path||file.path.length>200||file.path.startsWith('/')||file.path.split('/').some(p=>p==='..'||!p)||typeof file.content!=='string'||Buffer.byteLength(file.content)>270000)fail('Invalid log file');
        this.db.prepare('INSERT INTO log_files VALUES(?,?,?,?)').run(file.path,file.content,String(file.error||'').slice(0,300),now);
      }
    });
    return {ok:true};
  }
  state(){
    const now=Date.now();
    const rows=this.db.prepare('SELECT * FROM runs ORDER BY created DESC,rowid DESC LIMIT 150').all();
    const runs=rows.map(r=>{const task=JSON.parse(r.snapshot);return {id:r.id,taskId:r.task_id,name:task.name,trigger:r.trigger,status:r.status,loggedAt:new Date(r.created).toISOString(),time:new Date(r.created).toISOString(),ago:new Date(r.created).toLocaleTimeString('en-GB',{timeZone:'UTC'})+' UTC',duration:r.started?((r.finished??now)-r.started)/1000+'s':'—',exitCode:r.exit_code,detail:r.detail,real:true,cancelRequested:!!r.cancel,output:''};});
    const stats=this.db.prepare("SELECT COUNT(*) AS total,SUM(status='Success') AS success,SUM(status IN ('Failed','Timed out','Interrupted')) AS failed FROM runs WHERE created>=?").get(Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z'));
    return {revision:this.revision(),tasks:this.tasks().map(t=>{const r=runs.find(r=>r.taskId===t.id);return {...t,last:r?.time||'Never run',status:r?.status||'Never run',endpoint:`/api/hooks/${t.id}`};}),groups:this.db.prepare('SELECT data FROM groups ORDER BY rowid').all().map(r=>JSON.parse(r.data)),runs,stats,
      worker:this.db.prepare('SELECT * FROM worker WHERE id=1').get()||null,scheduler:this.db.prepare("SELECT seen FROM service_status WHERE name='scheduler'").get()||null};
  }
  runOutput(runId){id(runId);return this.db.prepare('SELECT seq,stream,time,message FROM output WHERE run_id=? ORDER BY seq').all(runId);}
  close(){this.db.close();}
}
module.exports={Store,fail,id};
