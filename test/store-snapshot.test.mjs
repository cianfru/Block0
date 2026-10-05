// The transfer-store snapshot (store.mjs exportStore/importStore) that carries the agent's warm store between jobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportStore, importStore, storeStats, keep } from "../store.mjs";

const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), P = "0x" + "c".repeat(40), W = (n) => "0x" + String(n).padStart(40, "d");
const ev = [{ from: P, to: W(1), amt: 100.5, block: 10, ts: 1000, li: 0 }, { from: W(1), to: P, amt: 40, block: 12, ts: null, li: 3 }];
const snap = (now) => ({ v: 1, savedAt: now, dict: [P, W(1)], tokens: {
  [A]: { lastBlock: 50, deployBlock: 5, pool: P, usedAt: now - 3600e3, ev: { from: [0, 1], to: [1, 0], amt: [100.5, 40], block: [10, 12], ts: [1000, null], li: [0, 3] } },
  [B]: { lastBlock: 70, deployBlock: 6, pool: "", usedAt: now - 2 * 86400e3, ev: { from: [], to: [], amt: [], block: [], ts: [], li: [] } } } });

test("snapshot: import → export round-trips every transfer and the block each token runs to", () => {
  keep([]);
  const now = Date.UTC(2026, 9, 5);
  assert.equal(importStore(snap(now)), 2);
  assert.equal(storeStats().tokens, 2);
  const out = exportStore({ now });
  assert.equal(out.v, 1);
  assert.equal(out.tokens[A].lastBlock, 50);
  assert.equal(out.tokens[A].pool, P);
  // decode A back and compare with the original transfers
  const c = out.tokens[A].ev, back = c.block.map((_, k) => ({ from: out.dict[c.from[k]], to: out.dict[c.to[k]], amt: c.amt[k], block: c.block[k], ts: c.ts[k], li: c.li[k] }));
  assert.deepEqual(back, ev);
  assert.equal(out.tokens[B], undefined);                  // not read for 2 days: left out of the snapshot
  keep([]);
});

test("snapshot: a malformed or foreign file restores nothing", () => {
  keep([]);
  for (const bad of [null, {}, { v: 2, dict: [], tokens: {} }, { v: 1, dict: "x", tokens: {} }]) assert.equal(importStore(bad), 0);
  assert.equal(storeStats().tokens, 0);
});
