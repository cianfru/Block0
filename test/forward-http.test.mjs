import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("HTTP serves experiment, v2 record and a separately labeled untouched legacy archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "block0-forward-http-"));
  const legacy = { tokens: {} };
  await writeFile(join(dir, "kv.json"), JSON.stringify({ "track-record": legacy }));
  const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", BACKGROUND_ON: "0", EXPERIMENT_ON: "0", DATA_DIR: dir,
      REDIS_URL: "", KV_REST_API_URL: "", KV_REST_API_TOKEN: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", RPC_WS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stderr.on("data", b => { errors += b; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server did not start: " + errors)), 10000);
      child.once("error", e => { clearTimeout(timeout); reject(e); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("server exited: " + errors)); });
      child.stdout.on("data", b => { output += b; const m = output.match(/block0 on :(\d+)/); if (m) { clearTimeout(timeout); resolve(m[1]); } });
    });
    const base = `http://127.0.0.1:${port}`;
    for (const path of ["/setups", "/track-record", "/experiment-ui.js", "/experiment.css"]) {
      const r = await fetch(base + path); assert.equal(r.status, 200, path); assert.ok((await r.text()).length > 100);
    }
    const setups = await (await fetch(base + "/api/setups")).json();
    assert.equal(setups.enabled, false); assert.equal(setups.coverage.complete, false); assert.deepEqual(setups.rows, []);
    const record = await (await fetch(base + "/api/track-record?calls=20")).json();
    assert.equal(record.schema, 2); assert.deepEqual(record.calls, []); assert.equal(record.ready, false);
    const old = await (await fetch(base + "/api/track-record/legacy")).json();
    assert.equal(old.archived, true); assert.equal(old.ready, false); assert.match(old.warning, /Legacy/);
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await rm(dir, { recursive: true, force: true });
  }
});
