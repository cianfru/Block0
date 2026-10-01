// The forensic read on synthetic transfer histories — regression tests for audit findings F01 (a transfer between
// wallets is not a sale) and F02 ("now" is the observation time, not the token's last transfer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTransfers } from "../intel.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const P = "0x" + "p0".repeat(20).replace(/p/g, "a");               // the pool
const W = (n) => "0x" + String(n).padStart(40, "b");
const T0 = 1_790_000_000;
// mint to the pool, one early buyer (sniper: first buy) and five later buyers
function base() {
  const ev = [{ from: ZERO, to: P, amt: 1000, block: 1, ts: T0 }, { from: P, to: W(1), amt: 100, block: 10, ts: T0 + 10 }];
  for (let i = 2; i <= 6; i++) ev.push({ from: P, to: W(i), amt: 50, block: 100 + i, ts: T0 + 3600 + i });
  return ev;
}
const read = (ev, obsTs) => analyzeTransfers(ev, { ponsPool: P, obsTs }).out;

test("F01: an early wallet moving tokens to another wallet is 'transferred out', not 'selling'", () => {
  const t = T0 + 7200, ev = [...base(), { from: W(1), to: W(99), amt: 50, block: 500, ts: t }];
  const f = read(ev, t + 60).flags;
  assert.equal(f.insiderSellersNow, 0);
  assert.equal(f.insiderDumpNowPct, 0);
  assert.equal(f.earlyMovedOutNow, 1);
  assert.ok(f.earlyMovedOutPct > 0);
});

test("F01: an early wallet selling into the pool is selling", () => {
  const t = T0 + 7200, ev = [...base(), { from: W(1), to: P, amt: 50, block: 500, ts: t }];
  const f = read(ev, t + 60).flags;
  assert.equal(f.insiderSellersNow, 1);
  assert.ok(f.insiderDumpNowPct > 0);
  assert.equal(f.earlyMovedOutNow, 0);
});

test("F02: a sale 24 h before the observation is not 'now'; without a clock the last transfer anchors", () => {
  const t = T0 + 7200, ev = [...base(), { from: W(1), to: P, amt: 50, block: 500, ts: t }];
  assert.equal(read(ev, t + 86400).flags.insiderSellersNow, 0);
  assert.equal(read(ev, t + 600).flags.insiderSellersNow, 1);
  assert.equal(read(ev, null).flags.insiderSellersNow, 1);
  assert.equal(read(ev, t + 86400).observedAt, (t + 86400) * 1000);
});

test("a later buyer who sells is not counted as an early wallet; whales report sold vs moved", () => {
  const t = T0 + 7200, ev = [...base(), { from: W(3), to: P, amt: 50, block: 500, ts: t }, { from: W(1), to: W(98), amt: 10, block: 501, ts: t }];
  const o = read(ev, t + 60);
  assert.equal(o.flags.insiderSellersNow, 0);
  const w1 = o.whales.find((w) => w.a === W(1));
  assert.deepEqual([w1.soldNow, w1.movedOutNow, w1.sniper], [0, 10, true]);
});
