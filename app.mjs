import {OWNER,LIVE,currentStatus,groupStatus,statusLabel,normaliseRun,elapsedMs,formatDuration,filterRuns,sortRuns,uniqueRuns,summary,githubError} from './core.mjs';

const API = 'https://api.github.com';
const $ = id => document.getElementById(id);
let token = ''; // Deliberately in memory only. Never persist, log, or put in URLs.
let controller = null;
let timer = null;
let lastErrors = [];
let state = {
  repos:[],runs:[],status:'all',query:'',repo:'all',days:7,scope:'owned',
  show:40,scanning:false,lastChecked:null,rateRemaining:null,rateReset:null,
  scannedRepos:0,fullScan:false,extraRepos:[]
};

function setNotice(message='') {
  const el = $('notice'); el.textContent = message; el.hidden = !message;
}
function requestHeaders(){
  const h = {'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  if(token) h.Authorization = `Bearer ${token}`;
  return h;
}
async function api(url, signal) {
  const response = await fetch(url,{method:'GET',headers:requestHeaders(),signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
  if(response.headers.has('x-ratelimit-remaining')) state.rateRemaining = Number(response.headers.get('x-ratelimit-remaining'));
  if(response.headers.has('x-ratelimit-reset')) state.rateReset = Number(response.headers.get('x-ratelimit-reset'));
  if(!response.ok){
    let detail='';
    try {detail=String((await response.json()).message || '').slice(0,300);} catch { /* no response body */ }
    const err = new Error(githubError(response.status,detail)); err.status = response.status; throw err;
  }
  return response.json();
}
async function discoverRepositories(signal){
  const repos=[];
  const ownedPublic=!token;
  for(let page=1;page<=10;page++){
    const path=ownedPublic
      ? `/users/${encodeURIComponent(OWNER)}/repos?type=owner&sort=pushed&per_page=100&page=${page}`
      : `/user/repos?affiliation=${state.scope==='owned'?'owner':'owner%2Ccollaborator%2Corganization_member'}&sort=pushed&per_page=100&page=${page}`;
    const chunk=await api(API+path,signal);
    if(!Array.isArray(chunk)) throw new Error('Unexpected GitHub repository response.');
    repos.push(...chunk.filter(r=>state.scope==='accessible'||r.owner?.login?.toLowerCase()===OWNER.toLowerCase()).map(r=>({
      name:String(r.name),full_name:String(r.full_name),private:!!r.private,archived:!!r.archived,disabled:!!r.disabled
    })));
    if(chunk.length<100) break;
    if(page===10) lastErrors.push('Only the first 1,000 repositories were discovered.');
  }
  for(const fullName of state.extraRepos){
    if(!repos.some(r=>r.full_name.toLowerCase()===fullName.toLowerCase())){
      repos.push({name:fullName.split('/')[1],full_name:fullName,private:false,archived:false,disabled:false,external:true});
    }
  }
  return repos.filter(r=>!r.disabled);
}
function makeRunURL(repo){return `${API}/repos/${repo.full_name.split('/').map(encodeURIComponent).join('/')}/actions/runs`;}
async function runsForRepo(repo,deep,signal){
  if(!deep){
    const data=await api(`${makeRunURL(repo)}?per_page=100&page=1`,signal);
    if(!Array.isArray(data.workflow_runs)) throw new Error('Malformed workflow runs response.');
    return data.workflow_runs.map(r=>normaliseRun(r,repo));
  }
  const statuses=['in_progress','queued','waiting','pending','requested'];
  const result=[];
  for(const status of statuses){
    for(let page=1;page<=10;page++){
      const data=await api(`${makeRunURL(repo)}?status=${status}&per_page=100&page=${page}`,signal);
      if(!Array.isArray(data.workflow_runs)) throw new Error('Malformed workflow runs response.');
      result.push(...data.workflow_runs.map(r=>normaliseRun(r,repo)));
      if(data.workflow_runs.length<100) break;
      if(page===10) lastErrors.push(`Deep scan hit the 1,000-run pagination cap in ${repo.full_name} (${status}).`);
    }
  }
  return result;
}
async function mapLimit(items,limit,iterator){
  let index=0;
  const workers=Array.from({length:Math.min(items.length,limit)},async()=>{
    while(index<items.length){
      const i=index++;
      await iterator(items[i],i);
    }
  });
  await Promise.all(workers);
}
function renderWatchList(){
  const list=$('watch-list');list.replaceChildren();
  for(const fullName of state.extraRepos){
    const chip=elem('button','watch-chip',`${fullName} ×`);
    chip.type='button';chip.title=`Stop monitoring ${fullName}`;
    chip.addEventListener('click',()=>{
      state.extraRepos=state.extraRepos.filter(n=>n!==fullName);
      state.repos=[];state.runs=[];state.repo='all';renderWatchList();scan({rediscover:true});
    });
    list.append(chip);
  }
}
function parseRepoName(value){
  const parts=value.trim().replace(/^https:\/\/github\.com\//i,'').split('/').filter(Boolean);
  if(parts.length<2 || !/^[a-z0-9-]{1,39}$/i.test(parts[0]) || !/^[a-z0-9_.-]{1,100}$/i.test(parts[1]))return null;
  return `${parts[0]}/${parts[1].replace(/\.git$/i,'')}`;
}
function setScanning(isBusy){
  state.scanning=isBusy;
  $('refresh-btn').disabled=isBusy;
  $('refresh-btn').classList.toggle('spin',isBusy);
  $('deep-scan').disabled=isBusy;
  $('scope').disabled=isBusy;
  $('autorefresh').disabled=!token || isBusy;
  $('refresh-btn').lastChild.textContent=isBusy?' Scanning':' Refresh';
}
function updateRepoDropdown(){
  const selector=$('repo-filter');
  const current=state.repo;
  selector.replaceChildren(new Option('All repositories','all'));
  for(const repo of [...state.repos].sort((a,b)=>a.full_name.localeCompare(b.full_name))){
    selector.add(new Option(`${repo.name}${repo.private?' · private':''}`,repo.full_name));
  }
  state.repo=state.repos.some(r=>r.full_name===current)?current:'all';
  selector.value=state.repo;
}
function updateConnection(){
  $('connection-note').textContent=token?'Private + public repositories':'Public repositories';
  $('connect-btn').replaceChildren(document.createTextNode(token?'Connected · Manage':'Connect private repos '));
  $('scope-label').textContent=token?'Private + public mode':'Public-only mode';
  $('autorefresh').disabled=!token;
  if(!token)$('autorefresh').checked=false;
  $('scope').disabled=!token;
  if(!token) {$('scope').value='owned';state.scope='owned';}
  schedule();
}
function schedule(){
  if(timer)clearInterval(timer);
  timer=null;
  if(token && $('autorefresh').checked){
    timer=setInterval(()=>{if(!state.scanning && !document.hidden)scan();},120000);
  }
}
async function scan({deep=false,rediscover=false}={}){
  if(controller)controller.abort();
  controller=new AbortController();
  const signal=controller.signal;
  lastErrors=[];
  state.scannedRepos=0;
  state.fullScan=deep;
  setScanning(true);
  setNotice('');
  try {
    if(rediscover||!state.repos.length){
      state.repos=await discoverRepositories(signal);
      updateRepoDropdown();
    }
    if(!state.repos.length){throw new Error('No repositories were returned for this account and token.');}
    const prior=new Map();
    for(const run of state.runs){if(!prior.has(run.repo))prior.set(run.repo,[]); prior.get(run.repo).push(run);}
    const newRuns=[];
    let completed=0;
    await mapLimit(state.repos,5,async repo=>{
      if(signal.aborted) return;
      try {
        const recent=await runsForRepo(repo,deep,signal);
        if(deep){newRuns.push(...(prior.get(repo.full_name)||[]).filter(r=>!LIVE.has(currentStatus(r))),...recent);}
        else {newRuns.push(...recent);}
      } catch (e) {
        if(signal.aborted)return;
        if(lastErrors.length<8)lastErrors.push(`${repo.name}: ${e.message}`);
        // Retain previously seen data, rather than silently hiding failing repositories.
        newRuns.push(...(prior.get(repo.full_name)||[]));
      }
      completed++;
      state.scannedRepos=completed;
      $('scan-info').textContent=`Scanning ${completed} / ${state.repos.length} repositories${deep?' · deep active scan':''}`;
    });
    if(signal.aborted)return;
    state.runs=uniqueRuns(newRuns);
    state.lastChecked=new Date();
    render();
    if(lastErrors.length) setNotice(`${lastErrors.length} scan warning${lastErrors.length===1?'':'s'}. ${lastErrors.slice(0,3).join(' · ')}${lastErrors.length>3?' · See the browser console for no extra details.':''}`);
  } catch (err) {
    if(!signal.aborted){setNotice(err.message);render();}
  } finally {
    if(!signal.aborted){setScanning(false);render();}
  }
}
function elem(tag,className='',text){const el=document.createElement(tag); if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function addCell(row,child,className='') {const td=elem('td',className); if(typeof child==='string')td.textContent=child; else td.append(child); row.append(td);return td;}
function repoHref(fullName){return `https://github.com/${fullName.split('/').map(encodeURIComponent).join('/')}`;}
function relativeTime(iso){
  const ms=Date.now()-Date.parse(iso||'');
  if(!Number.isFinite(ms))return '–';
  if(ms<60000)return 'Just now';
  if(ms<3600000)return `${Math.floor(ms/60000)}m ago`;
  if(ms<86400000)return `${Math.floor(ms/3600000)}h ago`;
  if(ms<2592000000)return `${Math.floor(ms/86400000)}d ago`;
  return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short'}).format(new Date(iso));
}
function durationLabel(run){const value=formatDuration(elapsedMs(run));return LIVE.has(currentStatus(run))?value:`~${value}`;}
function renderRow(run){
  const row=elem('tr');
  const detail=elem('div','workflow-cell');
  detail.append(elem('strong','',run.name),elem('small','',`${run.workflow}${run.branch?' · '+run.branch:''} · #${run.run_number}`));
  addCell(row,detail);
  const repo=elem('span'); const repoLink=elem('a','repo-link',run.repo.split('/')[1]);
  repoLink.href=repoHref(run.repo);repoLink.target='_blank';repoLink.rel='noopener noreferrer';repoLink.title=run.repo;
  repo.append(repoLink);if(run.isPrivate)repo.append(elem('span','private-mark','◈'));
  addCell(row,repo);
  addCell(row,elem('span',`status-pill ${groupStatus(run)}`,statusLabel(run)));
  addCell(row,run.event || '–');
  const t=addCell(row,relativeTime(run.created_at));t.title=run.created_at?new Date(run.created_at).toLocaleString('en-GB'):'';
  addCell(row,durationLabel(run));
  const link=elem('a','open-link','↗');link.href=run.url;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label',`Open ${run.name} in GitHub`);
  addCell(row,link);
  return row;
}
function renderEmpty(body,heading,description){
  const row=elem('tr'); const td=elem('td','empty-state'); td.colSpan=7;
  td.append(elem('span','empty-icon','◎'),elem('strong','',heading),elem('small','',description));
  row.append(td);body.append(row);
}
function render(){
  const shown=sortRuns(filterRuns(state.runs,{status:state.status,query:state.query,repo:state.repo,days:state.days}));
  const total=summary(state.runs);
  $('metric-running').textContent=String(total.running);
  $('metric-queued').textContent=String(total.queued);
  $('metric-failed').textContent=String(total.failed24);
  $('metric-passed').textContent=String(total.passed24);
  $('side-live-count').textContent=String(total.running+total.queued);
  $('row-count').textContent=String(shown.length);
  $('repo-count').textContent=String(state.repos.length);
  const body=$('runs-body');const fragment=document.createDocumentFragment();
  if(!shown.length)renderEmpty(fragment,state.runs.length?'No matching workflow runs':'No workflow runs yet',state.runs.length?'Try another status, date range or search term.':'Connect your GitHub account or refresh to fetch workflows.');
  else for(const run of shown.slice(0,state.show))fragment.append(renderRow(run));
  body.replaceChildren(fragment);
  const load=$('load-more');load.hidden=shown.length<=state.show;load.textContent=`Show more (${shown.length-state.show} remaining) ↓`;
  $('scan-info').textContent=state.scanning?`Scanning ${state.scannedRepos} / ${state.repos.length} repositories${state.fullScan?' · deep active scan':''}`:state.lastChecked?`${state.repos.length} repositories · ${state.runs.length} runs sampled · Updated ${state.lastChecked.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`:'No scan completed';
  const reset=state.rateReset ? ` · resets ${new Date(state.rateReset*1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`:'';
  $('rate-info').textContent=Number.isFinite(state.rateRemaining)?`API quota: ${state.rateRemaining}${reset}`:'';
}
function filterStatus(value){state.status=value;state.show=40;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.status===value));render();}
function openModal(){ $('modal-backdrop').hidden=false;$('token-error').hidden=true;$('token-input').value='';$('token-input').focus(); }
function closeModal(){ $('modal-backdrop').hidden=true;$('token-input').value=''; }

$('connect-btn').addEventListener('click',openModal);
$('modal-close').addEventListener('click',closeModal);
$('modal-backdrop').addEventListener('click',e=>{if(e.target===$('modal-backdrop'))closeModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('modal-backdrop').hidden)closeModal();});
$('disconnect').addEventListener('click',()=>{
  if(controller)controller.abort();
  token='';state.repos=[];state.runs=[];state.rateRemaining=null;state.lastChecked=null;
  closeModal();updateConnection();render();scan({rediscover:true});
});
$('token-form').addEventListener('submit',async e=>{
  e.preventDefault();const candidate=$('token-input').value.trim();
  if(!candidate){return;}
  const submit=$('token-form').querySelector('[type="submit"]');submit.disabled=true;$('token-error').hidden=true;
  try{
    // Validation happens exclusively against api.github.com, not through this site's host.
    const response=await fetch(`${API}/user/repos?affiliation=owner&per_page=1`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${candidate}`,'X-GitHub-Api-Version':'2022-11-28'},credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
    if(!response.ok)throw new Error(githubError(response.status, response.status===403?'permission':''));
    token=candidate;
    state.repos=[];state.runs=[];state.lastChecked=null;state.rateRemaining=null;
    closeModal();updateConnection();$('autorefresh').checked=true;schedule();
    scan({rediscover:true});
  }catch(err){$('token-error').textContent=err.message;$('token-error').hidden=false;}
  finally{submit.disabled=false;$('token-input').value='';}
});
$('refresh-btn').addEventListener('click',()=>scan({rediscover:true}));
$('deep-scan').addEventListener('click',()=>{
  if(!token){openModal();setNotice('Connect a read-only token for a complete active-status scan. Public API limits are too low for deep scanning across this account.');return;}
  scan({deep:true,rediscover:false});
});
$('autorefresh').addEventListener('change',schedule);
$('scope').addEventListener('change',e=>{state.scope=e.target.value;state.repos=[];state.runs=[];state.repo='all';scan({rediscover:true});});
$('repo-filter').addEventListener('change',e=>{state.repo=e.target.value;state.show=40;render();});
$('days-filter').addEventListener('change',e=>{state.days=Number(e.target.value);state.show=40;render();});
$('search').addEventListener('input',e=>{state.query=e.target.value;state.show=40;render();});
$('load-more').addEventListener('click',()=>{state.show+=40;render();});
$('watch-form').addEventListener('submit',e=>{
  e.preventDefault();
  const name=parseRepoName($('watch-input').value);
  if(!name){setNotice('Enter a valid GitHub repository, such as RichardDaffern/Novel_Library.');return;}
  if(state.extraRepos.some(r=>r.toLowerCase()===name.toLowerCase()) || state.repos.some(r=>r.full_name.toLowerCase()===name.toLowerCase())){
    setNotice(`${name} is already monitored.`);return;
  }
  state.extraRepos.push(name);$('watch-input').value='';renderWatchList();scan({rediscover:true});
});

document.querySelectorAll('[data-status]').forEach(b=>b.addEventListener('click',()=>filterStatus(b.dataset.status)));
$('sidebar-live').addEventListener('click',()=>filterStatus('live'));
$('sidebar-failures').addEventListener('click',()=>filterStatus('failed'));
$('sidebar-all').addEventListener('click',()=>filterStatus('all'));
document.addEventListener('visibilitychange',()=>{if(!document.hidden && token && $('autorefresh').checked && !state.scanning && (!state.lastChecked || Date.now()-state.lastChecked.getTime()>120000))scan();});
setInterval(()=>{if(!document.hidden && !state.scanning && state.runs.length)render();},30000);
updateConnection();renderWatchList();scan({rediscover:true});
