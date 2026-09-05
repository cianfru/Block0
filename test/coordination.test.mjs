import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinationSignal } from "../graph.mjs";
import { computeRisk } from "../intel.mjs";

const POOL = "0xpool000000000000000000000000000000000000";
const W = (n) => "0x" + String(n).padStart(40, "a");
const tx = (from, to, amt, block, ts) => ({ from: from.toLowerCase(), to: to.toLowerCase(), amt, block, ts });

// A wallet buying from the pool, then shuffling the token to fresh wallets it controls (no same-block bundle) — the
// "careful operator" the bundle rule misses. coordinationSignal must catch the hand-to-hand web.
test("hand-to-hand transfer web is caught as hidden coordination", () => {
  const A = W(1), B = W(2), C = W(3), D = W(4), E = W(5);
  const t = [
    tx(POOL, A, 100, 10, 1000), tx(POOL, B, 100, 10, 1001), tx(POOL, C, 100, 11, 1002), // 3 independent buys
    tx(A, D, 40, 12, 1003), tx(A, E, 30, 13, 1004),                                       // A shuffles to D, E (its wallets)
  ];
  const s = coordinationSignal(t, { pool: POOL, window: 1800 });
  assert.ok(s.hiddenPct > 25, `A+D+E hold ~33% via a transfer web, got ${s.hiddenPct}`);
  assert.ok(s.nClusters >= 1);
});

test("independent holders (only pool buys, no holder-to-holder moves) read as NO hidden coordination", () => {
  const t = [tx(POOL, W(1), 100, 10, 1000), tx(POOL, W(2), 100, 12, 1200), tx(POOL, W(3), 100, 15, 1500)];
  const s = coordinationSignal(t, { pool: POOL, window: 1800 });
  assert.equal(s.hiddenPct, 0);
  assert.equal(s.coordSellPct, 0);
});

// The combined veto: a coordinated cohort that is DISTRIBUTING right now.
test("a coordinated cluster selling NOW surfaces as coordSellPct", () => {
  const A = W(1), B = W(2), C = W(3), D = W(4), E = W(5);
  const t = [
    tx(POOL, A, 100, 10, 1000), tx(POOL, B, 100, 10, 1001), tx(POOL, C, 100, 11, 1002),
    tx(A, D, 40, 12, 1003), tx(A, E, 30, 13, 1004),                     // cluster {A,D,E}
    // much later, outside the 1800s window from the buys → the cluster dumps into the pool
    tx(A, POOL, 25, 20, 10000), tx(D, POOL, 20, 20, 10001), tx(E, POOL, 15, 20, 10002),
  ];
  const s = coordinationSignal(t, { pool: POOL, window: 1800 });
  assert.ok(s.coordSellPct > 10, `cluster holds a real slice and is selling now, got ${s.coordSellPct}`);
});

test("computeRisk: coordinated-and-selling is a hard veto — clean sub-scores can't offset it", () => {
  const clean = computeRisk({ f_top10: 20, f_snipe: 0, f_bundle: 0, nBundles: 0 });
  assert.ok(clean.risk < 25, `baseline reads clean, got ${clean.risk}`);
  const vetoed = computeRisk({ f_top10: 20, f_snipe: 0, f_bundle: 0, nBundles: 0, coordSellPct: 22 });
  assert.ok(vetoed.risk >= 66, `a coordinated cohort dumping forces HIGH RISK regardless, got ${vetoed.risk}`);
  assert.equal(vetoed.topFactor, "coordination");
});

test("computeRisk: hidden coordination raises risk proportionally, without a veto", () => {
  const none = computeRisk({ f_top10: 40, f_coord: 0 });
  const some = computeRisk({ f_top10: 40, f_coord: 18 });
  assert.ok(some.risk > none.risk, `a 18% hidden cluster lifts risk (${none.risk} → ${some.risk})`);
});

test("computeRisk stays backward-compatible when no coordination inputs are given", () => {
  const r = computeRisk({ f_snipe: 10, f_bundle: 5, f_top10: 50, nBundles: 1 });
  assert.ok(r.risk >= 0 && r.risk <= 100);
  assert.ok("coordination" in r.parts);
});
