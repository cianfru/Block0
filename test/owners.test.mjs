import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeOwner, ownerLine, MAX_LAUNCHES } from "../agent/owners.mjs";

const O = "0x" + "1".repeat(40), L = (i, o = {}) => ({ address: "0x" + i.toString(16).padStart(40, "0"), sym: "T" + i, at: 1000 + i, graduated: false, mcapUsd: 5000.4, ...o });

test("owner files accumulate launches newest first, keep the launchpad's own count, and are not rewritten when unchanged", () => {
  let f = mergeOwner(null, { address: O, venue: "pons", record: { launched: 9, graduated: 0, scope: "every Pons launch" }, launches: [L(1)] }, { now: 5 });
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].mcapUsd, 5000);
  f = mergeOwner(f, { address: O, venue: "pons", record: { launched: 10, graduated: 1 }, launches: [L(2, { graduated: true })] }, { now: 6 });
  assert.deepEqual(f.launches.map((l) => l.sym), ["T2", "T1"]);
  assert.equal(f.record.launched, 10);
  assert.equal(mergeOwner(f, { address: O, venue: "pons", record: { launched: 10, graduated: 1 }, launches: [L(2, { graduated: true })] }, { now: 7 }), null);
  const many = mergeOwner(null, { address: O, launches: Array.from({ length: MAX_LAUNCHES + 5 }, (_, i) => L(i)) });
  assert.equal(many.launches.length, MAX_LAUNCHES);
  assert.equal(ownerLine({ launched: 37, graduated: 0 }), "launched 37 · 0 graduated");
  assert.equal(ownerLine(null), null);
});
