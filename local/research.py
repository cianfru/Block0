#!/usr/bin/env python3
"""Local-only price research. Python standard library; no environment credentials or paid fallbacks."""
import argparse, html, json, math, sqlite3, time, urllib.request, urllib.parse
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = 'https://www.ponsfamily.com'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Redirect blocked: no unapproved network destinations')

class PublicSource:
    def __init__(self, requests, deadline):
        self.remaining, self.deadline = requests, deadline
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def get(self, url):
        u = urllib.parse.urlsplit(url)
        if u.scheme != 'https' or u.netloc != 'www.ponsfamily.com' or u.path not in ('/api/pons-launches', '/api/pons-launches/live-markets'):
            raise RuntimeError('Unapproved endpoint: paid providers and arbitrary URLs are disabled')
        left = self.deadline - time.monotonic()
        if self.remaining <= 0 or left <= 0:
            raise RuntimeError('Session budget exhausted')
        self.remaining -= 1  # failed requests also consume budget; no retries
        req = urllib.request.Request(url, headers={'User-Agent': 'Block0-local-research/1.0', 'Accept': 'application/json'})
        with self.opener.open(req, timeout=min(15, left)) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise RuntimeError('Response size limit exceeded')
        return json.loads(raw)

def address(a):
    return isinstance(a, str) and len(a) == 42 and a[:2].lower() == '0x' and all(c in '0123456789abcdefABCDEF' for c in a[2:])

def connect(path, max_mb=50):
    if Path(path).exists() and Path(path).stat().st_size > max_mb * 1024 * 1024:
        raise RuntimeError('Existing database exceeds storage budget')
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=DELETE')
    page = db.execute('PRAGMA page_size').fetchone()[0]
    db.execute('PRAGMA max_page_count=%d' % (max_mb * 1024 * 1024 // page))
    db.executescript('CREATE TABLE IF NOT EXISTS observations(address TEXT, at INTEGER, payload TEXT, PRIMARY KEY(address,at)); CREATE TABLE IF NOT EXISTS imports(address TEXT PRIMARY KEY,payload TEXT);')
    return db

def save(db, a, at, payload):
    if not address(a) or not isinstance(at, (int,float)) or not math.isfinite(at):
        raise ValueError('Invalid observation identity/time')
    db.execute('INSERT OR IGNORE INTO observations VALUES(?,?,?)', (a.lower(), int(at), json.dumps(payload)))

def collect(db, minutes, requests, tokens, interval):
    deadline = time.monotonic() + minutes * 60
    source = PublicSource(requests, deadline)
    catalog = source.get(BASE + '/api/pons-launches?' + urllib.parse.urlencode(dict(explore=1,sort='newest',age='all',page=1,pageSize=tokens,includeGraduated=0,v=22)))
    items = catalog.get('active', {}).get('items')
    if not isinstance(items,list):
        raise RuntimeError('Catalog schema changed')
    cohort = {t['token'].lower():t for t in items[:tokens] if address(t.get('token'))}
    if not cohort:
        raise RuntimeError('No valid tokens available')
    query = urllib.parse.urlencode([('market', a + ',' + (t.get('pool') if address(t.get('pool')) else '0x'+'0'*40)) for a,t in cohort.items()])
    while source.remaining and time.monotonic() < deadline:
        rows = source.get(BASE + '/api/pons-launches/live-markets?' + query)
        if not isinstance(rows,list):
            raise RuntimeError('Quote schema changed')
        at = int(time.time()*1000); seen = set()
        with db:
            for row in rows:
                a = str(row.get('token','')).lower()
                if a not in cohort:
                    continue
                seen.add(a)
                price = row.get('priceUsd')
                if not isinstance(price,(int,float)) or not math.isfinite(price) or price <= 0:
                    price = None
                save(db,a,at,dict(address=a,sym=cohort[a].get('symbol','?'),observedAt=at,priceUsd=price,
                     priceSource='pons-live-markets',executable=False,assessment='research-only',
                     missing=['forensics unavailable','executable liquidity unverified'] + ([] if price else ['price unavailable'])))
            for a in cohort.keys()-seen:
                save(db,a,at,dict(address=a,sym=cohort[a].get('symbol','?'),observedAt=at,priceUsd=None,assessment='research-only',missing=['source omitted token','forensics unavailable','executable liquidity unverified']))
        print(f'Saved {len(cohort)} observations; {source.remaining} requests left.', flush=True)
        if source.remaining:
            time.sleep(max(0,min(interval,deadline-time.monotonic())))
    print('Session stopped. No background collection remains.')

def import_export(db, path):
    data = json.loads(Path(path).read_text())
    if data.get('schema') != 1 or not isinstance(data.get('records'),list):
        raise ValueError('Requires the full tools/export-forward.mjs JSON export, not an API snapshot')
    with db:
        for r in data['records']:
            if not address(r.get('address')): raise ValueError('Invalid record')
            db.execute('INSERT OR REPLACE INTO imports VALUES(?,?)',(r['address'].lower(),json.dumps(r)))
            for o in r.get('observations',[]): save(db,r['address'],o['observedAt'],o)
    print('Imported records and frozen decisions without recomputation.')

def report(db):
    count = db.execute('SELECT count(*) FROM observations').fetchone()[0]
    cells=[]
    for a,n,start,end in db.execute('SELECT address,count(*),min(at),max(at) FROM observations GROUP BY address ORDER BY max(at) DESC LIMIT 200'):
        o=json.loads(db.execute('SELECT payload FROM observations WHERE address=? ORDER BY at DESC LIMIT 1',(a,)).fetchone()[0])
        cells.append('<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in [o.get('sym','?'),a,n,o.get('priceUsd'),'; '.join(o.get('missing',[]))])+'</tr>')
    return '<!doctype html><meta charset="utf-8"><title>Block Zero local research</title><style>body{font:16px system-ui;margin:32px;background:#14161a;color:#eee}td,th{padding:10px;text-align:left;border-bottom:1px solid #555}table{width:100%;overflow-wrap:anywhere}</style><h1>Block Zero · local research</h1><p>Offline report. Indicative prices only. No token rankings or alpha claims. Imported decisions remain in SQLite; they are not recomputed.</p><p>'+str(count)+' observations stored. Showing up to 200 tokens.</p><table><tr><th>Symbol</th><th>Address</th><th>Samples</th><th>Last reported price</th><th>Missing evidence</th></tr>'+''.join(cells)+'</table>'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',default='data/local-research.sqlite')
    parser.add_argument('--max-mb',type=int,default=50,choices=range(1,1025),metavar='1..1024')
    sub=parser.add_subparsers(dest='command',required=True)
    c=sub.add_parser('collect');c.add_argument('--minutes',type=int,default=30,choices=range(1,61),metavar='1..60');c.add_argument('--requests',type=int,default=31,choices=range(2,61),metavar='2..60');c.add_argument('--tokens',type=int,default=4,choices=range(1,21),metavar='1..20');c.add_argument('--interval',type=int,default=60,choices=range(60,3601),metavar='60..3600')
    sub.add_parser('import').add_argument('file')
    sub.add_parser('report').add_argument('--out',default='local-report.html')
    sub.add_parser('serve').add_argument('--port',type=int,default=8081)
    a=parser.parse_args();db=connect(a.db,a.max_mb)
    try:
        if a.command=='collect':collect(db,a.minutes,a.requests,a.tokens,a.interval)
        elif a.command=='import':import_export(db,a.file)
        elif a.command=='report':Path(a.out).write_text(report(db));print(a.out)
        else:
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path not in ('/','/report'):self.send_error(404);return
                    body=report(db).encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            print(f'Offline dashboard: http://127.0.0.1:{a.port} — Ctrl+C stops it.',flush=True)
            HTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
    finally:db.close()
if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:print('Stopped.')
