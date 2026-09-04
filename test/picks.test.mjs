import { test } from "node:test";
import assert from "node:assert/strict";
import { bracketize, promiseScore, validatePick, buildPicks, bracketOf, BRACKETS } from "../picks.mjs";

// two candidates in the $1M–$5M bracket: one clean, one a trap; one fresh sub-$500k
const clean = { address: "0xCLEAN", sym: "CLEAN", mcapUsd: 2_000_000, risk: 18, label: "LOOKS CLEANER", momentum: 30,
  smart: { count: 2 }, flags: { holders: 400, top10Pct: 32, snipers: 0, sniperHeldPct: 0, bundles: 0, bundleHeldPct: 0, insiderSellersNow: 0 } };
const trap = { address: "0xTRAP", sym: "TRAP", mcapUsd: 2_500_000, risk: 78, label: "HIGH RISK", momentum: -10,
  smart: { count: 0 }, flags: { holders: 60, top10Pct: 88, snipers: 9, sniperHeldPct: 40, bundles: 3, bundleHeldPct: 25, insiderSellersNow: 4 } };
const fresh = { address: "0xFRESH", sym: "FRSH", mcapUsd: 200_000, risk: 30, label: "MIXED", momentum: 5,
  smart: { count: 0 }, flags: { holders: 55, top10Pct: 48, snipers: 1, sniperHeldPct: 3, bundles: 0, bundleHeldPct: 0, insiderSellersNow: 0 } };

test("bracketOf maps mcap to the right price bracket", () => {
  assert.equal(bracketOf(200_000).key, "fresh");
  assert.equal(bracketOf(750_000).key, "early");
  assert.equal(bracketOf(2_000_000).key, "traction");
  assert.equal(bracketOf(7_000_000).key, "established");
  assert.equal(bracketOf(50_000_000).key, "bluechip");
});

test("promiseScore ranks the clean launch well above the trap", () => {
  assert.ok(promiseScore(clean) > promiseScore(trap) + 40);
});

test("bracketize groups by bracket, drops thin tokens, pre-ranks by promise", () => {
  const bs = bracketize([clean, trap, fresh, { address: "0xDUST", mcapUsd: 3_000_000, flags: { holders: 3 } }]);
  const traction = bs.find((b) => b.key === "traction");
  assert.ok(traction, "traction bracket present");
  assert.equal(traction.candidates[0].address, "0xclean");   // clean ranks first
  assert.equal(traction.candidates.length, 2);               // dust (<20 holders) dropped
  assert.ok(bs.find((b) => b.key === "fresh"));               // fresh bracket present
});

test("validatePick rejects invented tokens, buy-calls and empty reasons; accepts a real structural read", () => {
  const cands = [{ address: "0xclean" }, { address: "0xtrap" }];
  assert.equal(validatePick({ pick: "0xGHOST", why: "clean holders" }, cands), null);       // not a candidate
  assert.equal(validatePick({ pick: "0xclean", why: "buy this it will moon" }, cands), null); // buy-call
  assert.equal(validatePick({ pick: "0xclean", why: "looks nice" }, cands), null);            // no signal cited
  const ok = validatePick({ pick: "0xclean", why: "Cleanest fingerprint — 400 holders, top-10 hold 32%, no snipers.", runnerUp: "0xtrap" }, cands);
  assert.ok(ok && ok.pick === "0xclean" && ok.runnerUp === "0xtrap");
});

test("buildPicks with no LLM falls back to the deterministic pick", async () => {
  const p = await buildPicks([clean, trap, fresh], null);
  assert.equal(p.llmUsed, false);
  const traction = p.brackets.find((b) => b.key === "traction");
  assert.equal(traction.pick.address, "0xclean");
  assert.equal(traction.pick.viaLlm, false);
  assert.ok(traction.pick.why.length > 10);
});

test("buildPicks uses a valid LLM pick when the model returns one", async () => {
  const chat = async () => ({ text: JSON.stringify({ pick: "0xclean", why: "Best fingerprint: 400 holders, top-10 only 32%, 2 smart-money wallets, no bundles.", runnerUp: "" }), model: "free/x" });
  const p = await buildPicks([clean, trap], chat);
  assert.equal(p.llmUsed, true);
  const traction = p.brackets.find((b) => b.key === "traction");
  assert.equal(traction.pick.viaLlm, true);
  assert.match(traction.pick.why, /holders/);
});

test("buildPicks ignores an LLM buy-call and keeps the deterministic pick", async () => {
  const chat = async () => ({ text: JSON.stringify({ pick: "0xtrap", why: "ape in, this will 100x" }), model: "free/x" });
  const p = await buildPicks([clean, trap], chat);
  const traction = p.brackets.find((b) => b.key === "traction");
  assert.equal(traction.pick.address, "0xclean");   // rejected the bad output, deterministic winner stands
  assert.equal(traction.pick.viaLlm, false);
});
