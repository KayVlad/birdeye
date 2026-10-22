'use strict';
const {Store}=require('./store.cjs');
const store=new Store(process.env.BIRDEYE_DB||'data/birdeye.db');
function tick(){try{store.tick();}catch(e){console.error('Scheduler tick failed:',e.message);}}
tick();const timer=setInterval(tick,1000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);store.close();process.exit(0);});
