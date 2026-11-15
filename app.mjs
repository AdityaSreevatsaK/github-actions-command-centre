import {OWNER,PUBLIC_BATCH_SIZE,AUTH_BATCH_SIZE,LIVE,currentStatus,groupStatus,statusLabel,normaliseRun,elapsedMs,formatDuration,filterRuns,sortRuns,uniqueRuns,summary,githubError,parseAccountName,parseRepoName,selectBatch,rateDecision} from './core.mjs';

const API='https://api.github.com';
const $=id=>document.getElementById(id);
let token=''; // Memory only: never write tokens to URLs, storage, logs or DOM after validation.
let controller=null;
let timer=null;
let modalReturnFocus=null;
const etags=new Map(); // Memory only, cleared whenever identity or credentials change.
const state={
  owner:OWNER,repos:[],runs:[],status:'all',query:'',repo:'all',days:7,scope:'owned',
  show:40,scanning:false,lastChecked:null,rateRemaining:null,rateLimit:null,rateReset:null,
  quotaPausedUntil:0,checked:new Set(),scannedRepos:0,fullScan:false,extraRepos:[],
  warnings:[],notice:'',stale:false,activeBatch:0
};

function elem(tag,className='',content){
  const el=document.createElement(tag);
  if(className)el.className=className;
  if(content!==undefined)el.textContent=content;
  return el;
}
function setNotice(message=''){
  state.notice=message;
  const el=$('notice');el.textContent=message;el.hidden=!message;
}
function requestHeaders(etag){
  const headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(etag)headers['If-None-Match']=etag;
  return headers;
}
function quotaText(){
  return state.quotaPausedUntil>Date.now()
    ? `GitHub is limiting API requests. Scanning paused until ${new Date(state.quotaPausedUntil).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}. Already loaded results remain available.`
    : '';
}
function pauseIfExhausted(){
  const reserve=token?5:3;
  if(state.rateRemaining!==null && state.rateRemaining<=reserve && state.rateReset && state.rateReset*1000>Date.now())
    state.quotaPausedUntil=Math.max(state.quotaPausedUntil,state.rateReset*1000);
  if(state.quotaPausedUntil>Date.now()){
    const error=new Error(quotaText());error.rateLimited=true;throw error;
  }
}
async function api(url,signal){
  pauseIfExhausted();
  const previous=etags.get(url);
  let response;
  try{
    response=await fetch(url,{method:'GET',headers:requestHeaders(previous?.etag),signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
  }catch(error){
    if(error.name==='AbortError')throw error;
    throw new Error('Could not reach GitHub. Check your connection and try refreshing.');
  }
  const rem=response.headers.get('x-ratelimit-remaining');
  const limit=response.headers.get('x-ratelimit-limit');
  const reset=response.headers.get('x-ratelimit-reset');
  if(rem!==null && Number.isFinite(Number(rem)))state.rateRemaining=Number(rem);
  if(limit!==null && Number.isFinite(Number(limit)))state.rateLimit=Number(limit);
  if(reset!==null && Number.isFinite(Number(reset)))state.rateReset=Number(reset);
  if(response.status===304 && previous)return previous.data;
  if(!response.ok){
    let detail='';
    try{detail=String((await response.json()).message || '').slice(0,250);}catch{/* Non-JSON response */}
    const rate=rateDecision(response.status,response.headers,detail);
    if(rate.limited){
      state.quotaPausedUntil=Math.max(state.quotaPausedUntil,rate.retryAt);
      const error=new Error(quotaText());error.rateLimited=true;throw error;
    }
    const error=new Error(githubError(response.status,detail));error.status=response.status;throw error;
  }
  const data=await response.json();
  const etag=response.headers.get('etag');
  if(etag){
    if(etags.size>250)etags.clear();
    etags.set(url,{etag,data});
  }
  return data;
}
function resetAccountData(){
  if(controller)controller.abort();
  controller=null;
  etags.clear();
  state.repos=[];state.runs=[];state.checked=new Set();state.repo='all';state.lastChecked=null;
  state.rateRemaining=null;state.rateLimit=null;state.rateReset=null;state.quotaPausedUntil=0;
  state.warnings=[];setNotice('');updateRepoDropdown();render();
}
async function discoverRepositories(signal){
  const repos=[];
  for(let page=1;page<=10;page++){
    const path=!token
      ? `/users/${encodeURIComponent(state.owner)}/repos?type=owner&sort=pushed&per_page=100&page=${page}`
      : `/user/repos?affiliation=${state.scope==='owned'?'owner':'owner%2Ccollaborator%2Corganization_member'}&sort=pushed&per_page=100&page=${page}`;
    const chunk=await api(`${API}${path}`,signal);
    if(!Array.isArray(chunk))throw new Error('GitHub returned an unexpected list of repositories.');
    repos.push(...chunk.filter(r=>token || r.owner?.login?.toLowerCase()===state.owner.toLowerCase()).map(r=>({
      name:String(r.name),full_name:String(r.full_name),private:!!r.private,archived:!!r.archived,disabled:!!r.disabled
    })).filter(r=>parseRepoName(r.full_name)));
    if(chunk.length<100)break;
    if(page===10)state.warnings.push('Repository discovery stopped at the 1,000-repository limit.');
  }
  for(const fullName of state.extraRepos){
    if(!repos.some(r=>r.full_name.toLowerCase()===fullName.toLowerCase()))
      repos.unshift({name:fullName.split('/')[1],full_name:fullName,private:false,archived:false,disabled:false,external:true});
  }
  return repos.filter(r=>!r.disabled);
}
function makeRunURL(repo){return `${API}/repos/${repo.full_name.split('/').map(encodeURIComponent).join('/')}/actions/runs`;}
async function runsForRepo(repo,deep,signal){
  if(!deep){
    const data=await api(`${makeRunURL(repo)}?per_page=100&page=1`,signal);
    if(!Array.isArray(data.workflow_runs))throw new Error('GitHub returned an unexpected workflow response.');
    return data.workflow_runs.map(run=>normaliseRun(run,repo));
  }
  const statuses=['in_progress','queued','waiting','pending','requested'];
  const result=[];
  for(const status of statuses){
    for(let page=1;page<=10;page++){
      const data=await api(`${makeRunURL(repo)}?status=${status}&per_page=100&page=${page}`,signal);
      if(!Array.isArray(data.workflow_runs))throw new Error('GitHub returned an unexpected workflow response.');
      result.push(...data.workflow_runs.map(run=>normaliseRun(run,repo)));
      if(data.workflow_runs.length<100)break;
      if(page===10)state.warnings.push(`Pagination limit reached: ${repo.full_name} (${status}).`);
    }
  }
  return result;
}
async function mapLimit(items,limit,iterator){
  let index=0;
  const workers=Array.from({length:Math.min(items.length,limit)},async()=>{
    while(index<items.length){
      const i=index++;
      await iterator(items[i]);
    }
  });
  await Promise.all(workers);
}
function updateRepoDropdown(){
  const selector=$('repo-filter');const current=state.repo;
  selector.replaceChildren(new Option('All repositories','all'));
  for(const repo of [...state.repos].sort((a,b)=>a.full_name.localeCompare(b.full_name)))
    selector.add(new Option(`${repo.full_name}${repo.private?' · private':''}`,repo.full_name));
  state.repo=state.repos.some(r=>r.full_name===current)?current:'all';
  selector.value=state.repo;
}
function updateConnection(){
  $('connection-note').textContent=token?'Read-only token connected':'Public repositories';
  $('connect-btn').textContent=token?'Connected · Manage':'Connect read-only token';
  $('scope-label').textContent=token?'Private + public':'Public-only';
  $('autorefresh').disabled=!token;
  if(!token)$('autorefresh').checked=false;
  $('scope').disabled=!token;
  if(!token){$('scope').value='owned';state.scope='owned';}
  $('owner-input').disabled=!!token;
  $('owner-submit').disabled=!!token;
  $('owner-input').value=state.owner;
  $('account-display').textContent=state.owner;
  $('account-subtitle').textContent=token?'Your authenticated account':'Public account preview';
  $('profile-link').href=`https://github.com/${encodeURIComponent(state.owner)}`;
  schedule();
}
function schedule(){
  if(timer)clearInterval(timer);
  timer=null;
  if(token && $('autorefresh').checked)
    timer=setInterval(()=>{if(!state.scanning && !document.hidden && state.quotaPausedUntil<=Date.now())scan();},180000);
}
function setScanning(busy){
  state.scanning=busy;
  $('refresh-btn').disabled=busy;
  $('refresh-btn').classList.toggle('spin',busy);
  $('deep-scan').disabled=busy;
  $('scope').disabled=busy||!token;
  $('autorefresh').disabled=busy||!token;
  $('refresh-btn').lastChild.textContent=busy?' Scanning':' Refresh';
  $('scan-next').disabled=busy;
  $('owner-input').disabled=busy||!!token;
  $('owner-submit').disabled=busy||!!token;
}
function renderWatchList(){
  const list=$('watch-list');list.replaceChildren();
  for(const fullName of state.extraRepos){
    const chip=elem('button','watch-chip',`${fullName} ×`);
    chip.type='button';chip.title=`Stop monitoring ${fullName}`;
    chip.addEventListener('click',()=>{
      state.extraRepos=state.extraRepos.filter(n=>n!==fullName);
      state.repos=state.repos.filter(r=>r.full_name!==fullName || !r.external);
      state.runs=state.runs.filter(r=>r.repo!==fullName || state.repos.some(repo=>repo.full_name===fullName));
      state.checked.delete(fullName);state.repo='all';
      updateRepoDropdown();renderWatchList();render();
    });
    list.append(chip);
  }
}
function renderWarnings(){
  const details=$('warning-details');const list=$('warning-list');list.replaceChildren();
  for(const warning of state.warnings)list.append(elem('li','',warning));
  details.hidden=!state.warnings.length;
  $('warning-count').textContent=String(state.warnings.length);
}
async function scan({deep=false,rediscover=false,more=false,target=null}={}){
  if(state.scanning)return;
  const signal=(controller=new AbortController()).signal;
  state.warnings=[];state.scannedRepos=0;state.fullScan=deep;
  setScanning(true);
  setNotice('');
  try{
    if(rediscover || !state.repos.length){
      state.repos=await discoverRepositories(signal);
      const names=new Set(state.repos.map(r=>r.full_name));
      state.checked=new Set([...state.checked].filter(r=>names.has(r)));
      state.runs=state.runs.filter(r=>names.has(r.repo));
      updateRepoDropdown();
    }
    if(!state.repos.length)throw new Error('No repositories were found for this account.');
    const batch=selectBatch(state.repos,state.checked,{authenticated:!!token,more,target});
    state.activeBatch=batch.length;
    if(!batch.length){setNotice('All discovered repositories have been sampled. Refresh to update their latest runs.');return;}
    const previousByRepo=new Map();
    for(const run of state.runs){if(!previousByRepo.has(run.repo))previousByRepo.set(run.repo,[]);previousByRepo.get(run.repo).push(run);}
    let paused=false;
    const updates=new Map();
    await mapLimit(batch,token?2:1,async repo=>{
      if(paused || signal.aborted)return;
      try{
        const runs=await runsForRepo(repo,deep,signal);
        const prior=previousByRepo.get(repo.full_name)||[];
        updates.set(repo.full_name,deep?uniqueRuns([...prior.filter(r=>!LIVE.has(currentStatus(r))),...runs]):runs);
        state.checked.add(repo.full_name);
      }catch(error){
        if(signal.aborted)return;
        if(error.rateLimited){paused=true;return;}
        state.warnings.push(`${repo.full_name}: ${error.message}`);
      }
      state.scannedRepos++;
      $('scan-info').textContent=`Checking ${state.scannedRepos} of ${batch.length} selected repositories`;
    });
    if(signal.aborted)return;
    const freshRuns=[];
    for(const repo of state.repos)freshRuns.push(...(updates.get(repo.full_name)||previousByRepo.get(repo.full_name)||[]));
    state.runs=uniqueRuns(freshRuns);
    state.lastChecked=new Date();
    const coverage=state.checked.size;
    const total=state.repos.length;
    state.stale=paused || state.quotaPausedUntil>Date.now();
    if(paused || state.quotaPausedUntil>Date.now())setNotice(quotaText()+` Coverage: ${coverage}/${total} repositories.`);
    else if(state.warnings.length)setNotice(`${state.warnings.length} repository request${state.warnings.length===1?'':'s'} failed. Previous successful results are preserved. See the details below.`);
    else if(coverage<total)setNotice(`Preview coverage: ${coverage} of ${total} repositories. Counts are partial. Use “Scan next ${token?AUTH_BATCH_SIZE:PUBLIC_BATCH_SIZE}” or connect a read-only token for broader coverage.`);
    else setNotice('');
    renderWarnings();
  }catch(error){
    if(!signal.aborted){state.stale=true;setNotice(error.rateLimited?quotaText():error.message);}
  }finally{
    if(!signal.aborted){setScanning(false);render();renderWarnings();}
  }
}
function addCell(row,child,className=''){
  const td=elem('td',className);
  if(typeof child==='string')td.textContent=child;else td.append(child);
  row.append(td);return td;
}
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
  const row=elem('tr');const detail=elem('div','workflow-cell');
  detail.append(elem('strong','',run.name),elem('small','',`${run.workflow}${run.branch?' · '+run.branch:''} · #${run.run_number}`));
  addCell(row,detail);
  const repo=elem('span');const repoLink=elem('a','repo-link',run.repo.split('/')[1]);
  repoLink.href=repoHref(run.repo);repoLink.target='_blank';repoLink.rel='noopener noreferrer';repoLink.title=run.repo;
  repo.append(repoLink);if(run.isPrivate)repo.append(elem('span','private-mark','◈'));
  addCell(row,repo);
  addCell(row,elem('span',`status-pill ${groupStatus(run)}`,statusLabel(run)));
  addCell(row,run.event||'–');
  const t=addCell(row,relativeTime(run.created_at));
  if(run.created_at && Number.isFinite(Date.parse(run.created_at)))t.title=new Date(run.created_at).toLocaleString('en-GB');
  addCell(row,durationLabel(run));
  const link=elem('a','open-link','↗');link.href=run.url;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label',`Open ${run.name} in GitHub`);
  addCell(row,link);return row;
}
function renderEmpty(body,heading,description){
  const row=elem('tr');const td=elem('td','empty-state');td.colSpan=7;
  td.append(elem('span','empty-icon','◎'),elem('strong','',heading),elem('small','',description));row.append(td);body.append(row);
}
function render(){
  const shown=sortRuns(filterRuns(state.runs,{status:state.status,query:state.query,repo:state.repo,days:state.days}));
  const total=summary(state.runs);
  // A failed scan must not masquerade as four confirmed zeroes.
  const hasSample=state.checked.size>0;
  $('metric-running').textContent=hasSample?String(total.running):'–';
  $('metric-queued').textContent=hasSample?String(total.queued):'–';
  $('metric-failed').textContent=hasSample?String(total.failed24):'–';
  $('metric-passed').textContent=hasSample?String(total.passed24):'–';
  const checkedCount=state.checked.size;
  const repoTotal=state.repos.length;
  const metricCaption=!hasSample
    ? (state.quotaPausedUntil>Date.now()
      ? 'Counts unavailable: GitHub API rate limit reached. Connect a read-only token or retry after the reset time.'
      : state.scanning?'Loading activity: no repositories checked yet.':'Counts unavailable: no repositories successfully checked yet.')
    : checkedCount<repoTotal
      ? `Partial results: ${checkedCount}/${repoTotal} repositories checked.${state.stale?' Showing previously loaded data.':''}`
      : `${repoTotal} repositories sampled.${state.stale?' Some results may be outdated.':''}`;
  $('metric-coverage-note').textContent=metricCaption;
  $('side-live-count').textContent=String(total.running+total.queued);
  $('row-count').textContent=String(shown.length);
  $('repo-count').textContent=String(state.repos.length);
  const body=$('runs-body');const fragment=document.createDocumentFragment();
  if(!shown.length)renderEmpty(fragment,state.runs.length?'No matching workflow runs':'No workflow runs yet',state.runs.length?'Try another status, date range or search term.':'Use the account selector or refresh to fetch workflow runs.');
  else for(const run of shown.slice(0,state.show))fragment.append(renderRow(run));
  body.replaceChildren(fragment);
  const load=$('load-more');load.hidden=shown.length<=state.show;load.textContent=`Show more (${shown.length-state.show} remaining) ↓`;
  const coverage=`${state.checked.size}/${state.repos.length} repositories checked`;
  $('scan-info').textContent=state.scanning?`Scanning ${state.scannedRepos}/${state.activeBatch} selected · ${coverage}`:state.lastChecked?`${coverage} · ${state.runs.length} runs sampled · Updated ${state.lastChecked.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`:'No scan completed';
  $('coverage-note').textContent=state.repos.length && state.checked.size<state.repos.length?`Partial coverage · ${coverage}`:`${coverage} · sampled results`;
  $('scan-next').hidden=state.repos.length===0 || state.checked.size>=state.repos.length;
  $('scan-next').textContent=`Scan next ${token?AUTH_BATCH_SIZE:PUBLIC_BATCH_SIZE} repositories`;
  const reset=state.rateReset?` · resets ${new Date(state.rateReset*1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`:'';
  $('rate-info').textContent=state.rateRemaining===null?'':`API quota: ${state.rateRemaining}${state.rateLimit?` / ${state.rateLimit}`:''}${reset}`;
}
function filterStatus(value){
  state.status=value;state.show=40;
  document.querySelectorAll('.tab').forEach(b=>{const selected=b.dataset.status===value;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected));});
  document.querySelectorAll('[data-metric]').forEach(b=>{
    const selected=b.dataset.metric===value;
    b.classList.toggle('active',selected);
    b.setAttribute('aria-pressed',String(selected));
  });
  render();
}
function openModal(){
  modalReturnFocus=document.activeElement;
  $('modal-backdrop').hidden=false;$('token-error').hidden=true;$('token-input').value='';
  $('token-input').focus();
}
function closeModal(){ $('modal-backdrop').hidden=true;$('token-input').value='';modalReturnFocus?.focus();modalReturnFocus=null; }

$('connect-btn').addEventListener('click',openModal);
$('modal-close').addEventListener('click',closeModal);
$('modal-backdrop').addEventListener('click',event=>{if(event.target===$('modal-backdrop'))closeModal();});
document.addEventListener('keydown',event=>{
  if($('modal-backdrop').hidden)return;
  if(event.key==='Escape'){event.preventDefault();closeModal();return;}
  if(event.key!=='Tab')return;
  const focusable=[...$('modal-backdrop').querySelectorAll('button:not([disabled]),input:not([disabled]),a[href]')];
  if(!focusable.length)return;
  if(event.shiftKey && document.activeElement===focusable[0]){event.preventDefault();focusable.at(-1).focus();}
  else if(!event.shiftKey && document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0].focus();}
});
$('disconnect').addEventListener('click',()=>{
  token='';resetAccountData();closeModal();updateConnection();scan({rediscover:true});
});
$('token-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const candidate=$('token-input').value.trim();if(!candidate)return;
  const submit=$('token-form').querySelector('[type="submit"]');
  submit.disabled=true;$('token-error').hidden=true;
  try{
    // The token is sent only to GitHub; it is not saved or sent to the Pages host.
    const response=await fetch(`${API}/user`,{method:'GET',headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${candidate}`,'X-GitHub-Api-Version':'2022-11-28'},credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
    if(!response.ok)throw new Error(githubError(response.status,response.status===403?'permission':''));
    const profile=await response.json();
    const account=parseAccountName(profile.login);
    if(!account)throw new Error('GitHub returned an invalid username.');
    token=candidate;resetAccountData();state.owner=account;
    closeModal();updateConnection();$('autorefresh').checked=true;schedule();
    scan({rediscover:true});
  }catch(error){$('token-error').textContent=error.message;$('token-error').hidden=false;}
  finally{submit.disabled=false;$('token-input').value='';}
});
$('owner-form').addEventListener('submit',event=>{
  event.preventDefault();if(token)return;
  const next=parseAccountName($('owner-input').value);
  if(!next){setNotice('Enter a valid GitHub username (letters, numbers or single hyphens).');return;}
  if(next.toLowerCase()===state.owner.toLowerCase())return;
  state.owner=next;resetAccountData();updateConnection();scan({rediscover:true});
});
$('refresh-btn').addEventListener('click',()=>scan({rediscover:false}));
$('scan-next').addEventListener('click',()=>scan({more:true}));
$('deep-scan').addEventListener('click',()=>{
  if(!token){openModal();setNotice('Connect a read-only token before a deep scan. It can use several API requests per repository.');return;}
  scan({deep:true,rediscover:false});
});
$('autorefresh').addEventListener('change',schedule);
$('scope').addEventListener('change',event=>{state.scope=event.target.value;resetAccountData();scan({rediscover:true});});
$('repo-filter').addEventListener('change',event=>{state.repo=event.target.value;state.show=40;render();});
$('days-filter').addEventListener('change',event=>{state.days=Number(event.target.value);state.show=40;render();});
$('search').addEventListener('input',event=>{state.query=event.target.value;state.show=40;render();});
$('load-more').addEventListener('click',()=>{state.show+=40;render();});
$('watch-form').addEventListener('submit',event=>{
  event.preventDefault();
  const name=parseRepoName($('watch-input').value);
  if(!name){setNotice('Enter a repository name like RichardDaffern/Novel_Library.');return;}
  if(state.repos.some(repo=>repo.full_name.toLowerCase()===name.toLowerCase())){setNotice(`${name} is already in the list.`);return;}
  state.extraRepos.push(name);state.repos.unshift({name:name.split('/')[1],full_name:name,private:false,archived:false,disabled:false,external:true});
  $('watch-input').value='';renderWatchList();updateRepoDropdown();scan({target:name});
});
document.querySelectorAll('[data-status]').forEach(button=>button.addEventListener('click',()=>filterStatus(button.dataset.status)));
document.querySelectorAll('[data-metric]').forEach(button=>button.addEventListener('click',()=>{
  const next=state.status===button.dataset.metric?'all':button.dataset.metric;
  // The failed and passed cards explicitly describe the last 24 hours.
  if(next==='failed'||next==='success'){
    state.days=1;
    $('days-filter').value='1';
  }
  filterStatus(next);
  document.querySelector('.monitor-panel').scrollIntoView({behavior:'smooth',block:'start'});
}));
$('sidebar-live').addEventListener('click',()=>filterStatus('live'));
$('sidebar-failures').addEventListener('click',()=>filterStatus('failed'));
$('sidebar-all').addEventListener('click',()=>filterStatus('all'));
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden && token && $('autorefresh').checked && !state.scanning && state.quotaPausedUntil<Date.now() && (!state.lastChecked || Date.now()-state.lastChecked.getTime()>180000))scan();
});
setInterval(()=>{if(!document.hidden && !state.scanning && state.runs.length)render();},30000);
document.querySelectorAll('.tab').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.status==='all')));
updateConnection();renderWatchList();render();scan({rediscover:true});
