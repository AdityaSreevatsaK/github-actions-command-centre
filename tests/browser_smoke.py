"""Browser smoke test against mocked GitHub API. Run: python tests/browser_smoke.py"""
import json
import os
import subprocess
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
now = datetime.now(timezone.utc)
iso=lambda delta: (now-timedelta(minutes=delta)).isoformat().replace('+00:00','Z')
repos = [
    {"name":"Novel_Library","full_name":"AdityaSreevatsaK/Novel_Library","owner":{"login":"AdityaSreevatsaK"},"private":False,"archived":False},
    {"name":"agentic-engineering-toolkit","full_name":"AdityaSreevatsaK/agentic-engineering-toolkit","owner":{"login":"AdityaSreevatsaK"},"private":False,"archived":False},
    {"name":"private-evaluation","full_name":"AdityaSreevatsaK/private-evaluation","owner":{"login":"AdityaSreevatsaK"},"private":True,"archived":False}
]
def run(i,title,status,conclusion,started=3):
    return {"id":i,"name":"Build / CI","display_title":title,"status":status,"conclusion":conclusion,"run_number":i,"run_attempt":1,"event":"push","head_branch":"master","actor":{"login":"AdityaSreevatsaK"},"created_at":iso(started+1),"run_started_at":iso(started),"updated_at":iso(started-1),"html_url":f"https://github.com/AdityaSreevatsaK/Novel_Library/actions/runs/{i}"}
mock_runs={
    'Novel_Library':[run(10,'Download novels','in_progress',None),run(11,'Cover download','queued',None)],
    'agentic-engineering-toolkit':[run(20,'Lint and tests','completed','failure')],
    'private-evaluation':[run(30,'Private test suite','completed','success')]
}

def reply(route):
    parts=urlsplit(route.request.url)
    path=parts.path
    query=parse_qs(parts.query)
    headers={"content-type":"application/json","x-ratelimit-remaining":"4999","x-ratelimit-reset":str(int(time.time())+3600),"access-control-allow-origin":"*"}
    if path.startswith('/users/') and path.endswith('/repos'):
        data=repos[:2]
    elif path=='/user/repos':
        auth=route.request.headers.get('authorization','')
        if auth!='Bearer github_pat_test_readonly':
            route.fulfill(status=401,headers=headers,body=json.dumps({'message':'Bad credentials'}))
            return
        data=repos if query.get('per_page')!=['1'] else repos[:1]
    elif path.endswith('/actions/runs'):
        repo_name=path.split('/')[3]
        items=mock_runs.get(repo_name,[])
        if 'status' in query:
            status=query['status'][0]
            items=[r for r in items if r['status']==status]
        data={'total_count':len(items),'workflow_runs':items}
    else:
        route.fulfill(status=404,headers=headers,body='{}')
        return
    route.fulfill(status=200,headers=headers,body=json.dumps(data))

def main():
    # Chromium in this environment blocks every network navigation, including
    # localhost. For deterministic smoke tests, inline the real source modules
    # into a document and replace only GitHub fetch responses with fixtures.
    import re
    html = (ROOT/'index.html').read_text()
    html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', '', html)
    html = html.replace('<link rel="stylesheet" href="./styles.css">', '<style>'+(ROOT/'styles.css').read_text()+'</style>')
    core = (ROOT/'core.mjs').read_text()
    app = (ROOT/'app.mjs').read_text()
    app = re.sub(r'^import .*? from [\'"]\./core\.mjs[\'"];\n', '', app, flags=re.MULTILINE)
    source = core + '\n' + app
    api_bootstrap = r"""
    <script>
    window.__fake = { repos: REPOS, runs: RUNS };
    window.fetch = async (url, options={}) => {
      const uri = new URL(url);
      const path = uri.pathname;
      const headers = new Headers({'content-type':'application/json','x-ratelimit-remaining':'4999','x-ratelimit-reset':String(Math.floor(Date.now()/1000)+3600)});
      let value;
      if (path.startsWith('/users/') && path.endsWith('/repos')) value = window.__fake.repos.slice(0,2);
      else if(path==='/user/repos'){
        if(options.headers?.Authorization!=='Bearer github_pat_test_readonly')return new Response(JSON.stringify({message:'Bad credentials'}),{status:401,headers});
        value=uri.searchParams.get('per_page')==='1' ? window.__fake.repos.slice(0,1) : window.__fake.repos;
      }
      else if(path.endsWith('/actions/runs')){
        const name=path.split('/')[3];
        let items=window.__fake.runs[name] || [];
        if(uri.searchParams.has('status'))items=items.filter(r=>r.status===uri.searchParams.get('status'));
        value={total_count:items.length,workflow_runs:items};
      }
      else return new Response('{}',{status:404,headers});
      return new Response(JSON.stringify(value),{status:200,headers});
    };
    </script>
    """.replace('REPOS',json.dumps(repos)).replace('RUNS',json.dumps(mock_runs))
    html = html.replace('<script type="module" src="./app.mjs"></script>', api_bootstrap + '<script type="module">'+source+'</script>')
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--no-proxy-server'])
        page=browser.new_page(viewport={'width':1440,'height':950},device_scale_factor=1)
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.set_content(html,wait_until='load')
        page.wait_for_function("document.querySelector('#repo-count').textContent==='2'")
        assert page.locator('#metric-running').inner_text()=='1'
        assert page.locator('#metric-queued').inner_text()=='1'
        assert page.locator('#metric-failed').inner_text()=='1'
        assert page.locator('#row-count').inner_text()=='3'
        assert page.locator('#autorefresh').is_disabled()
        page.locator('.tab[data-status="failed"]').click()
        assert page.locator('#row-count').inner_text()=='1'
        assert 'Lint and tests' in page.locator('#runs-body').inner_text()
        page.locator('.tab[data-status="all"]').click()
        page.locator('#search').fill('cover')
        assert page.locator('#row-count').inner_text()=='1'
        page.locator('#search').fill('')
        page.locator('#watch-input').fill('RichardDaffern/Novel_Library')
        page.locator('#watch-form button').click()
        page.wait_for_function("document.querySelector('#repo-count').textContent==='3'")
        assert 'RichardDaffern/Novel_Library' in page.locator('#watch-list').inner_text()
        page.locator('.watch-chip').click()
        page.wait_for_function("document.querySelector('#repo-count').textContent==='2'")
        page.screenshot(path=str(ROOT/'preview-desktop.png'),full_page=True)
        page.locator('#connect-btn').click()
        page.locator('#token-input').fill('github_pat_test_readonly')
        page.locator('#token-form button[type="submit"]').click()
        page.wait_for_function("document.querySelector('#repo-count').textContent==='3'")
        assert page.locator('#metric-passed').inner_text()=='1'
        assert 'Private test suite' in page.locator('#runs-body').inner_text()
        assert page.locator('#token-input').input_value()==''
        assert 'localStorage' not in app and 'sessionStorage' not in app  # Opaque about:blank origin disallows storage APIs.
        assert page.locator('#autorefresh').is_checked()
        page.locator('#deep-scan').click()
        page.wait_for_function("!document.querySelector('#deep-scan').disabled")
        assert page.locator('#metric-running').inner_text()=='1'
        assert page.locator('#metric-passed').inner_text()=='1'
        page.locator('#connect-btn').click()
        page.locator('#disconnect').click()
        page.wait_for_function("document.querySelector('#repo-count').textContent==='2'")
        assert page.locator('#metric-passed').inner_text()=='0'
        assert errors==[],errors
        mobile=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
        mobile.set_content(html,wait_until='load')
        mobile.wait_for_function("document.querySelector('#repo-count').textContent==='2'")
        assert mobile.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile page overflows horizontally"
        mobile.screenshot(path=str(ROOT/'preview-mobile.png'),full_page=True)
        assert mobile.locator('h1').is_visible()
        assert mobile.locator('#connect-btn').is_visible()
        browser.close()
    print('PASS: public mode, status filters, search, private token, deep scan, disconnect, no storage, mobile layout')
    print('Previews: preview-desktop.png, preview-mobile.png')

if __name__=='__main__':main()
