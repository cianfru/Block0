import { test } from "node:test";
import assert from "node:assert/strict";
import { corridorStatus, corridorBins, hasModel } from "../model.mjs";

// These assert the honesty fix: a clean SHAPE score can't read "on the winner path" while the token's ABSOLUTE
// adoption (wallets + mcap) is well below where winners actually were. They run against whatever model.json is
// baked, so every input is DERIVED from the live corridor bin (its own wallet floor / mcap median) — never pinned
// to one cohort's numbers. The model is regenerated as the cohort grows; a test pinned to old targets killed a
// full rebuild once (run #5, 2026-09-05), which is exactly the failure this shape prevents.
const bin = () => (corridorBins() || []).find((b) => b.twLo && b.tm) || null;   // first bin that states concrete targets
const ok = () => hasModel() && !!bin();
const age = () => { const b = bin(); return (b.lo + b.hi) / 2; };

test("high shape score + below-floor adoption reads adoption-behind, not on-track", { skip: !ok() }, () => {
  const b = bin();
  const s = corridorStatus(age(), Math.max(b.q1 + 5, 84), { wallets: Math.max(1, Math.floor(b.twLo * 0.3)), mcap: Math.max(1, Math.floor(b.tm * 0.1)) });
  assert.equal(s.shape, "on-track");            // the score alone clears the cone
  assert.equal(s.adoption, "lagging");          // but wallets/mcap are far below the winners' pace
  assert.equal(s.status, "adoption-behind");    // combined verdict is honest
});

test("high shape score + adequate adoption reads on-track", { skip: !ok() }, () => {
  const b = bin();
  const s = corridorStatus(age(), Math.max(b.q1 + 5, 84), { wallets: b.twLo * 2, mcap: b.tm * 2 });
  assert.equal(s.status, "on-track");
  assert.equal(s.adoption, "keeping-pace");
});

test("a failing shape score reads failing regardless of adoption", { skip: !ok() }, () => {
  const b = bin();
  assert.equal(corridorStatus(age(), 20, { wallets: b.twLo * 2, mcap: b.tm * 2 }).status, "failing");
});

test("no adoption args → backward-compatible shape-only status (never crashes)", { skip: !ok() }, () => {
  const b = bin();
  const s = corridorStatus(age(), Math.max(b.q1 + 5, 84));
  assert.equal(s.status, "on-track");           // wallets/mcap absent → adoption gate can't fire
});

test("every baked corridor bin is internally consistent (q1 ≤ q3, targets positive when stated)", { skip: !hasModel() }, () => {
  for (const b of corridorBins()) {
    assert.ok(b.q1 <= b.q3, `bin ${b.lo}-${b.hi}h q1 ${b.q1} > q3 ${b.q3}`);
    if (b.tw != null) assert.ok(b.tw > 0 && b.twLo > 0 && b.twHi >= b.twLo, `bin ${b.lo}-${b.hi}h wallet targets`);
    if (b.tm != null) assert.ok(b.tm > 0, `bin ${b.lo}-${b.hi}h mcap target`);
  }
});
