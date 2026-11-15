import test from 'node:test';
import assert from 'node:assert/strict';
import {currentStatus,groupStatus,statusLabel,normaliseRun,elapsedMs,formatDuration,filterRuns,sortRuns,uniqueRuns,summary,githubError} from '../core.mjs';
const now=Date.parse('2026-11-15T17:00:00Z');
const repos={full_name:'AdityaSreevatsaK/Test-Repo',private:true};
const base={id:17,name:'CI',display_title:'Build tests',status:'completed',conclusion:'success',created_at:'2026-11-15T16:00:00Z',updated_at:'2026-11-15T16:02:00Z',run_started_at:'2026-11-15T16:01:00Z',run_number:9,head_branch:'master',event:'push',html_url:'https://github.com/AdityaSreevatsaK/Test-Repo/actions/runs/17'};
const fixture=(change={})=>normaliseRun({...base,...change},repos);
test('statuses match GitHub run semantics',()=>{
  assert.equal(currentStatus(fixture()),'success');
  assert.equal(groupStatus(fixture()),'success');
  assert.equal(groupStatus(fixture({status:'in_progress',conclusion:null})),'running');
  assert.equal(groupStatus(fixture({status:'queued',conclusion:null})),'queued');
  assert.equal(groupStatus(fixture({conclusion:'timed_out'})),'failed');
  assert.equal(statusLabel(fixture({status:'completed',conclusion:'action_required'})),'Action needed');
});
test('run URLs are constrained to github.com',()=>{
  assert.equal(fixture({html_url:'javascript:alert(1)'}).url,'https://github.com/AdityaSreevatsaK/Test-Repo/actions');
  assert.equal(fixture().isPrivate,true);
});
test('duration and approximate completed time',()=>{
  assert.equal(elapsedMs(fixture(),now),60000);
  assert.equal(elapsedMs(fixture({status:'in_progress',conclusion:null}),now),3540000);
  assert.equal(formatDuration(3540000),'59m 0s');
});
test('active status stays in view even when older than the date range',()=>{
  const older={created_at:'2026-10-01T00:00:00Z'};
  const runs=[fixture(older),fixture({...older,id:18,status:'queued',conclusion:null})];
  assert.equal(filterRuns(runs,{days:7},now).length,1);
  assert.equal(filterRuns(runs,{status:'live',days:7},now).length,1);
});
test('filters by search, repo and status',()=>{
  const r=[fixture(),fixture({id:18,status:'in_progress',conclusion:null,display_title:'Publish staging'})];
  assert.equal(filterRuns(r,{query:'staging',days:7},now).length,1);
  assert.equal(filterRuns(r,{status:'failed',days:7},now).length,0);
  assert.equal(filterRuns(r,{repo:'Elsewhere',days:7},now).length,0);
});
test('sorting puts running, queued, failed then passed',()=>{
  const r=[fixture(),fixture({id:18,status:'queued',conclusion:null}),fixture({id:19,status:'in_progress',conclusion:null}),fixture({id:20,conclusion:'failure'})];
  assert.deepEqual(sortRuns(r).map(x=>x.id),['19','18','20','17']);
});
test('deduplication is scoped to repository',()=>{
  const r=fixture();
  assert.equal(uniqueRuns([r,r,{...r,repo:'Different'}]).length,2);
});
test('24h summary counts failures and successes but not old completed runs',()=>{
  const r=[fixture(),fixture({id:18,conclusion:'failure'}),fixture({id:19,status:'queued',conclusion:null}),fixture({id:20,status:'in_progress',conclusion:null}),fixture({id:21,created_at:'2026-10-01T00:00:00Z'})];
  assert.deepEqual(summary(r,now),{running:1,queued:1,failed24:1,passed24:1});
});
test('errors explain access problems without echoing token',()=>{
  assert.match(githubError(403,'permission'),/denied access/);
  assert.match(githubError(403,'API rate limit exceeded'),/rate limit/);
  assert.match(githubError(401),/rejected the token/);
});

import {PUBLIC_BATCH_SIZE,AUTH_BATCH_SIZE,parseAccountName,parseRepoName,selectBatch,rateDecision} from '../core.mjs';
test('safe public account and repository inputs reject path/URL tricks',()=>{
  assert.equal(parseAccountName('example-user'),'example-user');
  assert.equal(parseAccountName('evil--user'),null);
  assert.equal(parseAccountName('foo/bar'),null);
  assert.equal(parseRepoName('https://github.com/Example/Hello.git'),'Example/Hello');
  assert.equal(parseRepoName('https://github.com/Example/Hello/issues/2'),null);
  assert.equal(parseRepoName('example/example?token=secret'),null);
});
test('public scans are budgeted and incremental',()=>{
  const all=Array.from({length:18},(_,i)=>({full_name:`someone/repo-${i}`}));
  const checked=new Set();
  const initial=selectBatch(all,checked);
  assert.equal(initial.length,PUBLIC_BATCH_SIZE);
  initial.forEach(r=>checked.add(r.full_name));
  assert.deepEqual(selectBatch(all,checked),initial);
  assert.equal(selectBatch(all,checked,{more:true})[0].full_name,'someone/repo-8');
  assert.equal(selectBatch(all,checked,{authenticated:true,more:true}).length,10);
  assert.equal(AUTH_BATCH_SIZE,75);
});
test('rate limit handling respects reset and retry-after, not permission errors',()=>{
  const now=Date.parse('2026-11-15T18:00:00Z');
  const h1=new Headers({'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000+300)});
  assert.equal(rateDecision(403,h1,'API rate limit exceeded',now).retryAt,now+300000);
  const h2=new Headers({'retry-after':'120','x-ratelimit-remaining':'22'});
  assert.equal(rateDecision(429,h2,'secondary rate limit',now).retryAt,now+120000);
  assert.equal(rateDecision(403,new Headers(),'Resource not accessible',now).limited,false);
});
test('run URLs reject lookalike GitHub domains and other repositories',()=>{
  assert.equal(fixture({html_url:'https://github.com.attacker.test/foo'}).url,'https://github.com/AdityaSreevatsaK/Test-Repo/actions');
  assert.equal(fixture({html_url:'https://github.com/Other/Repo/actions/runs/99'}).url,'https://github.com/AdityaSreevatsaK/Test-Repo/actions');
});
