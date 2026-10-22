// Isolated test fixture; never used by the deployment.
const {Store}=require('../store.cjs');
const {createServer}=require('../server.cjs');
const store=new Store(process.argv[2]);
const server=createServer(store,{adminToken:'integration-admin-token-000000000000000000000',workerToken:'integration-worker-token-00000000000000000000'});
const timer=setInterval(()=>store.tick(),100);
server.listen(Number(process.argv[3]||0),'127.0.0.1',()=>console.log(server.address().port));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(()=>{store.close();process.exit(0);});});
