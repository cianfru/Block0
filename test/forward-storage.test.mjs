import "./_isolate.mjs";   // a fresh DATA_DIR per run — must precede every store import
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("file experiment values are independent and survive process restart and legacy flushes", () => {
  const dir = mkdtempSync(join(tmpdir(), "block0-storage-"));
  const env = { ...process.env, DATA_DIR: dir, REDIS_URL: "", KV_REST_API_URL: "", KV_REST_API_TOKEN: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" };
  const run = code => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  try {
    writeFileSync(join(dir, "kv.json"), JSON.stringify({ "experiment:old": { migrated: true }, legacy: 1 }));
    run(`import {setJSONStrict,getJSONStrict,setJSON} from './store/kv.mjs';
      if (!(await getJSONStrict('experiment:old')).migrated) throw Error('fallback');
      await setJSONStrict('experiment:a', {blob:'x'.repeat(1000000)});
      await setJSONStrict('experiment:b', {small:true});
      await setJSON('legacy', 2);`);
    const files = readdirSync(join(dir, "experiment"));
    assert.equal(files.length, 2);
    const sizes = files.map(f => readFileSync(join(dir,"experiment",f)).length).sort((a,b)=>a-b);
    assert.ok(sizes[0] < 100); assert.ok(sizes[1] > 1000000);
    const legacy = JSON.parse(readFileSync(join(dir,"kv.json")));
    assert.equal(legacy.legacy, 2); assert.equal(legacy["experiment:a"], undefined);
    run(`import {getJSONStrict,setJSONStrict} from './store/kv.mjs';
      if ((await getJSONStrict('experiment:a')).blob.length !== 1000000) throw Error('restart');
      await setJSONStrict('experiment:b', {small:false});`);
    const big = files.find(f => readFileSync(join(dir,"experiment",f)).length > 1000000);
    writeFileSync(join(dir,"experiment",big), '{corrupt');
    run(`import {getJSONStrict} from './store/kv.mjs';
      let threw=false;try {await getJSONStrict('experiment:a');}catch {threw=true;}
      if (!threw) throw Error('corruption hidden');`);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
