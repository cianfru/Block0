import unittest,tempfile,time,json
from pathlib import Path
from research import PublicSource,connect,save,report,import_export,NoRedirect
A='0x'+'a'*40
class LocalTests(unittest.TestCase):
 def test_network_allowlist_and_budget(self):
  s=PublicSource(0,time.monotonic()+30)
  with self.assertRaises(RuntimeError):s.get('https://www.ponsfamily.com/api/pons-launches')
  with self.assertRaises(RuntimeError):PublicSource(1,time.monotonic()+30).get('https://eth-mainnet.g.alchemy.com/v2/test')
  with self.assertRaises(RuntimeError):NoRedirect().redirect_request(None,None,None,None,None,None)
 def test_import_and_offline_escaping(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d); db=connect(p/'r.sqlite');r={'address':A,'decisions':[{'id':'frozen'}],'observations':[{'observedAt':1,'sym':'<script>','priceUsd':2}]}
   (p/'in.json').write_text(json.dumps({'schema':1,'records':[r]}));import_export(db,p/'in.json');import_export(db,p/'in.json')
   self.assertEqual(db.execute('SELECT count(*) FROM observations').fetchone()[0],1)
   self.assertEqual(json.loads(db.execute('SELECT payload FROM imports').fetchone()[0])['decisions'],r['decisions'])
   self.assertIn('&lt;script&gt;',report(db));self.assertNotIn('<script>',report(db));db.close()
 def test_storage_cap(self):
  import sqlite3
  with tempfile.TemporaryDirectory() as d:
   db=connect(Path(d)/'r.sqlite',1)
   with self.assertRaises(sqlite3.DatabaseError):
    with db:save(db,A,1,{'large':'x'*2_000_000})
   self.assertEqual(db.execute('SELECT count(*) FROM observations').fetchone()[0],0);db.close()
if __name__=='__main__':unittest.main()
