import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFunders, funderLinks } from "../funders.mjs";
import { INFRA } from "../dex.mjs";

const ZERO = "0x0000000000000000000000000000000000000000"; // in INFRA → must be skipped as a funder

test("funderLinks: wallets sharing a funder get star-linked; singletons and off-map wallets don't", () => {
  const map = new Map([["w1", "f1"], ["w2", "f1"], ["w3", "f2"], ["w4", null], ["w5", "f3"]]);
  const nodeSet = new Set(["w1", "w2", "w3"]); // w5 not on the map
  const { edges, groups } = funderLinks(map, nodeSet);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { a: "w1", b: "w2", kind: "funder", via: "f1" });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].wallets.sort(), ["w1", "w2"]);
});

test("funderLinks: a high fan-out funder (exchange/faucet) is dropped, not clustered", () => {
  const ws = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"]; // 7 wallets, one funder
  const map = new Map(ws.map((w) => [w, "cex"]));
  const nodeSet = new Set(ws);
  const { edges, groups } = funderLinks(map, nodeSet, { maxFanout: 6 });
  assert.equal(edges.length, 0);
  assert.equal(groups.length, 0);
});

test("resolveFunders: caches forever (cache hit = 0 calls), skips self + infra sources, respects the cap", async () => {
  const store = new Map([["funder:w1", { funder: "cached1" }]]); // w1 already known
  const kvGet = async (k) => store.get(k) ?? null;
  const kvSet = async (k, v) => { store.set(k, v); };
  const TX = {
    w2: [{ from: "w2" }, { from: ZERO }, { from: "realfunder" }], // skip self, skip infra, take realfunder (lowercased)
    w3: [{ from: "solo" }],
  };
  let calls = 0;
  const rpc = async (_m, [p]) => { calls++; return { transfers: TX[p.toAddress] || [] }; };

  const { funders, calls: reported } = await resolveFunders(["w1", "w2", "w3"], { rpc, kvGet, kvSet, cap: 40 });
  assert.equal(funders.get("w1"), "cached1"); // served from cache
  assert.equal(funders.get("w2"), "realfunder");
  assert.equal(funders.get("w3"), "solo");
  assert.equal(reported, 2);   // only w2 + w3 hit the network; w1 was cached
  assert.equal(calls, 2);
  assert.ok(store.has("funder:w2")); // newly resolved funders are persisted
  assert.ok(INFRA.has(ZERO));  // sanity: the zero address really is treated as infra
});

test("resolveFunders: the cap bounds how many wallets are ever looked up", async () => {
  let calls = 0;
  const rpc = async () => { calls++; return { transfers: [{ from: "x" }] }; };
  const { calls: reported } = await resolveFunders(["a", "b", "c", "d", "e"], { rpc, cap: 2 });
  assert.equal(reported, 2); // only the first 2, regardless of list length
  assert.equal(calls, 2);
});
