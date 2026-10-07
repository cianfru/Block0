// rpc.mjs: a 403/429 from the free node pauses every request in the process, and the call still succeeds after it.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.RPC_BLOCK_BACKOFF_MS = "40";
const { rpc, rpcThrottle } = await import("../rpc.mjs");

test("a 403 pauses all requests, then the call succeeds", async () => {
  const real = globalThis.fetch, calls = [];
  let n = 0;
  globalThis.fetch = async () => { calls.push(Date.now()); n++;
    return n === 1 ? new Response("blocked", { status: 403 }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), { status: 200 }); };
  try {
    const t0 = Date.now();
    const [a, b] = await Promise.all([rpc("eth_blockNumber", []), (async () => { await new Promise((s) => setTimeout(s, 5)); return rpc("eth_chainId", []); })()]);
    assert.deepEqual([a, b], ["0x10", "0x10"]);
    // the second request started after the 403 and had to wait out the shared pause too
    assert.ok(calls.slice(1).every((c) => c - t0 >= 35), "a request went out during the pause");
    assert.equal(rpcThrottle().throttles, 0);   // reset on success
  } finally { globalThis.fetch = real; }
});
