'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {timingSafeEqual}=require('node:crypto');
const {Store,fail}=require('./store.cjs');
function secret(name){const value=(process.env[name+'_FILE']?fs.readFileSync(process.env[name+'_FILE'],'utf8'):process.env[name]||'').trim();if(value.length<32)throw new Error(`${name} must contain at least 32 characters`);return value;}
function equal(a,b){return typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function json(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>6*1024*1024)fail('Request too large',413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{fail('Invalid JSON');}if(!value||typeof value!=='object'||Array.isArray(value))fail('Use a JSON object');return value;}
function createServer(store,{adminToken,workerToken,staticDir=path.resolve(__dirname,'../site/dist')}={}){
  if(!adminToken||!workerToken||adminToken===workerToken)throw new Error('Distinct admin and worker tokens are required');
  const server=http.createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
    try{
      const url=new URL(req.url,'http://localhost'),route=url.pathname,method=req.method;
      if(method==='GET'&&route==='/healthz')return send(200,{ok:true});
      if(route.startsWith('/api/')){
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(route.startsWith('/api/hooks/')){
          if(method!=='POST')fail('Use POST',405);
          const task=JSON.parse(store.task(route.slice('/api/hooks/'.length)).data);
          if(!equal(token,task.hookToken))fail('Unauthorized',401);
          if(task.timing.type!=='request')fail('Not a request-triggered task',409);
          const event=await json(req);if(Buffer.byteLength(JSON.stringify(event))>65536)fail('Webhook payload too large',413);
          return send(202,{id:store.tx(()=>store.enqueue(task.id,'Request',null,event))});
        }
        if(route.startsWith('/api/worker/')){
          if(!equal(token,workerToken))fail('Unauthorized',401);
          if(method!=='POST')fail('Use POST',405);
          const body=await json(req);
          if(route==='/api/worker/hello')return send(200,store.hello(body));
          if(route==='/api/worker/claim')return send(200,{run:store.claim(body.claimKey)});
          if(route==='/api/worker/logs')return send(200,store.logSnapshot(body));
          const match=route.match(/^\/api\/worker\/runs\/([\w-]+)\/(progress|finish)$/);
          if(match)return send(200,store[match[2]](match[1],body));
          fail('Not found',404);
        }
        if(!equal(token,adminToken))fail('Unauthorized',401);
        if(route==='/api/state'&&method==='GET')return send(200,store.state());
        if(route==='/api/config'&&method==='PUT')return send(200,store.saveConfig(await json(req)));
        if(route==='/api/logs'&&method==='GET')return send(200,{files:store.db.prepare('SELECT * FROM log_files ORDER BY path').all()});
        if(route==='/api/task-logs'&&method==='GET')return send(200,{entries:store.db.prepare("SELECT o.*,r.task_id,json_extract(r.snapshot,'$.name') AS task FROM output o JOIN runs r ON r.id=o.run_id ORDER BY r.created DESC,o.seq DESC LIMIT 300").all().reverse()});
        const run=route.match(/^\/api\/tasks\/([\w-]+)\/run$/);
        if(run&&method==='POST')return send(202,{id:store.tx(()=>store.enqueue(run[1],'Manual'))});
        const output=route.match(/^\/api\/runs\/([\w-]+)\/output$/);
        if(output&&method==='GET')return send(200,{entries:store.runOutput(output[1])});
        const cancel=route.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
        if(cancel&&method==='POST')return send(200,store.cancel(cancel[1]));
        fail('Not found',404);
      }
      if(method!=='GET'&&method!=='HEAD')fail('Method not allowed',405);
      // Serve only frontend assets, never paths supplied by a task or worker.
      const asset=route==='/'?'index.html':route.slice(1);
      if(!/^[a-zA-Z0-9_-]+\.(html|js|css)$/.test(asset))fail('Not found',404);
      const filename=path.join(staticDir,asset);if(!fs.existsSync(filename))fail('Not found',404);
      res.writeHead(200,{'Content-Type':{html:'text/html',js:'text/javascript',css:'text/css'}[asset.split('.').pop()]+'; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      if(method==='HEAD')res.end();else fs.createReadStream(filename).pipe(res);
    }catch(e){if(!e.status)console.error('Request failed:',e.message);if(!res.headersSent)send(e.status||500,{error:e.status?e.message:'Internal server error'});else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
if(require.main===module){
  const store=new Store(process.env.BIRDEYE_DB||'data/birdeye.db');
  const server=createServer(store,{adminToken:secret('BIRDEYE_ADMIN_TOKEN'),workerToken:secret('BIRDEYE_WORKER_TOKEN')});
  server.listen(Number(process.env.PORT||8081),process.env.BIND_ADDRESS||'127.0.0.1',()=>console.log('Birdeye API listening'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
}
module.exports={createServer};
