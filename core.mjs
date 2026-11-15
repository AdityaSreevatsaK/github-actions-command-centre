export const OWNER = 'AdityaSreevatsaK';
export const PUBLIC_BATCH_SIZE = 8;
export const AUTH_BATCH_SIZE = 75;
export const LIVE = new Set(['queued', 'in_progress', 'pending', 'requested', 'waiting']);
export const FAILURES = new Set(['failure', 'timed_out', 'action_required', 'stale', 'startup_failure']);
const SAFE_RUN_URL = /^https:\/\/github\.com\/[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?\/?$/i;

export function parseAccountName(value) {
  const name=String(value||'').trim();
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(name) && !name.includes('--') ? name : null;
}
export function parseRepoName(value) {
  const s=String(value||'').trim().replace(/^https:\/\/github\.com\//i,'').replace(/\.git\/?$/i,'').replace(/\/$/,'');
  const parts=s.split('/');
  if(parts.length!==2 || !parseAccountName(parts[0]) || !/^[a-z0-9_.-]{1,100}$/i.test(parts[1]) || parts[1]==='.' || parts[1]==='..')return null;
  return `${parts[0]}/${parts[1]}`;
}
export function selectBatch(repos, checked, {authenticated=false, more=false, target=null}={}) {
  if(target)return repos.filter(r=>r.full_name.toLowerCase()===target.toLowerCase());
  const max=authenticated?AUTH_BATCH_SIZE:PUBLIC_BATCH_SIZE;
  if(more)return repos.filter(r=>!checked.has(r.full_name)).slice(0,max);
  if(!authenticated && checked.size)return repos.filter(r=>checked.has(r.full_name)).slice(0,max);
  if(authenticated && checked.size>=repos.length)return repos.slice(0,max);
  return repos.filter(r=>!checked.has(r.full_name)).slice(0,max);
}
export function rateDecision(status, headers, message='', now=Date.now()) {
  const rawRemaining=headers.get('x-ratelimit-remaining');
  const rawReset=headers.get('x-ratelimit-reset');
  const rawRetry=headers.get('retry-after');
  const remaining=rawRemaining===null?null:Number(rawRemaining);
  const resetAt=rawReset===null?null:Number(rawReset)*1000;
  const limited=status===429 || (status===403 && (remaining===0 || /(?:rate limit|secondary limit|abuse detection)/i.test(message)));
  if(!limited)return {limited:false,remaining,resetAt};
  let retryAt=remaining===0 && Number.isFinite(resetAt)?resetAt:null;
  if(rawRetry){
    const seconds=Number(rawRetry);
    const date=Number.isFinite(seconds) ? now+seconds*1000:Date.parse(rawRetry);
    if(Number.isFinite(date))retryAt=Math.max(date,retryAt||0);
  }
  if(!retryAt || retryAt<=now)retryAt=now+60000;
  return {limited:true,remaining,resetAt,retryAt};
}
export function currentStatus(run) {
  const s = String(run.status || '').toLowerCase();
  if (s !== 'completed') return s || 'unknown';
  return String(run.conclusion || 'completed').toLowerCase();
}
export function groupStatus(run) {
  const s = currentStatus(run);
  if (LIVE.has(s)) return s === 'in_progress' ? 'running' : 'queued';
  if (FAILURES.has(s)) return 'failed';
  if (s === 'success') return 'success';
  if (s === 'cancelled') return 'cancelled';
  return 'other';
}
export function statusLabel(run) {
  const s = currentStatus(run);
  const labels = {in_progress:'Running',queued:'Queued',pending:'Pending',requested:'Requested',waiting:'Waiting',success:'Passed',failure:'Failed',timed_out:'Timed out',action_required:'Action needed',startup_failure:'Start failed',stale:'Stale',cancelled:'Cancelled',skipped:'Skipped',neutral:'Neutral',completed:'Completed'};
  return labels[s] || (s.charAt(0).toUpperCase() + s.slice(1).replaceAll('_',' '));
}
export function normaliseRun(run, repo) {
  const safeRepo=parseRepoName(repo.full_name);
  if(!safeRepo)throw new Error('Invalid GitHub repository data.');
  const defaultUrl=`https://github.com/${safeRepo}/actions`;
  const htmlUrl=String(run.html_url||'');
  return {
    id: String(run.id),
    repo: safeRepo,
    isPrivate: !!repo.private,
    name: String(run.display_title || run.name || 'Untitled workflow'),
    workflow: String(run.name || 'Workflow'),
    branch: String(run.head_branch || ''),
    event: String(run.event || ''),
    actor: String(run.actor?.login || ''),
    status: String(run.status || ''),
    conclusion: run.conclusion == null ? null : String(run.conclusion),
    created_at: run.created_at || null,
    run_started_at: run.run_started_at || null,
    updated_at: run.updated_at || null,
    url: SAFE_RUN_URL.test(htmlUrl) && htmlUrl.toLowerCase().startsWith(`https://github.com/${safeRepo.toLowerCase()}/`) ? htmlUrl : defaultUrl,
    run_number: Number(run.run_number || 0),
    attempt: Number(run.run_attempt || 1)
  };
}
export function elapsedMs(run, now = Date.now()) {
  const start = Date.parse(run.run_started_at || run.created_at || '');
  if (!Number.isFinite(start)) return null;
  const isLive = LIVE.has(currentStatus(run));
  const end = isLive ? now : Date.parse(run.updated_at || '');
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '–';
  const seconds = Math.floor(ms/1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds/60);
  if (minutes < 60) return `${minutes}m ${seconds%60}s`;
  const hours = Math.floor(minutes/60);
  if (hours < 24) return `${hours}h ${minutes%60}m`;
  return `${Math.floor(hours/24)}d ${hours%24}h`;
}
export function filterRuns(runs, {status='all',query='',repo='all',days=7}={}, now=Date.now()) {
  const q = query.trim().toLowerCase();
  const cutoff = now - Number(days || 99999)*86400000;
  return runs.filter(r=>{
    const group = groupStatus(r);
    if (status === 'live' && !LIVE.has(currentStatus(r))) return false;
    if (status === 'failed' && group !== 'failed') return false;
    if (status === 'success' && group !== 'success') return false;
    if (status === 'cancelled' && group !== 'cancelled') return false;
    if (repo !== 'all' && repo !== r.repo) return false;
    if (q && ![r.repo,r.name,r.workflow,r.branch,r.event,r.actor,String(r.run_number)].some(x=>String(x).toLowerCase().includes(q))) return false;
    const created = Date.parse(r.created_at || '');
    if (!LIVE.has(currentStatus(r)) && Number.isFinite(created) && created < cutoff) return false;
    return true;
  });
}
export function sortRuns(runs) {
  const rank = r => currentStatus(r)==='in_progress' ? 0 : LIVE.has(currentStatus(r)) ? 1 : groupStatus(r)==='failed' ? 2 : 3;
  return [...runs].sort((a,b) => rank(a)-rank(b) || (Date.parse(b.created_at || '')||0)-(Date.parse(a.created_at || '')||0));
}
export function uniqueRuns(runs) {
  const seen = new Map();
  for (const run of runs) seen.set(`${run.repo}/${run.id}`,run);
  return [...seen.values()];
}
export function summary(runs, now = Date.now()) {
  const last24 = now-86400000;
  return {
    running:runs.filter(r=>currentStatus(r)==='in_progress').length,
    queued:runs.filter(r=>LIVE.has(currentStatus(r)) && currentStatus(r)!=='in_progress').length,
    failed24:runs.filter(r=>groupStatus(r)==='failed' && Date.parse(r.created_at || '') >= last24).length,
    passed24:runs.filter(r=>groupStatus(r)==='success' && Date.parse(r.created_at || '') >= last24).length,
  };
}
export function githubError(status, message='') {
  if (status===401) return 'GitHub rejected the token. Check that it is valid and has not expired.';
  if ((status===403 && /rate limit|abuse detection/i.test(message)) || status===429) return 'GitHub API rate limit reached. Further requests are paused.';
  if (status===403) return 'GitHub denied access. Check the repository selection and Actions: Read permission.';
  if (status===404) return 'Repository not found or not accessible with this token.';
  return `GitHub API returned HTTP ${status}.`;
}
