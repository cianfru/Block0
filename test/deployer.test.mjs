import { test } from "node:test";
import assert from "node:assert/strict";
import { deployerReputation, compactRep } from "../deployer.mjs";

const D = "0xdeadbeef";
const all = [
  { address: "0x1", sym: "NOW",  deployer: D, graduated: false, mcapUsd: 40000 },   // this token
  { address: "0x2", sym: "OLD1", deployer: D, graduated: false, mcapUsd: 800 },     // faded
  { address: "0x3", sym: "OLD2", deployer: D, graduated: false, mcapUsd: 1200 },    // faded
  { address: "0x4", sym: "LIVE", deployer: D, graduated: false, mcapUsd: 90000 },   // still live
  { address: "0x9", sym: "OTHER", deployer: "0xsomeoneelse", graduated: true, mcapUsd: 5e6 },
];

test("serial deployer: counts launches, faded-to-dust priors, no graduation", () => {
  const r = deployerReputation(all, all[0]);
  assert.equal(r.launched, 4); assert.equal(r.graduated, 0); assert.equal(r.faded, 2);
  assert.equal(r.reputation, "serial");
  assert.equal(r.others.length, 3); assert.equal(r.others.filter((o) => o.faded).length, 2);
});

test("a prior graduation makes the deployer proven", () => {
  const r = deployerReputation([...all, { address: "0x5", sym: "WON", deployer: D, graduated: true, mcapUsd: 2e6 }], all[0]);
  assert.equal(r.reputation, "proven"); assert.equal(r.graduated, 1);
});

test("first launch / proven-by-one / unknown deployer", () => {
  assert.equal(deployerReputation(all, { address: "0x9", deployer: "0xsomeoneelse" }).reputation, "proven");   // its one launch graduated
  assert.equal(deployerReputation([...all, { address: "0xn", sym: "NEW", deployer: "0xnewbie", graduated: false, mcapUsd: 3000 }], { address: "0xn", deployer: "0xnewbie" }).reputation, "first");
  assert.equal(deployerReputation(all, { address: "0x9", deployer: "" }), null);
  assert.equal(deployerReputation(all, { address: "0x9", deployer: "0x0000000000000000000000000000000000000000" }), null);
});

test("compactRep drops the list, keeps the counts", () => {
  const c = compactRep(deployerReputation(all, all[0]));
  assert.deepEqual(Object.keys(c).sort(), ["address", "faded", "graduated", "launched", "reputation"]);
  assert.equal(compactRep(null), null);
});
