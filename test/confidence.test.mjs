import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfidence } from "../model.mjs";

// Confidence is uncertainty made first-class: a very new / thin / sparse token, or a stage with few comparable
// winners, LOWERS the read. Level only ever worsens (high → limited → low); every reason is a plain fact.

test("a mature, well-populated token reads HIGH with no caveats", () => {
  const c = readConfidence({ ageH: 200, holders: 4000, events: 5000 });
  assert.equal(c.level, "high");
  assert.equal(c.reasons.length, 1);
  assert.match(c.reasons[0], /confident read/);
});

test("a brand-new token is LOW confidence and says why", () => {
  const c = readConfidence({ ageH: 0.5, holders: 4000, events: 5000 });
  assert.equal(c.level, "low");
  assert.match(c.reasons.join(" "), /30 min old|min old/);
  assert.match(c.reasons.join(" "), /barely separate/);
});

test("a thin holder base drops to LOW; a small one to LIMITED", () => {
  assert.equal(readConfidence({ ageH: 50, holders: 12, events: 500 }).level, "low");
  const lim = readConfidence({ ageH: 50, holders: 60, events: 500 });
  assert.equal(lim.level, "limited");
  assert.match(lim.reasons.join(" "), /small sample|60 holders/);
});

test("severity only worsens — a new AND thin token stays LOW, reasons accumulate", () => {
  const c = readConfidence({ ageH: 0.5, holders: 12, events: 10 });
  assert.equal(c.level, "low");
  assert.ok(c.reasons.length >= 3, "each independent weakness is named");
});

test("reconstructed price is disclosed as a limit", () => {
  const c = readConfidence({ ageH: 50, holders: 4000, events: 5000, priceReconstructed: false });
  assert.equal(c.level, "limited");
  assert.match(c.reasons.join(" "), /reconstructed|estimates/);
});

test("nWinners at the token's age is reported from the corridor bin (or null with no model)", () => {
  const c = readConfidence({ ageH: 12, holders: 4000, events: 5000 });
  assert.ok(c.nWinners === null || typeof c.nWinners === "number");
});
