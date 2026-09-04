import { test } from "node:test";
import assert from "node:assert/strict";
import { corridorStatus, hasModel } from "../model.mjs";

// These assert the honesty fix: a clean SHAPE score can't read "on the winner path" while the token's ABSOLUTE
// adoption (wallets + mcap) is well below where winners actually were. Uses the real baked corridor (model.json).
// The 0.5–1h bin has twLo≈159, tm≈$358k — the ORBID case (84 score, 56 wallets, $15k) must read adoption-behind.

test("high shape score + below-floor adoption reads adoption-behind, not on-track", { skip: !hasModel() }, () => {
  const s = corridorStatus(0.6, 84, { wallets: 56, mcap: 15384 });
  assert.equal(s.shape, "on-track");            // the score alone clears the cone
  assert.equal(s.adoption, "lagging");          // but wallets/mcap are far below the winners' pace
  assert.equal(s.status, "adoption-behind");    // combined verdict is honest
});

test("high shape score + adequate adoption reads on-track", { skip: !hasModel() }, () => {
  const s = corridorStatus(0.6, 84, { wallets: 300, mcap: 500000 });
  assert.equal(s.status, "on-track");
  assert.equal(s.adoption, "keeping-pace");
});

test("a failing shape score reads failing regardless of adoption", { skip: !hasModel() }, () => {
  assert.equal(corridorStatus(0.6, 20, { wallets: 300, mcap: 500000 }).status, "failing");
});

test("no adoption args → backward-compatible shape-only status (never crashes)", { skip: !hasModel() }, () => {
  const s = corridorStatus(0.6, 84);
  assert.equal(s.status, "on-track");           // wallets/mcap absent → adoption gate can't fire
});
