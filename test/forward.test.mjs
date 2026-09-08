import { test } from "node:test";
import assert from "node:assert/strict";
import { observation, appendObservation } from "../observations.mjs";
import { featuresAt } from "../features.mjs";
import { nextSetup, SETUP_VERSION } from "../setups.mjs";
import { freezeDecision } from "../decisions.mjs";
import { evaluateDecision, summarize } from "../evaluation.mjs";
import { createExperiment, advanceRecord, EXPERIMENT_KEY, recordKey } from "../experiment.mjs";
import { buildPicks } from "../picks.mjs";
const MIN = 60000, T = 1800000000000, A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
const meta = (address = A) => ({ address, sym: "TOKEN", priceUsd: 1, mcapUsd: 100000, graduated: false, launchedAt: new Date(T - MIN).toISOString() });
const obs = (at, price = 1, holders = 100) => observation({ ...meta(), priceUsd: price, graduated: true }, { now: at,
  forensic: { observedAt: at, risk: 20, flags: { holders, top10Pct: 30, insiderSellersNow: 0 } }, market: { observedAt: at, liqUsd: 20000 } });
const path = () => [1, 1.1, 1.2, 1.3, 1.5, 1.3, 1.2, 1.4, 1.45].map((p, i) => obs(T + i * 5 * MIN, p, 100 + i * 3));

test("missing and stale data stay unknown; source event time is separate from observation time", () => {
  const o = observation({ ...meta(), latestBuyAt: new Date(T - MIN).toISOString() }, { now: T, forensic: { observedAt: T - 11 * MIN, risk: 0, flags: { holders: 100 } } });
  assert.equal(o.risk, null); assert.equal(o.holders, null); assert.equal(o.liquidityUsd, null);
  assert.equal(o.eventAt, T - MIN); assert.equal(o.observedAt, T); assert.equal(o.priceAsOf, null); assert.equal(o.executable, false);
});
test("observation append is immutable, idempotent and rejects backward timestamps", () => {
  const first = obs(T), next = obs(T + MIN), h = [first];
  const appended = appendObservation(h, next); next.holders = 999;
  assert.equal(h.length, 1); assert.equal(appended[1].holders, 100);
  assert.deepEqual(appendObservation(appended, obs(T + MIN)), appended);
  assert.throws(() => appendObservation(appended, obs(T - MIN)));
});
test("future observations cannot change a past feature or decision", () => {
  const h = path(), at = h.at(-1).observedAt, f = featuresAt(h, at);
  assert.equal(f.ready, true);
  const extended = [...h, obs(at + MIN, 9000, 1)];
  assert.deepEqual(featuresAt(extended, at), f);
  assert.deepEqual(freezeDecision(A, featuresAt(extended, at)), freezeDecision(A, f));
});
test("repeated cached forensics cannot invent fresh holder growth", () => {
  const h = path().map(o => ({ ...o, forensicAt: T }));
  const f = featuresAt(h, h.at(-1).observedAt);
  assert.equal(f.ready, false); assert.equal(f.holderGrowth, null);
});
test("gaps and missing liquidity prevent a setup", () => {
  const h = path(), at = h.at(-1).observedAt;
  const f = featuresAt(h.map(o => ({ ...o, liquidityUsd: null })), at);
  assert.equal(nextSetup(null, f).state, "observing");
  assert.equal(featuresAt([h[0], ...h.slice(5)], at).ready, false);
});
test("setup triggers only with all conditions, invalidates and cannot re-trigger", () => {
  const h = path(), f = featuresAt(h, h.at(-1).observedAt), setup = nextSetup(null, f);
  assert.equal(setup.state, "triggered");
  const invalid = nextSetup(setup, { ...f, at: f.at + MIN, insiderSellers: 2 });
  assert.equal(invalid.state, "invalidated");
  assert.equal(nextSetup(invalid, { ...f, at: f.at + 2 * MIN }).state, "invalidated");
  assert.equal(nextSetup(setup, { ...f, at: f.at + 6 * 3600000 }).state, "expired");
});
test("live advancement and observation replay produce exactly the same frozen decision", () => {
  const h = path(); let r = null;
  for (const o of h) r = advanceRecord(r, o, "TOKEN");
  assert.equal(r.decisions.length, 1);
  const again = h.reduce((r,o) => advanceRecord(r,o,"TOKEN"), null);
  assert.deepEqual(again, r);
  const frozen = structuredClone(r.decisions[0]);
  const extended = advanceRecord(r, obs(h.at(-1).observedAt + MIN, 2), "TOKEN");
  const { outcome: _, ...originalDecision } = frozen, { outcome: __, ...currentDecision } = extended.decisions[0];
  assert.deepEqual(currentDecision, originalDecision);
});
test("entry waits for delay; fixed horizon return ignores graduation and the intervening peak", () => {
  const d = freezeDecision(A, { at: T, version: "test" });
  const h = [obs(T, 0.1), obs(T + MIN, 1), obs(T + 2 * MIN, 100), obs(T + MIN + d.policy.horizonMs, 0.01)];
  const r = evaluateDecision(d, h, h.at(-1).observedAt);
  assert.equal(r.status, "resolved"); assert.equal(r.entryPrice, 1); assert.equal(r.exitPrice, 0.01);
  assert.equal(r.grossReturn, -0.99); assert.ok(r.scenarioReturn < -0.99); assert.equal(r.executable, false);
  assert.equal(r.adverseMove, null); // cannot claim a complete path when the middle is missing
});
test("absent entry or exit becomes unknown, never loss or a historical-peak fallback", () => {
  const d = freezeDecision(A, { at: T, version: "test" });
  assert.equal(evaluateDecision(d, [obs(T - MIN, 100)], T + 20 * MIN).status, "unknown");
  assert.equal(evaluateDecision(d, [obs(T + MIN)], T + 7 * 3600000).status, "unknown");
  assert.equal(evaluateDecision(d, [], T).status, "pending");
});
test("summary separates unresolved, missing and measured outcomes", () => {
  const rows = [{ address: A, strategy: "s", outcome: { status: "resolved", scenarioReturn: -0.5 } }, { address: B, strategy: "s", outcome: { status: "unknown" } }, { address: A, strategy: "s", outcome: { status: "pending" } }];
  const [s] = summarize(rows); assert.equal(s.resolved, 1); assert.equal(s.unknown, 1); assert.equal(s.pending, 1); assert.equal(s.positiveFraction, 0); assert.equal(s.distinctTokens, 2);
});
function harness(overrides = {}) {
  let time = T;
  const db = new Map(), pages = [];
  const options = { read: async key => structuredClone(db.get(key) ?? null), write: async (key,v) => { db.set(key, structuredClone(v)); },
    active: async ({ page }) => { pages.push(page); return { items: page === 1 ? [meta()] : [meta(B)], total: 200 }; },
    graduated: async () => ({ items: [], total: 0 }), board: () => [], clock: () => time, marketBudget: 1, sampleBudget: 10, ...overrides };
  return { db, pages, options, service: createExperiment(options), setTime: t => { time = t; } };
}
test("collector discovers beyond the board shortlist and retains ungraduated tokens", async () => {
  const h = harness(); await h.service.cycle(); const s = await h.service.snapshot();
  assert.deepEqual(h.pages, [1, 2]); assert.equal(s.rows.length, 2); assert.equal(s.coverage.complete, false);
  assert.equal(s.rows[0].graduated, false); assert.equal(s.rows[0].latest.risk, null); assert.equal(s.calls.length, 0);
});
test("restart resumes registry and does not duplicate an observation at the same time", async () => {
  const h = harness(); await h.service.cycle(); await createExperiment(h.options).cycle();
  assert.equal(h.db.get(recordKey(A)).observations.length, 1);
  h.setTime(T + 2 * MIN); const restarted = createExperiment(h.options); await restarted.cycle();
  assert.equal(h.db.get(recordKey(A)).observations.length, 2);
  assert.equal(h.db.get(EXPERIMENT_KEY).registry[A].firstSeenAt, T);
});
test("write failures do not publish an unpersisted decision or reset the registry", async () => {
  const h = harness(); await h.service.cycle();
  h.setTime(T + 2 * MIN);
  const failed = createExperiment({ ...h.options, write: async () => { throw new Error("disk full"); } });
  await failed.cycle(); const s = await failed.snapshot();
  assert.match(s.error, /disk full/); assert.equal(s.updated, T); assert.equal(s.rows.length, 2);
});
test("read failures stay errors, not empty successful experiments", async () => {
  const h = harness({ read: async () => { throw new Error("redis down"); } });
  await h.service.cycle(); const s = await h.service.snapshot(); assert.match(s.error, /redis down/); assert.equal(s.updated, 0);
});
test("missing source and registry limits are explicit", async () => {
  const h = harness({ maxTokens: 1, graduated: async () => { throw new Error("offline"); } });
  await h.service.cycle(); const s = await h.service.snapshot();
  assert.equal(s.coverage.omittedThisCycle, 1); assert.match(s.error, /offline/);
  assert.equal(s.rows.length, 1);
});
test("stale cached setups are never displayed as current triggers", async () => {
  const h = harness(); await h.service.cycle(); h.setTime(T + 6 * MIN);
  const s = await h.service.snapshot(); assert.equal(s.rows[0].stale, true); assert.equal(s.rows[0].displayState, "unavailable");
});
test("LLM cannot reorder picks or insert unsupported numbers", async () => {
  let called = false;
  const tokens = [A,B].map((address,i) => ({ address, risk: 20 + i * 20, mcapUsd: 10000, flags: { holders: 100, bundles: 0, top10Pct: 30 } }));
  const r = await buildPicks(tokens, async () => { called = true; return { text: JSON.stringify({ pick: B, why: "999999 holders" }) }; });
  assert.equal(called, false); assert.equal(r.brackets[0].pick.address, A); assert.doesNotMatch(r.brackets[0].pick.why, /999999/);
});

test("a missing current price invalidates readiness even with sufficient history", () => {
  const h = path(); h.at(-1).priceUsd = null;
  const f = featuresAt(h, h.at(-1).observedAt);
  assert.equal(f.ready, false); assert.ok(f.reasons.includes("current price unavailable"));
});

test("eligibility survives deterioration and restart without mirrored evidence in the index", async () => {
  let current;
  const h = harness({ active: async () => ({ items: [{ ...meta(), priceUsd: current.priceUsd }], total: 1 }),
    board: () => [{ address: A, observedAt: current.observedAt, risk: current.risk,
      flags: { holders: current.holders, insiderSellersNow: 0 } }], market: async () => ({ liqUsd: 20000 }) });
  for (current of path()) { h.setTime(current.observedAt); await h.service.cycle(); }
  const item = h.db.get(EXPERIMENT_KEY).registry[A];
  assert.equal(item.everEligible, true); assert.ok(item.decisionAt);
  for (const key of ["features", "setup", "latest", "decisions", "transitions", "observations"]) assert.equal(item[key], undefined);
  current = { ...current, observedAt: current.observedAt + MIN, priceUsd: null };
  h.setTime(current.observedAt); await h.service.cycle();
  const s = await createExperiment(h.options).snapshot({ limit: 0 });
  assert.equal(s.coverage.eligibleTokens, 1); assert.equal(s.calls.length, 1);
  assert.equal(s.strategies[0].eligibleTokens, 1);
});

test("5000-token index stays bounded and snapshots filter before loading at most 200 records", async (t) => {
  const h = harness(); const registry = {};
  for (let i = 1; i <= 5000; i++) {
    const address = "0x" + i.toString(16).padStart(40, "0");
    registry[address] = { address, sym: "S".repeat(80), firstSeenAt: T, lastSeenAt: T,
      sampledAt: T, observationAt: T, status: "observed", pending: false, launchedAt: new Date(T).toISOString(),
      graduated: false, everEligible: i % 2 === 0, setupState: i === 5000 ? "triggered" : "observing" };
  }
  h.db.set(EXPERIMENT_KEY, { schema: 1, updated: T, registry, nextPage: 2, coverage: { registrySize: 5000 } });
  const reads = [];
  const service = createExperiment({ ...h.options, read: async key => { reads.push(key); return structuredClone(h.db.get(key) ?? null); } });
  let s = await service.snapshot({ limit: 9999, includeCalls: false });
  assert.equal(s.rows.length, 200); assert.equal(s.total, 5000);
  assert.equal(reads.filter(k => k.includes(":token:")).length, 200);
  assert.equal(s.coverage.eligibleTokens, 2500);
  reads.length = 0;
  s = await service.snapshot({ state: "triggered", includeCalls: false });
  assert.equal(s.rows.length, 1); assert.equal(reads.length, 1);
  await service.cycle();
  const bytes = Buffer.byteLength(JSON.stringify(h.db.get(EXPERIMENT_KEY)));
  assert.ok(bytes < 3_000_000, `index is ${bytes} bytes`);
  t.diagnostic(`5000-token index: ${bytes} bytes; snapshot record reads capped at 200`);
});

test("migration preserves legacy mirrored calls but removes their payload from the index", async () => {
  const h = harness(), r = path().reduce((r,o) => advanceRecord(r,o,"TOKEN"), null);
  h.setTime(r.features.at);
  h.db.set(recordKey(A), r);
  h.db.set(EXPERIMENT_KEY, { schema: 1, updated: T, registry: { [A]: { address: A, sampledAt: r.features.at,
    setup: r.setup, features: r.features, decisions: r.decisions, latest: r.observations.at(-1), transitions: r.transitions } }, coverage: {} });
  const service = createExperiment(h.options);
  const s = await service.snapshot({ limit: 0 });
  assert.equal(s.calls.length, 1); assert.equal(s.coverage.eligibilityLowerBound, true);
  await service.cycle();
  assert.equal(h.db.get(EXPERIMENT_KEY).registry[A].decisions, undefined);
});

test("failed call-value persistence cannot publish a decision and a retry recovers it", async () => {
  let current;
  const h = harness({ active: async () => ({ items: [{ ...meta(), priceUsd: current.priceUsd }], total: 1 }),
    board: () => [{ address: A, observedAt: current.observedAt, risk: 20, flags: { holders: current.holders, insiderSellersNow: 0 } }],
    market: async () => ({ liqUsd: 20000 }) });
  const service = createExperiment({ ...h.options, write: async (key,v) => {
    if (key.includes(":calls:")) throw Error("call write failed");
    await h.options.write(key,v);
  } });
  for (current of path()) { h.setTime(current.observedAt); await service.cycle(); }
  const s = await service.snapshot({ limit: 0 });
  assert.match(s.error, /call write failed/); assert.equal(s.calls.length, 0);
  assert.equal(h.db.get(recordKey(A)).decisions.length, 1);
  current = { ...current, observedAt: current.observedAt + MIN }; h.setTime(current.observedAt);
  const retry = createExperiment(h.options); await retry.cycle();
  assert.equal((await retry.snapshot({ limit: 0 })).calls.length, 1);
});
