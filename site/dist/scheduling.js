(function(root) {
  'use strict';
  const units = { minutes: 60000, hours: 3600000, days: 86400000 };
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  function utcInput(date = new Date()) { return date.toISOString().slice(0,16); }
  function dateValue(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) throw new Error('Choose a valid date and time in UTC.');
    const result = new Date(value + ':00Z');
    if (!Number.isFinite(+result) || utcInput(result) !== value) throw new Error('Choose a valid date and time in UTC.');
    return result;
  }
  function cronField(text, min, max) {
    const values = new Set();
    for (const part of text.split(',')) {
      const match = part.match(/^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/);
      if (!match) throw new Error('Use numbers, *, ranges (1-5), lists (1,3), and steps (*/15).');
      const step = match[2] ? Number(match[2]) : 1;
      if (!step || step > max - min + 1) throw new Error('Cron step is outside this field’s range.');
      let start, end;
      if (match[1] === '*') { start=min; end=max; }
      else { const range=match[1].split('-').map(Number); start=range[0]; end=range[1] ?? (match[2] ? max : start); }
      if (start<min || end>max || start>end) throw new Error(`Cron value must be between ${min} and ${max}, with ascending ranges.`);
      for(let n=start;n<=end;n+=step) values.add(n);
    }
    return { values:[...values].sort((a,b)=>a-b), any:text==='*' };
  }
  function parseCron(expression) {
    const fields=expression.trim().split(/\s+/);
    if(fields.length!==5) throw new Error('Use five cron fields: minute hour day-of-month month day-of-week.');
    return fields.map((field,i)=>cronField(field,...[[0,59],[0,23],[1,31],[1,12],[0,7]][i]));
  }
  function cronNext(expression, now, count=3) {
    const [minute,hour,dom,month,dow]=parseCron(expression), result=[];
    const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
    // Day-based iteration avoids scanning millions of minutes for sparse schedules.
    for(let offset=0;offset<366*8 && result.length<count;offset++) {
      const date=new Date(+start+offset*86400000);
      if(!month.values.includes(date.getUTCMonth()+1)) continue;
      const dayMatch=dom.values.includes(date.getUTCDate());
      const weekMatch=dow.values.some(d=>d%7===date.getUTCDay());
      if (!(dom.any ? weekMatch : dow.any ? dayMatch : dayMatch || weekMatch)) continue;
      for(const h of hour.values) for(const m of minute.values) {
        const candidate=new Date(+date+h*3600000+m*60000);
        if(candidate>now) result.push(candidate);
        if(result.length===count) return result;
      }
    }
    return result;
  }
  function normalize(task, now=new Date()) {
    if(task.timing) return task;
    if(task.trigger==='request') return {...task,timing:{type:'request'}};
    const old=Number(task.schedule)||5;
    const timing=old===1440 ? {type:'repeat',mode:'daily',time:'00:00'} : old===10080 ? {type:'repeat',mode:'weekly',time:'00:00',days:[1]} : {type:'repeat',mode:'interval',every:old,unit:'minutes',start:utcInput(new Date(+now+60000))};
    return {...task,timing};
  }
  function validate(timing, now=new Date(), allowPast=false) {
    if(!['once','repeat','cron','startup','request'].includes(timing.type)) throw new Error('Choose a trigger.');
    if(timing.type==='once') { const date=dateValue(timing.at); if(!allowPast && date<=now) throw new Error('Choose a future time for this one-off task.'); }
    if(timing.type==='repeat') {
      if(!['interval','daily','weekly'].includes(timing.mode)) throw new Error('Choose a repeat pattern.');
      if(timing.mode==='interval') {
        if(!Number.isInteger(timing.every)||timing.every<1||timing.every>10000||!units[timing.unit]) throw new Error('Enter a repeat interval from 1 to 10,000.');
        dateValue(timing.start);
      } else {
        if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.time||'')) throw new Error('Choose a valid UTC time.');
        if(timing.mode==='weekly'&&(!timing.days?.length||timing.days.some(d=>!Number.isInteger(d)||d<0||d>6))) throw new Error('Select at least one weekday.');
      }
    }
    if(timing.type==='cron') { parseCron(timing.expression); if(!cronNext(timing.expression,now,1).length) throw new Error('No matching date in the next eight years. Check the day and month.'); }
    if(timing.type==='startup'&&(!Number.isInteger(timing.delay)||timing.delay<0||timing.delay>3600)) throw new Error('Startup delay must be between 0 and 3,600 seconds.');
    return timing;
  }
  function nextDates(timing,now=new Date(),count=3) {
    if(timing.type==='once') { const at=dateValue(timing.at); return at>now?[at]:[]; }
    if(timing.type==='cron') return cronNext(timing.expression,now,count);
    if(timing.type!=='repeat') return [];
    if(timing.mode==='interval') {
      const start=+dateValue(timing.start),period=timing.every*units[timing.unit];
      const next=start>+now?start:start+(Math.floor((+now-start)/period)+1)*period;
      return Array.from({length:count},(_,i)=>new Date(next+i*period));
    }
    const [h,m]=timing.time.split(':').map(Number),result=[];
    for(let offset=0;offset<28&&result.length<count;offset++) {
      const date=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+offset,h,m));
      if(date>now&&(timing.mode==='daily'||timing.days.includes(date.getUTCDay()))) result.push(date);
    }
    return result;
  }
  function describe(t) {
    if(t.type==='request') return 'On HTTP request';
    if(t.type==='startup') return `On system startup${t.delay?` + ${t.delay}s`:''}`;
    if(t.type==='once') return `Once · ${t.at.replace('T',' ')} UTC`;
    if(t.type==='cron') return `${t.expression} · UTC`;
    if(t.mode==='interval') return `Every ${t.every} ${t.every===1?t.unit.slice(0,-1):t.unit}`;
    if(t.mode==='daily') return `Daily at ${t.time} UTC`;
    return `${t.days.map(d=>dayNames[d]).join(', ')} · ${t.time} UTC`;
  }
  const format=date=>date.toISOString().slice(0,16).replace('T',' ')+' UTC';
  const api={utcInput,dateValue,parseCron,cronNext,normalize,validate,nextDates,describe,format};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.BirdeyeScheduling=api;
})(typeof globalThis!=='undefined'?globalThis:this);
