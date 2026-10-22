'use strict';

// randomUUID requires HTTPS; getRandomValues also works on plain LAN HTTP.

function createId(){

  if(globalThis.crypto.randomUUID)return globalThis.crypto.randomUUID();

  const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));

  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;

  const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');

  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;

}

const icons={grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',workflow:'<rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><path d="M6.5 9v7a2 2 0 0 0 2 2H14M15 6h6m-3-3v6"/>',history:'<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-5v6l4 2"/>',terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',chevrons:'<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',activity:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',panel:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',plus:'<path d="M12 5v14M5 12h14"/>',play:'<path d="m8 5 11 7-11 7z"/>','check-circle':'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>','arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',expand:'<path d="M14 3h7v7M3 14v7h7M21 3l-7 7M3 21l7-7"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',x:'<path d="m6 6 12 12M6 18 18 6"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',pause:'<path d="M8 5v14M16 5v14"/>',edit:'<path d="m14 5 5 5M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15z"/>',webhook:'<path d="M9 8 5 12l4 4m6-8 4 4-4 4M13 5l-2 14"/>','x-circle':'<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m-6 0 6-6"/>'};

const $=(q)=>document.querySelector(q),$$=(q)=>[...document.querySelectorAll(q)];

const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const icon=(name)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.terminal}</svg>`;

function hydrate(){ $$('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon)); }

const samples={Python:'import datetime\n\ndef main():\n    now = datetime.datetime.now(datetime.timezone.utc)\n    print(f"Task started at {now.isoformat()}")\n    # Your automation goes here\n    print("Task completed successfully")\n\nif __name__ == "__main__":\n    main()\n',JavaScript:'async function main() {\n  console.log("Task started", new Date().toISOString());\n  // Your automation goes here\n  console.log("Task completed successfully");\n}\n\nmain().catch(error => {\n  console.error(error);\n  process.exitCode = 1;\n});\n',Shell:'#!/usr/bin/env bash\nset -euo pipefail\n\necho "Task started at $(date -u)"\n# Your automation goes here\necho "Task completed successfully"\n'};

const groupPalette={green:{name:'Green',ink:'#337650',background:'#eaf5ed'},blue:{name:'Blue',ink:'#3c6fab',background:'#edf3fc'},purple:{name:'Purple',ink:'#7f5aab',background:'#f3edfa'},amber:{name:'Amber',ink:'#916c23',background:'#fbf3df'},rose:{name:'Rose',ink:'#aa5275',background:'#fbedf3'},teal:{name:'Teal',ink:'#287b82',background:'#e6f5f5'},orange:{name:'Orange',ink:'#af6032',background:'#fff0e5'},slate:{name:'Slate',ink:'#637083',background:'#edf0f5'}};

let groups=[],groupFilter='all',groupEditing=null;

let tasks=[],runs=[],logs=[],filter='all',view='overview',editing=null,consoleFilter='all',toastTimer;

let revision=0,saving=false,refreshing=false,selectedRun=null,stats={total:0,success:0,failed:0},lastLogRefresh=0,configEpoch=0,refreshCompletion=Promise.resolve(),refreshResolve=null;

const Scheduling=window.BirdeyeScheduling;

const API=window.BirdeyeAPI;

async function save(){

  if(saving)throw new Error('A save is already in progress');

  saving=true;configEpoch++;

  try{const result=await API.request('/config','PUT',{revision,tasks,groups});revision=result.revision;}

  catch(error){saving=false;await refresh(true).catch(()=>{});throw error;}

  finally{saving=false;}

  await refresh(true);

}

async function refresh(forceConfig=false){

  if(saving)return;
  if(refreshing){if(forceConfig){await refreshCompletion;return refresh(true);}return;}
  const requestEpoch=configEpoch;
  refreshCompletion=new Promise(resolve=>refreshResolve=resolve);

  refreshing=true;

  try{

    const state=await API.request('/state');

    if(saving||requestEpoch!==configEpoch)return;
    if(forceConfig||(!$('#task-dialog').open&&!$('#group-dialog').open)){
      tasks=state.tasks;groups=state.groups;revision=state.revision;
    }
    runs=state.runs;stats=state.stats;

    render();

    const online=state.worker&&Date.now()-state.worker.seen<60000;

    const scheduled=state.scheduler&&Date.now()-state.scheduler.seen<10000;

    $('.health').textContent=!online?'Worker offline':!scheduled?'Scheduler offline':'Worker and scheduler connected';

    $('.demo-tag').textContent='Connected';

    $('.server-status').innerHTML=`<div><span class="status-dot ${online?'':'neutral'}"></span>${online?'Worker online':'Worker offline'}</div><small>${esc(state.worker?.hostname||'No worker registered')}</small><div class="server-uptime">${state.worker?'Last seen '+esc(new Date(state.worker.seen).toLocaleTimeString()):'Install the host worker to execute tasks'}</div>`;

    if(Date.now()-lastLogRefresh>10000){

      const [host,output]=await Promise.all([API.request('/logs'),API.request('/task-logs')]);

      window.BirdeyeSystemLogs.setHostFiles(host.files);

      window.BirdeyeSystemLogs.setTaskEntries(output.entries,runs);

      logs=output.entries.slice(-20).map(e=>({time:e.time,level:e.stream==='stderr'?'ERROR':'INFO',source:e.task,message:e.message,type:'tasks'}));renderLogs();lastLogRefresh=Date.now();

    }

    if($('#run-dialog').open&&selectedRun)await updateRunDetail(selectedRun);

  }catch(error){$('.demo-tag').textContent='Disconnected';$('.health').textContent='Server unavailable  -  displayed data may be stale';throw error;}

  finally{refreshing=false;refreshResolve();}

}

function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3500);}

function groupStyle(group){const color=groupPalette[group?.color]||groupPalette.slate;return `--group-ink:${color.ink};--group-bg:${color.background}`;}

function taskGroupBadge(id){const group=groups.find(item=>item.id===id);return group?`<button class="group-badge" style="${groupStyle(group)}" data-task-group="${esc(id)}" title="Filter by ${esc(group.name)}"><span></span>${esc(group.name)}</button>`:'';}

function renderGroupFilters(){

  if(groupFilter!=='all'&&groupFilter!=='ungrouped'&&!groups.some(group=>group.id===groupFilter))groupFilter='all';

  const options=[{id:'all',name:'All groups',count:tasks.length},{id:'ungrouped',name:'Ungrouped',count:tasks.filter(task=>!task.groupId).length},...groups.map(group=>({...group,count:tasks.filter(task=>task.groupId===group.id).length}))];

  $('#group-filters').innerHTML=options.map(group=>`<button class="group-filter ${group.id===groupFilter?'selected':''}" style="${groupStyle(group)}" data-group-filter="${esc(group.id)}" aria-pressed="${group.id===groupFilter}">${group.color?'<span class="group-dot"></span>':''}${esc(group.name)}<span class="group-filter-count">${group.count}</span></button>`).join('');

}

function renderGroupOptions(selected=$('#task-group').value){$('#task-group').innerHTML='<option value="">Ungrouped</option>'+groups.map(group=>`<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('');$('#task-group').value=groups.some(group=>group.id===selected)?selected:'';}

function renderGroupList(){

  $('#group-list').innerHTML=groups.length?groups.map(group=>`<button class="group-list-item ${group.id===groupEditing?'selected':''}" data-edit-group="${esc(group.id)}" style="${groupStyle(group)}"><span class="group-dot"></span><strong>${esc(group.name)}</strong><small>${tasks.filter(task=>task.groupId===group.id).length} tasks</small>${icon('edit')}</button>`).join(''):'<p class="group-empty">Create your first group to organize related tasks.</p>';

}

function updateGroupPreview(){const name=$('#group-name').value.trim()||'Group name',color=$('input[name="groupColor"]:checked')?.value||'blue';$('#group-preview').innerHTML=`<span class="group-badge" style="${groupStyle({color})}"><span></span>${esc(name)}</span>`;}

function editGroup(id){

  const group=groups.find(item=>item.id===id);groupEditing=group?.id||null;

  $('#group-name').value=group?.name||'';const color=groupPalette[group?.color]?group.color:'blue';$(`input[name="groupColor"][value="${color}"]`).checked=true;

  $('#group-editor-title').textContent=group?'Edit group':'New group';$('#group-save').textContent=group?'Save changes':'Create group';$('#group-new').hidden=!group;$('#group-remove').hidden=!group;$('#group-error').hidden=true;$('#group-remove-confirm').hidden=true;

  renderGroupList();updateGroupPreview();

}

function openGroups(){editGroup();$('#group-dialog').showModal();$('#group-name').focus();}

function initializeGroups(){

  $('#group-color-options').innerHTML=Object.entries(groupPalette).map(([value,color])=>`<label class="group-color" style="--swatch:${color.ink}" title="${color.name}"><input type="radio" name="groupColor" value="${value}" aria-label="${color.name}" ${value==='blue'?'checked':''}><span aria-hidden="true"></span></label>`).join('');

  $('#manage-groups').onclick=$('#edit-task-groups').onclick=openGroups;

  $('#group-filters').onclick=event=>{const button=event.target.closest('[data-group-filter]');if(button){groupFilter=button.dataset.groupFilter;renderTasks();}};

  document.addEventListener('click',event=>{const badge=event.target.closest('[data-task-group]');if(badge){groupFilter=badge.dataset.taskGroup;renderTasks();}});

  $('#group-list').onclick=event=>{const button=event.target.closest('[data-edit-group]');if(button)editGroup(button.dataset.editGroup);};

  $('#group-name').oninput=updateGroupPreview;$('#group-color-options').onchange=updateGroupPreview;$('#group-new').onclick=()=>{editGroup();$('#group-name').focus();};

  $('#group-form').onsubmit=async event=>{

    event.preventDefault();const name=$('#group-name').value.trim(),color=$('input[name="groupColor"]:checked')?.value;

    const error=!name?'Enter a group name.':name.length>32?'Use 32 characters or fewer.':groups.some(group=>group.id!==groupEditing&&group.name.toLowerCase()===name.toLowerCase())?'A group with this name already exists.':!groupPalette[color]?'Choose a color.':'';

    if(error){$('#group-error').textContent=error;$('#group-error').hidden=false;return;}

    const existing=groups.find(group=>group.id===groupEditing),group={id:existing?.id||createId(),name,color};

    if(existing)groups[groups.indexOf(existing)]=group;else groups.push(group);

    await save();renderGroupOptions(!existing&&$('#task-dialog').open?group.id:$('#task-group').value);renderTasks();editGroup(group.id);toast(existing?'Group updated':'Group created');

  };

  $('#group-remove').onclick=()=>{$('#group-remove-confirm').hidden=false;$('#group-remove-confirm').scrollIntoView({block:'nearest'});};

  $('#group-remove-cancel').onclick=()=>$('#group-remove-confirm').hidden=true;

  $('#group-remove-yes').onclick=async()=>{

    if(!groupEditing)return;const id=groupEditing;groups=groups.filter(group=>group.id!==id);tasks.forEach(task=>{if(task.groupId===id)task.groupId='';});

    await save();renderGroupOptions();renderTasks();editGroup();toast('Group removed. Its tasks are now ungrouped.');

  };

  renderGroupOptions();

}

function runtime(language){return `<span class="runtime-icon ${language==='Shell'?'sh':language==='JavaScript'?'js':''}">${language==='Python'?'Py':language==='Shell'?'>_':'JS'}</span>`;}

function statusBadge(status){return `<span class="badge ${['Failed','Timed out','Interrupted'].includes(status)?'failed':['Paused','Queued','Cancelled'].includes(status)?'paused':''}"><span class="status-dot"></span>${esc(status)}</span>`;}

function renderTasks(){renderGroupFilters();const search=$('#task-search').value.toLowerCase(),language=$('#language-filter').value;const found=tasks.filter(t=>(filter==='all'||(filter==='active'?t.enabled:!t.enabled))&&(language==='all'||t.language===language)&&(groupFilter==='all'||(groupFilter==='ungrouped'?!t.groupId:t.groupId===groupFilter))&&(t.name+' '+t.description+' '+(groups.find(group=>group.id===t.groupId)?.name||'')).toLowerCase().includes(search));$('#task-rows').innerHTML=found.length?found.map(t=>`<tr><td><div class="task-cell">${runtime(t.language)}<div><div class="task-name-with-group"><button class="task-name" data-edit="${esc(t.id)}">${esc(t.name)}</button>${taskGroupBadge(t.groupId)}</div><span class="task-description">${esc(Scheduling.describe(t.timing))}</span></div></div></td><td><span class="trigger-badge">${icon(t.timing.type==='request'?'webhook':t.timing.type==='startup'?'server':'clock')}${esc(triggerLabel(t.timing.type))}</span></td><td><span class="last-result ${t.status==='Failed'?'failed':''}">${icon(t.status==='Failed'?'x-circle':'check-circle')}${esc(t.last||'Never run')}</span></td><td>${statusBadge(t.enabled?'Active':'Paused')}</td><td>${esc(taskNextText(t))}</td><td><div class="row-actions"><button class="icon-button" data-run="${esc(t.id)}" title="Run on host" aria-label="Run ${esc(t.name)}">${icon('play')}</button><button class="icon-button" data-toggle="${esc(t.id)}" title="${t.enabled?'Pause':'Enable'} task" aria-label="${t.enabled?'Pause':'Enable'} ${esc(t.name)}">${icon(t.enabled?'pause':'play')}</button><button class="icon-button" data-edit="${esc(t.id)}" title="Edit task" aria-label="Edit ${esc(t.name)}">${icon('edit')}</button></div></td></tr>`).join(''):'<tr><td colspan="6" class="empty">No tasks match your filters.</td></tr>';$('#task-count').textContent=tasks.length;$('#table-count').textContent=tasks.length;$('#showing-count').textContent=`Showing ${found.length} of ${tasks.length} tasks`;$('#metric-tasks').innerHTML=`${tasks.length} <span class="sub-value">tasks</span>`;$('#active-count').textContent=`${tasks.filter(t=>t.enabled).length} active`;$('#paused-count').textContent=`${tasks.filter(t=>!t.enabled).length} paused`;$('#metric-runs').textContent=stats.total||0;const upcoming=tasks.filter(t=>t.enabled).map(task=>({task,next:task.nextAt?new Date(task.nextAt):null})).filter(item=>item.next).sort((a,b)=>a.next-b.next);const next=upcoming[0];$('#next-run').innerHTML=next?`${esc(next.next.toLocaleString('en-GB',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}<span class="live-pill">UTC</span>`:'No scheduled runs';$('#next-name').textContent=next?.task.name||'No upcoming dates';$('#next-name').nextElementSibling.style.display=next?'':'none';$('#next-name').parentElement.lastElementChild.textContent=next?Scheduling.describe(next.task.timing):'';}

function triggerLabel(type){return {once:'One-off',repeat:'Repeating',cron:'Cron',startup:'Startup',request:'HTTP request'}[type]||type;}

function taskNextText(task){if(!task.enabled)return '—';if(task.timing.type==='request')return 'On request';if(task.timing.type==='startup')return 'Next system boot';const next=task.nextAt?new Date(task.nextAt):null;return next?Scheduling.format(next):'No future run';}

function renderRuns(){ $('#activity-list').innerHTML=runs.slice(0,4).map(r=>`<div class="activity-item"><span class="activity-icon ${r.status==='Failed'?'failed':''}">${icon(r.status==='Failed'?'x-circle':'check-circle')}</span><div class="activity-copy"><button class="task-name" data-run-detail="${esc(r.id)}"><strong>${esc(r.name)}</strong></button><p>${esc(r.status)} - ${esc(r.duration)}</p></div><span class="activity-time">${esc(r.ago)}</span></div>`).join('');$('#run-rows').innerHTML=runs.map(r=>`<tr><td><button class="task-name" data-run-detail="${esc(r.id)}">${esc(r.name)}</button></td><td>${esc(r.trigger)}</td><td>${esc(r.time)}</td><td>${esc(r.duration)}</td><td>${statusBadge(r.status)}</td><td><button class="text-button" data-run-detail="${esc(r.id)}">View output ${icon('arrow-right')}</button></td></tr>`).join('');}

function logLine(l){return `<div class="log-line"><span class="log-time">${esc(l.time)}</span><span class="log-level ${esc(l.level)}">${esc(l.level)}</span><span class="log-message"><span class="log-source">[${esc(l.source)}]</span>${esc(l.message)}</span></div>`;}

function renderLogs(){const consoleLogs=logs.filter(l=>consoleFilter==='all'||l.type===consoleFilter).slice(-6);$('#console-output').innerHTML=consoleLogs.map(logLine).join('')||'<p class="empty">No log entries in this view.</p>';}

function render(){renderTasks();renderRuns();renderLogs();const terminal=(stats.success||0)+(stats.failed||0);$('.metric:nth-child(3) .metric-value').innerHTML=`${terminal?(stats.success/terminal*100).toFixed(1):' - '}<span class="value-unit">%</span>`;$('.metric:nth-child(3) .metric-foot').textContent=`${stats.success||0} successful  -  ${stats.failed||0} failed today`;}

function navigate(){const requested=location.hash.slice(1);view=['overview','tasks','runs','logs'].includes(requested)?requested:'overview';const labels={overview:['Overview','A little oversight. A lot of peace of mind.'],tasks:['Tasks','Your scripts, on your schedule.'],runs:['Run history','Every execution. Every outcome.'],logs:['System logs','Explore your server’s /var/log files, one clear line at a time.']};$('#page-title').textContent=labels[view][0];$('#breadcrumb').textContent=labels[view][0];$('#page-description').textContent=labels[view][1];$$('[data-view]').forEach(a=>{a.classList.toggle('active',a.dataset.view===view);if(a.dataset.view===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});$('#overview-content').classList.toggle('hidden',view!=='overview');$('#tasks-content').classList.toggle('hidden',!['overview','tasks'].includes(view));$('#bottom-content').classList.toggle('hidden',view!=='overview');$('#history-content').classList.toggle('hidden',view!=='runs');$('#logs-content').classList.toggle('hidden',view!=='logs');$('#view-all').classList.toggle('hidden',view==='tasks');}

function triggerFields(){

  const type=$('#form-trigger').value;

  $$('[data-timing]').forEach(section=>{const active=section.dataset.timing===type;section.classList.toggle('hidden',!active);section.querySelectorAll('input,select').forEach(input=>input.disabled=!active);});

  if(type==='repeat'){

    const mode=$('#repeat-mode').value;

    for(const [id,active] of [['interval-fields',mode==='interval'],['calendar-fields',mode!=='interval'],['weekday-fields',mode==='weekly']]){

      const section=$('#'+id);section.classList.toggle('hidden',!active);section.querySelectorAll('input,select').forEach(input=>input.disabled=!active);

    }

  }

  updateSchedulePreview();

}

function readTiming(){

  const f=$('#task-form').elements,type=f.trigger.value;

  if(type==='once')return {type,at:f.at.value};

  if(type==='cron')return {type,expression:f.cron.value.trim().replace(/\s+/g,' ')};

  if(type==='startup')return {type,delay:Number(f.bootDelay.value)};

  if(type==='request')return {type};

  const mode=f.repeatMode.value;

  return mode==='interval'?{type,mode,every:Number(f.every.value),unit:f.unit.value,start:f.start.value}:{type,mode,time:f.time.value,...(mode==='weekly'?{days:$$('input[name="weekdays"]:checked').map(input=>Number(input.value))}:{})};

}

function updateSchedulePreview(){

  const preview=$('#schedule-preview'),error=$('#schedule-error');

  try{

    const timing=readTiming();Scheduling.validate(timing,new Date(),true);

    error.hidden=true;

    const dates=Scheduling.nextDates(timing);

    preview.innerHTML=`<strong>${esc(Scheduling.describe(timing))}</strong>`+(dates.length?`<span>Upcoming ${timing.type==='once'?'run':'runs'} · UTC</span><ul>${dates.map(date=>`<li>${esc(Scheduling.format(date))}</li>`).join('')}</ul>`:`<span>${timing.type==='startup'?'Once per boot; no calendar date.':timing.type==='request'?'Runs when the endpoint receives a request.':'This date has passed. No future run is scheduled.'}</span>`);

  }catch(errorValue){preview.innerHTML='';error.hidden=false;error.textContent=errorValue.message;}

}

function fileName(){ $('#script-file').textContent='script.'+({Python:'py',JavaScript:'js',Shell:'sh'}[$('#form-language').value]); }

function editTask(id){

  const task=tasks.find(t=>t.id===id);editing=task?.id||null;const form=$('#task-form');form.reset();

  const timing=task?.timing||{type:'repeat',mode:'interval',every:5,unit:'minutes',start:Scheduling.utcInput(new Date(Date.now()+3600000))};

  $('#dialog-title').textContent=task?'Edit task':'Create a task';

  renderGroupOptions(task?.groupId||(groupFilter!=='all'&&groupFilter!=='ungrouped'?groupFilter:''));

  form.elements.name.value=task?.name||'';form.elements.language.value=task?.language||'Python';form.elements.trigger.value=timing.type;

  form.elements.repeatMode.value=timing.mode||'interval';form.elements.every.value=timing.every||5;form.elements.unit.value=timing.unit||'minutes';

  form.elements.start.value=timing.start||Scheduling.utcInput(new Date(Date.now()+3600000));form.elements.at.value=timing.at||Scheduling.utcInput(new Date(Date.now()+3600000));

  form.elements.time.value=timing.time||'09:00';form.elements.cron.value=timing.expression||'0 9 * * 1-5';form.elements.bootDelay.value=timing.delay??30;

  $$('input[name="weekdays"]').forEach(input=>input.checked=(timing.days||[1,2,3,4,5]).includes(Number(input.value)));

  form.elements.timeout.value=task?.timeout||300;$('#hook-config').textContent=task?`POST ${location.origin}/api/hooks/${task.id}\nAuthorization: Bearer ${task.hookToken}`:'Save this task to generate its URL and bearer token.';form.elements.script.value=task?.script||samples.Python;form.elements.enabled.checked=task?.enabled??true;

  triggerFields();fileName();$('#task-dialog').showModal();

}

async function saveTask(event){

  event.preventDefault();const form=$('#task-form');if(!form.reportValidity())return;

  const data=new FormData(form),name=String(data.get('name')).trim(),script=String(data.get('script')).trim();

  if(!name||!script){toast('Give the task a name and a script.');return;}

  const existing=tasks.find(t=>t.id===editing),timing=readTiming();

  try{Scheduling.validate(timing,new Date(),existing?.timing.type==='once'&&existing.timing.at===timing.at);}

  catch(error){$('#schedule-error').hidden=false;$('#schedule-error').textContent=error.message;$('#schedule-error').scrollIntoView({block:'nearest'});return;}

  const task={...existing,id:editing||createId(),name,groupId:groups.some(group=>group.id===data.get('groupId'))?String(data.get('groupId')):'',language:String(data.get('language')),trigger:timing.type,timing,timeout:Number(form.elements.timeout.value),script,enabled:data.has('enabled'),description:existing?.description||Scheduling.describe(timing),last:existing?.last||'Never run',status:existing?.status||'Success'};

  delete task.schedule;delete task.next;

  if(existing)tasks[tasks.indexOf(existing)]=task;else tasks.push(task);

  await save();render();$('#task-dialog').close();toast(existing?'Task saved':'Task created');

}

async function toggleTask(id){const task=tasks.find(t=>t.id===id);if(!task)throw new Error('Task not found');task.enabled=!task.enabled;await save();renderTasks();toast(`${task.name} ${task.enabled?'enabled':'paused'}`);}

async function updateRunDetail(id){

  const run=runs.find(r=>r.id===id);if(!run)return;

  const output=await API.request(`/runs/${id}/output`);

  if(selectedRun!==id)return;

  $('#run-title').textContent=run.name;

  $('#run-detail').innerHTML=`<div class="run-summary">${statusBadge(run.status)}<span>${esc(run.time)}</span><span>${esc(run.trigger)}</span><span>${esc(run.duration)}</span></div><div class="run-log-link"><button class="text-button" data-open-run-logs="${esc(run.id)}">View in System logs ${icon('arrow-right')}</button>${['Queued','Running'].includes(run.status)?`<button class="text-button" data-cancel-run="${esc(run.id)}" ${run.cancelRequested?'disabled':''}>${run.cancelRequested?'Cancelling...':'Cancel run'}</button>`:''}</div><pre class="run-code">${output.entries.map(e=>`<span class="output-${esc(e.stream)}" title="${esc(e.stream)}">${esc(e.message)}</span>`).join('')||esc(run.status==='Queued'?'Waiting for the host worker...':'No output captured yet.')}</pre><div class="run-demo-note">${esc(run.detail||'Captured from the host worker')}${run.exitCode!==null?'  -  Exit code '+esc(run.exitCode):''}</div>`;

}

async function showRun(id){selectedRun=id;$('#run-title').textContent='Run output';$('#run-detail').textContent='Loading...';if(!$('#run-dialog').open)$('#run-dialog').showModal();await updateRunDetail(id);}

async function runTask(id){const run=await API.request(`/tasks/${id}/run`,'POST',{});await refresh();await showRun(run.id);toast('Run queued for the host worker');}

function download(filename,text,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

document.addEventListener('click',event=>{if(saving)return;const cancel=event.target.closest('[data-cancel-run]');if(cancel)API.request(`/runs/${cancel.dataset.cancelRun}/cancel`,'POST',{}).then(refresh);const edit=event.target.closest('[data-edit]'),run=event.target.closest('[data-run]'),toggle=event.target.closest('[data-toggle]'),detail=event.target.closest('[data-run-detail]');if(edit)editTask(edit.dataset.edit);if(run)runTask(run.dataset.run);if(toggle)toggleTask(toggle.dataset.toggle);if(detail)showRun(detail.dataset.runDetail);const logLink=event.target.closest('[data-open-run-logs]');if(logLink){$('#run-dialog').close();lastLogRefresh=0;refresh(true).then(()=>window.BirdeyeSystemLogs.openRun(logLink.dataset.openRunLogs));location.hash='logs';}});

$('#new-task').onclick=()=>editTask();$('#view-all').onclick=()=>location.hash='tasks';$('#task-form').onsubmit=saveTask;$('#form-trigger').onchange=triggerFields;$('#form-language').onchange=()=>{fileName();if(!editing)$('#script-editor').value=samples[$('#form-language').value];};

$$('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());$$('dialog').forEach(d=>d.addEventListener('click',event=>{if(event.target===d){const r=d.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)d.close();}}));

$('#workspace').onclick=$('#profile').onclick=$('#help').onclick=()=>$('#about-dialog').showModal();

$$('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;$$('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));renderTasks();});$('#task-search').oninput=renderTasks;$('#language-filter').onchange=renderTasks;

$$('[data-console]').forEach(b=>b.onclick=()=>{consoleFilter=b.dataset.console;$$('[data-console]').forEach(x=>x.classList.toggle('active',x===b));renderLogs();});$('#clear-console').onclick=()=>{$('#console-output').innerHTML='<p class="empty">Console view cleared. Saved logs are still available.</p>';toast('Console view cleared');};

$('#export-runs').onclick=()=>{const cell=v=>`"${String(v).replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;download('birdeye-runs.csv',[['Task','Trigger','Time','Duration','Result'],...runs.map(r=>[r.name,r.trigger,r.time,r.duration,r.status])].map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv');};

$('#script-editor').addEventListener('keydown',event=>{if(event.key==='Tab'){event.preventDefault();const el=event.target,start=el.selectionStart,end=el.selectionEnd;el.setRangeText('    ',start,end,'end');}});

document.addEventListener('keydown',event=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('dialog[open]')){event.preventDefault();if(view==='logs')$('#log-search').focus();else{location.hash='tasks';$('#task-search').focus();}}});

$('#repeat-mode').onchange=triggerFields;$('#task-form').addEventListener('input',updateSchedulePreview);$('#task-form').addEventListener('change',updateSchedulePreview);$('#cron-preset').onchange=event=>{if(event.target.value)$('#task-form').elements.cron.value=event.target.value;updateSchedulePreview();};

initializeGroups();

window.addEventListener('hashchange',navigate);hydrate();render();navigate();

window.addEventListener('unhandledrejection',event=>{
  event.preventDefault();const message=event.reason?.message||'Request failed';
  const target=$('#group-dialog').open?$('#group-error'):$('#task-dialog').open?$('#schedule-error'):null;
  if(target){target.textContent=message;target.hidden=false;}else toast(message);
});

API.onLogin=async()=>{await refresh();};

API.start();

setInterval(()=>{if(API.connected)refresh().catch(()=>{});},3000);

if(document.modelContext?.registerTool){for(const tool of [{name:'list_script_tasks',description:'Read script task configurations in the server workspace.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>({tasks:tasks.map(({id,name,language,timing,enabled,groupId})=>({id,name,language,trigger:timing.type,timing,enabled,groupId,group:groups.find(group=>group.id===groupId)?.name||null}))})},{name:'open_script_task_editor',description:'Open an existing task configuration for editing. Does not save changes.',inputSchema:{type:'object',properties:{taskId:{type:'string'}},required:['taskId'],additionalProperties:false},execute:input=>{if(!input||typeof input.taskId!=='string'||!tasks.some(t=>t.id===input.taskId))throw new Error('Unknown taskId');if($('dialog[open]'))throw new Error('Close the current dialog before editing another task');editTask(input.taskId);return{opened:true,taskId:input.taskId};}}]){try{Promise.resolve(document.modelContext.registerTool(tool)).catch(()=>{});}catch{}}}
