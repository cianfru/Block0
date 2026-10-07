// The forward test's scoring rules (tools/radar-protocol.mjs) — regression tests for audit findings F05 and F06.
import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeFromCandles, report, eventId, PROTOCOL, WEEK } from "../tools/radar-protocol.mjs";

const H = 3600, T = 1_790_000_000 - (1_790_000_000 % H) + 59 * 60;   // detection at hh:59

test("F06: the bar containing detection is excluded, so a pre-entry high cannot become the peak", () => {
  const o = outcomeFromCandles(T, 1, [[T - 59 * 60, 1, 100, 1, 1, 0], [T + 60, 1, 2, 1, 1.5, 0]]);
  assert.equal(o.peak7, 2);
  assert.equal(o.postCandles, 1);
});

test("F06: close7 needs a candle in the horizon's last 24 h; otherwise the end is not covered", () => {
  const early = outcomeFromCandles(T, 1, [[T + 60, 1, 3, 1, 2, 0]]);
  assert.deepEqual([early.peak7, early.close7, early.endCovered, early.note], [3, null, false, "end of horizon not covered"]);
  const full = outcomeFromCandles(T, 1, [[T + 60, 1, 3, 1, 2, 0], [T + WEEK - 2 * H, 1, 1, 1, 0.5, 0], [T + WEEK + H, 9, 9, 9, 9, 0]]);
  assert.deepEqual([full.peak7, full.close7, full.endCovered], [3, 0.5, true]);   // nothing after the horizon counts
  assert.equal(outcomeFromCandles(T, 1, []).note, "no post-entry trades");
});

// 30 events that each underperform their own 4 controls → FAIL
function world() {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const t = T + i * 86400, id = eventId("0xe" + i, t);
    rows.push({ kind: "event", v: PROTOCOL, id, t, token: "0xe" + i, priceUsd: 1, mcapUsd: 50000, peak7: 1.1, close7: 0.5 });
    for (let k = 0; k < 4; k++) rows.push({ kind: "control", v: PROTOCOL, forId: id, t, token: "0xc" + i + k, priceUsd: 1, mcapUsd: 50000, peak7: 2, close7: 1 });
  }
  return rows;
}

test("F05: an event is compared only with its own controls — later, unrelated controls cannot flip the verdict", () => {
  const base = world();
  assert.equal(report(base).verdict, "FAIL");
  // the audit's reproduction: controls drawn for OTHER, unscored events, all worse than every scored event
  const extra = [...base];
  for (let i = 0; i < 40; i++) extra.push({ kind: "control", v: PROTOCOL, forId: eventId("0xother" + i, T + 99e5), t: T + 99e5, token: "0xz" + i, priceUsd: 1, mcapUsd: 50000, peak7: 0.1, close7: 0.1 });
  assert.equal(report(extra).verdict, "FAIL");
  const verdictLines = (r) => r.lines.filter((l) => !l.startsWith("controls:"));
  assert.deepEqual(verdictLines(report(extra)), verdictLines(report(base)));                  // every percentile unchanged
});

test("report: v1 rows are counted, never scored; below 30 there is no verdict; the bootstrap is reproducible", () => {
  const rows = [{ kind: "event", t: T, token: "0xold", priceUsd: 1, mcapUsd: 1000, peak7: 50 }, ...world().slice(0, 25)];
  const r = report(rows);
  assert.equal(r.verdict, null);
  assert.ok(r.lines.some((l) => /1 events logged by legacy detectors/.test(l)));
  const good = world().map((x) => (x.kind === "event" ? { ...x, peak7: 5, close7: 3 } : x));
  assert.equal(report(good).verdict, "PASS");
  assert.deepEqual(report(good).lines, report(good).lines);
});

test("v3: one covered close cannot pass a 30-event peak test", () => {
  const rows = world().map(x => ({ ...x, peak7: x.kind === "event" ? 5 : 1, close7: x.t === T ? (x.kind === "event" ? 3 : 1) : null }));
  assert.equal(report(rows).verdict, null);
  assert.match(report(rows).lines.join("\n"), /need 30 paired close outcomes/);
});

test("v3: sparse controls do not count as a paired close; old versions never score", () => {
  const sparse = world();
  for (const r of sparse) if (r.kind === "control" && !r.token.endsWith("0")) r.close7 = null;
  assert.equal(report(sparse).verdict, null);
  for (const v of [1, 2]) assert.equal(report(world().map(r => ({ ...r, v }))).verdict, null);
});

test("v3: coverage is required in both time halves; reports do not retain stale percentiles", () => {
  const rows = [...world(), ...world().map(x => ({ ...x, t: x.t + 99e5, id: x.id && x.id + "later", forId: x.forId && x.forId + "later" }))];
  for (const x of rows) if (x.t >= T + 99e5) x.close7 = null;
  // 30 paired closes, but none in the later split.
  assert.equal(report(rows).verdict, null);
  const good = world();
  const before = JSON.stringify(good);
  report(good);
  assert.equal(JSON.stringify(good), before);
  for (const x of good) if (x.kind === "control") x.close7 = null;
  assert.equal(report(good).verdict, null);
});

test("v4 controls: a minutes-old event takes controls up to 2 h old; older events keep ×0.5–2; mcap always ×0.5–2", async () => {
  const { controlEligible } = await import("../tools/radar-protocol.mjs");
  const young = { mcapUsd: 50000, age: 7 * 60 };
  assert.equal(controlEligible(young, { mcapUsd: 60000, age: 90 * 60 }), true);          // v4: any age ≤ 2 h
  assert.equal(controlEligible(young, { mcapUsd: 60000, age: 90 * 60 }, { protocol: 3 }), false);   // v3: 3.5–14 min only
  assert.equal(controlEligible(young, { mcapUsd: 60000, age: 3 * 3600 }), false);
  assert.equal(controlEligible(young, { mcapUsd: 200000, age: 600 }), false);           // mcap out of ×0.5–2
  const old = { mcapUsd: 50000, age: 100 * 3600 };
  assert.equal(controlEligible(old, { mcapUsd: 50000, age: 60 * 3600 }), true);
  assert.equal(controlEligible(old, { mcapUsd: 50000, age: 30 * 3600 }), false);
});

test("v4 report: v3 and v4 events are scored together, each against its own controls, and counted per version", () => {
  const rows = world().map((x, k) => ({ ...x, v: k % 10 < 5 ? 3 : 4 }));                 // a mix of both versions
  const r = report(rows);
  assert.ok(r.verdict !== null);
  assert.match(r.lines.join("\n"), /by version: v3 \d+ priced, \d+ with controls · v4 \d+ priced/);
  assert.equal(report(world().map((x) => ({ ...x, v: 2 }))).verdict, null);               // v1/v2 still never score
});
