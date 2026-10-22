const {test}=require('node:test');
const assert=require('node:assert/strict');
const S=require('../dist/scheduling.js');
const now=new Date('2026-09-22T10:07:00Z');
test('cron lists, ranges and steps produce exact UTC occurrences',()=>{
  assert.deepEqual(S.cronNext('*/15 9-17 * * 1-5',now).map(d=>d.toISOString()),['2026-09-22T10:15:00.000Z','2026-09-22T10:30:00.000Z','2026-09-22T10:45:00.000Z']);
  assert.equal(S.cronNext('0 9,17 * * 1-5',now,1)[0].toISOString(),'2026-09-22T17:00:00.000Z');
});
test('cron both restricted day fields use OR semantics',()=>{
  assert.equal(S.cronNext('0 9 1 * 3',now,1)[0].toISOString(),'2026-09-23T09:00:00.000Z');
});
test('Sunday 0 and 7 match identically and leap day is reachable',()=>{
  assert.equal(+S.cronNext('0 0 * * 0',now,1)[0],+S.cronNext('0 0 * * 7',now,1)[0]);
  assert.equal(S.cronNext('0 0 29 2 *',now,1)[0].toISOString(),'2028-02-29T00:00:00.000Z');
});
test('invalid cron expressions and impossible calendar dates are rejected',()=>{
  for(const expression of ['60 * * * *','*/0 * * * *','0 9 * * 6-1','0 9 * * MON','0 0 1 *','0 0 30 2 *']) assert.throws(()=>S.validate({type:'cron',expression},now));
});
test('one-off future times validate and past/new invalid dates reject',()=>{
  assert.equal(S.nextDates({type:'once',at:'2026-09-23T12:00'},now).length,1);
  assert.throws(()=>S.validate({type:'once',at:'2026-09-21T12:00'},now));
  assert.throws(()=>S.validate({type:'once',at:'2026-02-30T12:00'},now));
  assert.equal(S.nextDates(S.validate({type:'once',at:'2026-09-21T12:00'},now,true),now).length,0);
});
test('repeating intervals retain their anchor and skip elapsed occurrences',()=>{
  const timing={type:'repeat',mode:'interval',every:2,unit:'hours',start:'2026-09-22T03:00'};
  assert.equal(S.nextDates(timing,now,1)[0].toISOString(),'2026-09-22T11:00:00.000Z');
  assert.equal(S.nextDates(timing,new Date('2026-09-22T11:00Z'),1)[0].toISOString(),'2026-09-22T13:00:00.000Z');
  assert.throws(()=>S.validate({...timing,every:0},now));
});
test('daily and weekly schedules respect UTC and chosen days',()=>{
  assert.equal(S.nextDates({type:'repeat',mode:'daily',time:'09:00'},now,1)[0].toISOString(),'2026-09-23T09:00:00.000Z');
  assert.equal(S.nextDates({type:'repeat',mode:'weekly',time:'09:00',days:[1,5]},now,1)[0].toISOString(),'2026-09-25T09:00:00.000Z');
  assert.throws(()=>S.validate({type:'repeat',mode:'weekly',time:'09:00',days:[]},now));
});
test('startup and request triggers have no invented calendar dates',()=>{
  assert.deepEqual(S.nextDates(S.validate({type:'startup',delay:30},now),now),[]);
  assert.deepEqual(S.nextDates({type:'request'},now),[]);
  assert.throws(()=>S.validate({type:'startup',delay:-1},now));
});
test('legacy migration preserves scripts and daily midnight semantics',()=>{
  const old={id:'safe',script:'print("keep me")',trigger:'timer',schedule:'1440'};
  const migrated=S.normalize(old,now);
  assert.equal(migrated.script,old.script);
  assert.deepEqual(migrated.timing,{type:'repeat',mode:'daily',time:'00:00'});
  assert.deepEqual(S.normalize(migrated,now),migrated);
});
