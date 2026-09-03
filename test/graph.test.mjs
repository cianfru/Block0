import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../graph.mjs";

// pool "pool" opens at block 10; w1 & w2 buy in the SAME block (a bundle), w3 buys later, then the token is
// passed w1→w3→w4 (coordination edges), and w2 sells some back to the pool. w5 is an unrelated lone buyer.
const T = [
  { from: "pool", to: "w1", amt: 100, ts: 1, block: 10 },
  { from: "pool", to: "w2", amt: 100, ts: 1, block: 10 },
  { from: "pool", to: "w3", amt: 50, ts: 2, block: 20 },
  { from: "w1", to: "w3", amt: 30, ts: 3, block: 25 },
  { from: "w3", to: "w4", amt: 10, ts: 4, block: 26 },
  { from: "w2", to: "pool", amt: 20, ts: 5, block: 30 },
  { from: "pool", to: "w5", amt: 40, ts: 6, block: 40 },
];

test("bundle + transfer links resolve into one flagged cluster", () => {
  const g = buildGraph(T, { pool: "pool" });
  assert.equal(g.stats.bundleGroups, 1);
  // roles mirror the verdict: same-block cohort = bundle, later buyers = holder
  const role = Object.fromEntries(g.nodes.map((n) => [n.a, n.role]));
  assert.equal(role.w1, "bundle");
  assert.equal(role.w2, "bundle");
  assert.equal(role.w3, "holder");
  assert.equal(role.w5, "holder");
  // a transfer edge w1→w3 exists; a bundle edge ties the same-block cohort together
  assert.ok(g.edges.some((e) => e.kind === "transfer" && e.a === "w1" && e.b === "w3" && e.amt === 30));
  assert.ok(g.edges.some((e) => e.kind === "bundle" && ((e.a === "w2" && e.b === "w1") || (e.a === "w1" && e.b === "w2"))));
  // w1,w2,w3,w4 form one connected cluster; w5 stands alone (not a ≥2 cluster)
  assert.equal(g.clusters.length, 1);
  const c = g.clusters[0];
  assert.equal(c.size, 4);
  assert.equal(c.hasBundle, true);
  assert.equal(c.flag, true);
  assert.deepEqual([...c.wallets].sort(), ["w1", "w2", "w3", "w4"]);
  assert.equal(g.nodes.find((n) => n.a === "w5").cluster, null);
});

test("dust edge floor drops a small transfer and splits the cluster", () => {
  const g = buildGraph(T, { pool: "pool", minEdgeAmt: 15 }); // w3→w4 (10) dropped
  assert.ok(!g.edges.some((e) => e.kind === "transfer" && e.b === "w4"));
  const c = g.clusters[0];
  assert.equal(c.size, 3); // w1,w2,w3 remain linked; w4 breaks off
  assert.ok(!c.wallets.includes("w4"));
});

test("cluster flow lights green when the group is net accumulating over the window", () => {
  const g = buildGraph(T, { pool: "pool" }); // wide default window → lifetime net, which is positive here
  const c = g.clusters[0];
  assert.equal(c.flow, "buy");
  assert.ok(c.net > 0);
});

test("cluster flow lights RED when the bundle is selling now (recent window)", () => {
  // s1 & s2 bundle-buy early, then both dump to the pool much later; a 1h window sees only the dumping
  const S = [
    { from: "pool", to: "s1", amt: 100, ts: 1000, block: 10 },
    { from: "pool", to: "s2", amt: 100, ts: 1000, block: 10 },
    { from: "s1", to: "pool", amt: 60, ts: 100000, block: 500 },
    { from: "s2", to: "pool", amt: 50, ts: 100000, block: 501 },
  ];
  const g = buildGraph(S, { pool: "pool", window: 3600 });
  const c = g.clusters[0];
  assert.equal(c.hasBundle, true);
  assert.equal(c.flow, "sell");     // the insiders are distributing → red
  assert.ok(c.net < 0);
  assert.equal(g.nodes.find((n) => n.a === "s1").flow, "sell");
});

test("injected funder edges link otherwise-unconnected wallets into one flagged cluster", () => {
  // two lone buyers that never interact on-chain, but share a funder (edge injected from the funder pass)
  const L = [
    { from: "pool", to: "a", amt: 100, ts: 1, block: 10 },
    { from: "pool", to: "b", amt: 90, ts: 2, block: 40 }, // different block → not a bundle, no transfer between them
  ];
  const bare = buildGraph(L, { pool: "pool" });
  assert.equal(bare.clusters.length, 0); // nothing links a and b on their own
  const g = buildGraph(L, { pool: "pool", extraEdges: [{ a: "a", b: "b", kind: "funder", via: "0xfunder" }] });
  assert.equal(g.clusters.length, 1);
  assert.equal(g.clusters[0].size, 2);
  assert.equal(g.clusters[0].hasFunder, true);
  assert.equal(g.clusters[0].flag, true);
});

test("balances and supply share are computed on the nodes", () => {
  const g = buildGraph(T, { pool: "pool" });
  const w1 = g.nodes.find((n) => n.a === "w1");
  assert.equal(w1.bal, 70);   // 100 in − 30 sent
  assert.equal(w1.sold, 0);
  const w2 = g.nodes.find((n) => n.a === "w2");
  assert.equal(w2.bal, 80);   // 100 − 20 sold
  assert.equal(w2.sold, 20);
  // held = 70+80+70+10+40 = 270 → w2 share ≈ 29.6%
  assert.equal(w2.pct, +(80 / 270 * 100).toFixed(2));
});
