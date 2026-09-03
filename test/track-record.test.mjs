import { test } from "node:test";
import assert from "node:assert/strict";
import { earlyCall, ingest, resolve, report } from "../track-record.mjs";

const H = 3600000;

test("earlyCall classifies the young verdict", () => {
  assert.equal(earlyCall({ corridorStatus: "on-track", risk: 40 }), "promising");
  assert.equal(earlyCall({ blueprint: 60, risk: 20 }), "promising");
  assert.equal(earlyCall({ risk: 70 }), "avoid");
  assert.equal(earlyCall({ corridorStatus: "failing", risk: 10 }), "avoid");
  assert.equal(earlyCall({ risk: 35, blueprint: 40 }), "watch");
});

test("ingest freezes ONLY a young prediction, and never overwrites it", () => {
  const s = { tokens: {} };
  const t0 = 1_000_000;
  // too old at first sight → no frozen prediction (we didn't call it early)
  ingest(s, [{ address: "0xold", sym: "OLD", ageH: 20, risk: 10, blueprint: 90, corridor: { status: "on-track" }, mcapUsd: 5000 }], t0);
  assert.equal(s.tokens["0xold"].prediction, null);
  // young at first sight → frozen call captured
  ingest(s, [{ address: "0xy", sym: "Y", ageH: 2, risk: 20, blueprint: 70, corridor: { status: "on-track" }, mcapUsd: 8000 }], t0);
  assert.equal(s.tokens["0xy"].call, "promising");
  assert.equal(s.tokens["0xy"].prediction.risk, 20);
  // a later, different verdict must NOT overwrite the frozen young call, but peak keeps rising
  ingest(s, [{ address: "0xy", sym: "Y", ageH: 40, risk: 80, corridor: { status: "failing" }, mcapUsd: 50000 }], t0 + 38 * H);
  assert.equal(s.tokens["0xy"].call, "promising");   // unchanged
  assert.equal(s.tokens["0xy"].peakMcap, 50000);     // running peak updates
});

test("resolve marks winner (ran the multiple) and loser (matured, faded)", () => {
  const s = { tokens: {} };
  const t0 = 1_000_000;
  ingest(s, [{ address: "0xw", sym: "W", ageH: 1, risk: 15, blueprint: 80, corridor: { status: "on-track" }, mcapUsd: 10000 }], t0);
  ingest(s, [{ address: "0xl", sym: "L", ageH: 1, risk: 15, blueprint: 80, corridor: { status: "on-track" }, mcapUsd: 10000 }], t0);
  // winner runs 5x its early mcap
  ingest(s, [{ address: "0xw", ageH: 10, mcapUsd: 50000 }], t0 + 9 * H);
  resolve(s, t0 + 10 * H);
  assert.equal(s.tokens["0xw"].outcome, "winner");
  // loser: no run, past maturity
  assert.equal(s.tokens["0xl"].resolved, false);      // not matured yet
  resolve(s, t0 + 80 * H);
  assert.equal(s.tokens["0xl"].outcome, "loser");
});

test("report: accruing below MIN_SHOW, then a real hit-rate with lift", () => {
  const s = { tokens: {} };
  const t0 = 1_000_000;
  // 12 promising young calls: 6 win, 6 lose; plus 8 'avoid' calls that mostly lose
  for (let i = 0; i < 12; i++) ingest(s, [{ address: "p" + i, ageH: 1, risk: 15, blueprint: 80, corridor: { status: "on-track" }, mcapUsd: 10000 }], t0);
  for (let i = 0; i < 8; i++) ingest(s, [{ address: "a" + i, ageH: 1, risk: 70, mcapUsd: 10000 }], t0);
  // make 6 promising run
  for (let i = 0; i < 6; i++) ingest(s, [{ address: "p" + i, ageH: 10, mcapUsd: 60000 }], t0 + 9 * H);
  // make 1 avoid run (avoid isn't magic — but base rate should stay below promising)
  ingest(s, [{ address: "a0", ageH: 10, mcapUsd: 60000 }], t0 + 9 * H);
  resolve(s, t0 + 80 * H);
  const r = report(s);
  assert.equal(r.predicted, 20);
  assert.equal(r.resolved, 20);
  assert.equal(r.ready, true);                         // >= MIN_SHOW (10)
  assert.equal(r.promising.n, 12);
  assert.equal(r.promising.winRate, 0.5);              // 6/12
  assert.ok(r.baseRate < r.promising.winRate);         // promising beats the base rate
  assert.ok(r.lift > 1);
});
