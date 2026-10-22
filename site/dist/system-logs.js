(() => {

  'use strict';

  const files = [];

  const taskFile={path:'birdeye/tasks.log',description:'Recent task output captured on the host',content:'',taskLog:true};

  files.push(taskFile);

  let taskEntries=[];

  const $ = selector => document.querySelector(selector);

  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  let selected = files[0], entries = [], filtered = [], raw = false;

  const fileText = () => $('#log-rotation').value === 'previous' && selected.previous ? selected.previous : selected.content;

  const filePath = () => '/var/log/' + selected.path + ($('#log-rotation').value === 'previous' ? '.1' : '');

  function highlight(value) {

    const text = String(value), search = $('#log-search').value.trim();

    if (!search) return escape(text);

    let offset = 0, result = '', index;

    while ((index = text.toLowerCase().indexOf(search.toLowerCase(), offset)) !== -1) {

      result += escape(text.slice(offset, index)) + '<mark>' + escape(text.slice(index, index + search.length)) + '</mark>';

      offset = index + search.length;

    }

    return result + escape(text.slice(offset));

  }

  function renderEntries() {

    const search = $('#log-search').value.trim().toLowerCase(), level = $('#level-filter').value, process = $('#log-process').value, task=$('#log-task').value, run=$('#log-run').value;

    filtered = entries.filter(entry => (level === 'all' || entry.level === level) && (process === 'all' || entry.process === process) && (!selected.taskLog || ((task==='all'||entry.taskId===task)&&(run==='all'||entry.runId===run))) && entry.raw.toLowerCase().includes(search));

    $('#log-match-count').textContent = `${filtered.length} of ${entries.length} lines`;

    $('#structured-logs').classList.toggle('selected', !raw);

    $('#raw-logs').classList.toggle('selected', raw);

    $('#structured-logs').setAttribute('aria-pressed', String(!raw));

    $('#raw-logs').setAttribute('aria-pressed', String(raw));

    $('#system-log-entries').classList.toggle('raw-mode', raw);

    $('#system-log-entries').innerHTML = filtered.length ? filtered.map(entry => raw ? `<div class="raw-log-line"><span class="file-line-number">${entry.line}</span><code>${highlight(entry.raw) || ' '}</code></div>` : `<details class="file-log-entry severity-${entry.level}"><summary><span class="file-line-number">${entry.line}</span><span class="file-entry-body"><span class="file-entry-meta"><time>${escape(entry.time)}</time><span class="file-entry-level">${entry.level}</span><span class="file-entry-process">${escape(entry.process)}${entry.pid ? `<span> [${entry.pid}]</span>` : ''}</span></span><span class="file-entry-message">${highlight(entry.message) || '<span class="blank-line">Blank line</span>'}</span></span><span class="entry-expand" aria-hidden="true">⌄</span></summary><div class="file-entry-detail"><span>${selected.taskLog?'Captured record':'Snapshot line'} · ${escape(filePath())}:${entry.line}</span><pre>${highlight(entry.raw)}</pre>${entry.host ? `<span>Host / client: ${escape(entry.host)}</span>` : ''}${entry.runId ? `<div class="log-run-context"><span>Task: ${escape(entry.process)} · Run: ${escape(entry.runId)}</span><button class="text-button" data-run-detail="${escape(entry.runId)}">Open run details →</button></div>` : ''}</div></details>`).join('') : '<div class="log-empty"><strong>No matching lines</strong><p>Try another search, level, or process.</p><button id="reset-log-filters" class="button secondary">Clear filters</button></div>';

    const reset = $('#reset-log-filters');

    if (reset) reset.onclick = () => { $('#log-search').value = ''; $('#level-filter').value = 'all'; $('#log-process').value = 'all'; $('#log-task').value='all';$('#log-run').value='all';renderEntries(); };

  }

  function loadFile() {

    entries = selected.taskLog ? taskEntries : window.BirdeyeLogParser.parseFile(fileText(), filePath());

    const previousProcess=$('#log-process').value;
    $('#log-rotation').disabled=!selected.previous;$('#log-rotation').hidden=!selected.previous;
    $('#raw-logs').textContent=selected.taskLog?'JSON records':'Raw file';
    $('#log-file-title').textContent = selected.path.split('/').pop();

    $('#log-file-description').textContent = selected.description;

    $('#log-file-path').textContent = filePath();

    $('#log-process').innerHTML = '<option value="all">All processes</option>' + [...new Set(entries.map(entry => entry.process))].sort().map(process => `<option value="${escape(process)}">${escape(process)}</option>`).join('');

    if(entries.some(e=>e.process===previousProcess))$('#log-process').value=previousProcess;
    $('#log-task').hidden=!selected.taskLog;$('#log-run').hidden=!selected.taskLog;$('#log-process').hidden=!!selected.taskLog;

    renderEntries();

  }

  function renderFileList(){

  $('#log-file-count').textContent=files.length+' files';

  $('#log-file-list').innerHTML = files.map(file => `<button class="log-file-button ${file === selected ? 'selected' : ''}" data-log-path="${escape(file.path)}" aria-pressed="${file === selected}"><span class="log-file-glyph" aria-hidden="true">≡</span><span><strong>${escape(file.path)}</strong><small>${file.taskLog?taskEntries.length:window.BirdeyeLogParser.parseFile(file.content, file.path).length} lines · ${file.taskLog?'task output':'host snapshot'}</small></span></button>`).join('');

  }

  function selectFile(file){

    selected=file;$('#log-rotation').value='current';$('#log-rotation').disabled=!selected.previous;$('#log-search').value='';$('#level-filter').value='all';$('#log-task').value='all';$('#log-run').value='all';renderFileList();loadFile();

  }

  $('#log-file-list').onclick = event => {

    const button = event.target.closest('[data-log-path]');

    if (!button) return;

    selectFile(files.find(file=>file.path===button.dataset.logPath));

  };

  $('#log-search').oninput = renderEntries;

  $('#level-filter').onchange = renderEntries;

  $('#log-process').onchange = renderEntries;

  $('#log-task').onchange=()=>{$('#log-run').value='all';renderEntries();};$('#log-run').onchange=()=>{$('#log-task').value='all';renderEntries();};

  $('#log-rotation').onchange = loadFile;

  $('#structured-logs').onclick = () => { raw = false; renderEntries(); };

  $('#raw-logs').onclick = () => { raw = true; renderEntries(); };

  $('#download-logs').onclick = () => {

    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([filtered.map(entry => entry.raw).join('\n') + (filtered.length ? '\n' : '')], { type: 'text/plain' }));

    link.href = url;

    link.download = selected.path.replaceAll('/', '-') + ($('#log-rotation').value === 'previous' ? '.1' : '') + '.filtered.txt';

    link.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

  };

  window.BirdeyeSystemLogs={

    setHostFiles(hostFiles){

      const previous=selected.path;

      files.splice(0,files.length,...hostFiles.filter(f=>f.path!==taskFile.path).map(f=>({...f,description:f.error||'Last 256 KiB  -  snapshot '+new Date(f.updated).toLocaleString()})),taskFile);

      selected=files.find(f=>f.path===previous)||taskFile;

      renderFileList();loadFile();

    },

    setTaskEntries(records,runs){

      const taskFilter=$('#log-task').value,runFilter=$('#log-run').value;

      taskEntries=records.map((r,i)=>({raw:JSON.stringify(r),line:i+1,time:r.time,host:'',process:r.task,pid:'',level:r.stream==='stderr'?'ERROR':'INFO',message:r.message,taskId:r.task_id,runId:r.run_id}));

      taskFile.content=taskEntries.map(e=>e.raw).join('\n');

      const names=new Map(runs.map(r=>[r.taskId,r.name]));

      $('#log-task').innerHTML='<option value="all">All tasks</option>'+[...names].map(([id,name])=>`<option value="${escape(id)}">${escape(name)}</option>`).join('');

      $('#log-run').innerHTML='<option value="all">All runs</option>'+runs.map(r=>`<option value="${escape(r.id)}">${escape(r.name)}  -  ${escape(r.time)}</option>`).join('');

      if(names.has(taskFilter))$('#log-task').value=taskFilter;

      if(runs.some(r=>r.id===runFilter))$('#log-run').value=runFilter;

      renderFileList();if(selected.taskLog)loadFile();

    },

    openRun(id){selectFile(taskFile);$('#log-run').value=id;renderEntries();}

  };

  renderFileList();

  loadFile();

})();
