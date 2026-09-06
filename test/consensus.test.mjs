import { test } from "node:test";
import assert from "node:assert/strict";
import { consensusOf, smartWeight, smartHolders, convergence } from "../smart-money.mjs";
import { detectEvents } from "../alert-events.mjs";

const T0 = 1_800_000_000;                       // seconds
const W = (n) => "0x" + String(n).padStart(40, "a");
const holder = (n, first, bought = 100, bal = 100) => ({ a: W(n), first, bought, bal });
const META = {
  [W(1)]: { realized: 1_000_000, winRate: 100 },   // heavyweight record   → weight ≈ 2.0
  [W(2)]: { realized: 50_000, winRate: 60 },       // solid                → ≈ 1.58
  [W(3)]: { realized: 800, winRate: 30 },          // thin                 → ≈ 1.13
  [W(4)]: { realized: 0, winRate: 0 },             // no record            → 0.5
};

test("smartWeight: a real record weighs ~4× a thin one, and is capped", () => {
  const heavy = smartWeight(META[W(1)]), thin = smartWeight(META[W(4)]);
  assert.ok(heavy > 1.9 && heavy <= 2.0, `heavy ${heavy}`);
  assert.equal(thin, 0.5);
  assert.ok(smartWeight({ realized: 1e12, winRate: 1 }) <= 2.0, "log-capped");
});

test("consensusOf: three proven wallets buying inside 20 minutes = one cluster, record-weighted", () => {
  const hits = [holder(1, T0), holder(2, T0 + 600), holder(3, T0 + 1200)];
  const c = consensusOf(hits, META, { now: T0 + 1800 });
  assert.equal(c.n, 3);
  assert.equal(c.spanMin, 20);
  assert.ok(c.strength > 4.5 && c.strength < 5, `Σ weights ≈ 2.0+1.58+1.13, got ${c.strength}`);
  assert.equal(c.tight10, 2, "two of them inside any 10-minute slice");
  assert.ok(c.freshH < 0.2);
});

test("consensusOf: the same wallets bought DAYS apart is not a consensus (no window holds 2)", () => {
  const hits = [holder(1, T0), holder(2, T0 + 2 * 86400), holder(3, T0 + 5 * 86400)];
  assert.equal(consensusOf(hits, META, { now: T0 + 6 * 86400 }), null);
});

test("consensusOf: picks the STRONGEST window, not the earliest; a transfer-received bag (no buy) is ignored", () => {
  const hits = [holder(4, T0), holder(4 + 10, T0 + 60),                          // two no-record wallets early (0.5 each)
    holder(1, T0 + 7200), holder(2, T0 + 7200 + 900),                            // heavyweights an hour+ later
    { a: W(9), first: T0 + 7200 + 300, bought: 0, bal: 500 }];                   // received by transfer → not a buyer
  const meta = { ...META, [W(14)]: { realized: 0, winRate: 0 } };
  const c = consensusOf(hits, meta, { now: T0 + 9000 });
  assert.deepEqual(c.wallets, [W(1), W(2)], "the heavyweight pair wins on strength");
  assert.ok(!c.wallets.includes(W(9)));
});

test("smartHolders exposes consensus; convergence() ranks by strength before count", () => {
  const set = new Set([W(1), W(2), W(3), W(4), W(14)]);
  const strong = smartHolders([holder(1, T0), holder(2, T0 + 300)], set, META, 12, { now: T0 + 600 });
  const weakMany = smartHolders([holder(4, T0), holder(14, T0 + 100), holder(3, T0 + 200)], set, { ...META, [W(14)]: META[W(4)] }, 12, { now: T0 + 600 });
  assert.ok(strong.consensus.strength > weakMany.consensus.strength, "2 heavy records outrank 3 thin ones");
  const ranked = convergence({ cooking: [{ address: "0xb", sym: "WEAK", smart: weakMany, mcapUsd: 9e9 }, { address: "0xa", sym: "STRONG", smart: strong, mcapUsd: 1 }] });
  assert.equal(ranked[0].sym, "STRONG");
});

test("detectEvents: fires smart-convergence when consensus strength CROSSES the bar with a fresh cluster", () => {
  const now = (T0 + 1800) * 1000;
  const tok = (cons) => ({ address: "0xabc", sym: "X", mcapUsd: 2e5, ageH: 3, risk: 22, flags: { holders: 300 },
    smart: { count: 3, consensus: cons } });
  const prev = { "0xabc": { sellers: 0, smart: 1, cons: 0.5, clean: false } };
  const fresh = { n: 3, strength: 4.7, spanMin: 20, tight10: 2, freshH: 0.3 };
  const r = detectEvents(prev, [tok(fresh)], { now });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "smart-convergence");
  assert.match(r.events[0].headline, /3 proven wallets bought within 20 min/);
  assert.match(r.events[0].headline, /consensus 4\.7/);
  // an OLD cluster that merely became visible does not fire
  const stale = detectEvents(prev, [tok({ ...fresh, freshH: 12 })], { now });
  assert.equal(stale.events.length, 0, "stale cluster must not alert");
  // ≥2 proven wallets HOLDING but no bought-together consensus does not fire (the flat trigger is gone)
  const holdOnly = detectEvents({ "0xabc": { sellers: 0, smart: 1, cons: 0, clean: false } }, [tok(null)], { now });
  assert.equal(holdOnly.events.length, 0);
  // first sight seeds, never fires
  assert.equal(detectEvents({}, [tok(fresh)], { now }).events.length, 0);
});
