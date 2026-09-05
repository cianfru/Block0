import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome, sustainedHours, definitions, RULES, EXCLUDE_TOKENS, isWinner, isControl } from "../outcome.mjs";

const H = 3600, D = 24 * H;
// a series of {t, mcap, holders} from a list of [ageHours, mcap, holders] rows
const S = (rows, t0 = 1_700_000_000) => rows.map(([a, m, h]) => ({ t: t0 + a * H, mcap: m, holders: h }));
const T0 = 1_700_000_000;

test("sustainedHours: counts only consecutive time above the level, extends an open stretch to now", () => {
  const s = S([[0, 2e6, 10], [24, 2e6, 20], [48, 5e5, 20], [72, 2e6, 30], [96, 2e6, 30]]);
  assert.equal(sustainedHours(s, 1e6), 24);                                   // two 24h stretches, best = 24
  assert.equal(sustainedHours(s, 1e6, { now: T0 + 200 * H, curMcap: 2e6 }), 24 + 104);   // still above now → open stretch runs on
  assert.equal(sustainedHours(s, 1e6, { now: T0 + 200 * H, curMcap: 1e5 }), 24);          // dropped since → no extension
});

test("runner: held $1M+ for a week with holders retained", () => {
  const rows = []; for (let a = 0; a <= 10 * 24; a += 12) rows.push([a, 1.5e6, 100 + a]);
  const r = classifyOutcome(S(rows), { now: T0 + 12 * D, t0: T0, curMcap: 1.4e6, curHolders: 340 });
  assert.equal(r.label, "runner"); assert.ok(r.sustainedH >= 7 * 24); assert.ok(isWinner(r.label));
});

test("major: $5M peak held above $1M for 14 days", () => {
  const rows = []; for (let a = 0; a <= 16 * 24; a += 12) rows.push([a, a > 48 ? 6e6 : 2e6, 500]);
  const r = classifyOutcome(S(rows), { now: T0 + 17 * D, t0: T0, curMcap: 5.5e6, curHolders: 480 });
  assert.equal(r.label, "major");
});

test("a spike to $3M that dumps within a day is faded, not a winner", () => {
  const s = S([[0, 5e4, 20], [2, 3e6, 200], [6, 8e5, 210], [30, 1e5, 200]]);
  const r = classifyOutcome(s, { now: T0 + 5 * D, t0: T0, curMcap: 6e4, curHolders: 190 });
  assert.equal(r.label, "faded"); assert.ok(isControl(r.label)); assert.equal(r.peakMcap, 3e6);
});

test("right-censoring: a 3-day-old token above $1M is pending, never a loser", () => {
  const rows = []; for (let a = 0; a <= 72; a += 6) rows.push([a, 1.2e6, 100]);
  const r = classifyOutcome(S(rows), { now: T0 + 3 * D, t0: T0, curMcap: 1.3e6, curHolders: 110 });
  assert.equal(r.label, "pending");
});

test("held the cap but holders collapsed → mid (hollow), not a winner", () => {
  const rows = []; for (let a = 0; a <= 10 * 24; a += 12) rows.push([a, 2e6, a < 24 ? 400 : 150]);
  const r = classifyOutcome(S(rows), { now: T0 + 11 * D, t0: T0, curMcap: 2e6, curHolders: 150 });
  assert.equal(r.label, "mid"); assert.ok(r.retention < RULES.holderKeep);
});

test("young + small is pending; a week old + small is stalled; near-zero is dead", () => {
  const s = S([[0, 4e4, 15], [12, 3e4, 20]]);
  assert.equal(classifyOutcome(s, { now: T0 + 1 * D, t0: T0, curMcap: 3e4 }).label, "pending");
  assert.equal(classifyOutcome(s, { now: T0 + 3 * D, t0: T0, curMcap: 3e4 }).label, "pending");
  assert.equal(classifyOutcome(s, { now: T0 + 8 * D, t0: T0, curMcap: 3e4 }).label, "stalled");
  assert.equal(classifyOutcome(s, { now: T0 + 3 * D, t0: T0, curMcap: 500 }).label, "dead");
});

test("live market cap above the recorded peak raises the peak (new highs are seen without a re-backtest)", () => {
  const s = S([[0, 2e5, 50], [24, 4e5, 80]]);
  const r = classifyOutcome(s, { now: T0 + 3 * D, t0: T0, curMcap: 1.5e6, curHolders: 120 });
  assert.equal(r.peakMcap, 1.5e6); assert.equal(r.label, "pending");
});

test("a week-long $1M run that then went to zero is faded (wasRunner flagged), not a winner", () => {
  const rows = []; for (let a = 0; a <= 8 * 24; a += 12) rows.push([a, 3e6, 300]); rows.push([9 * 24, 2e5, 280], [12 * 24, 2e4, 250]);
  const r = classifyOutcome(S(rows), { now: T0 + 20 * D, t0: T0, curMcap: 2e4, curHolders: 250 });
  assert.equal(r.label, "faded"); assert.equal(r.wasRunner, true); assert.ok(r.heldPeak >= 2.9e6);
});

test("a single-swap wick to $250M does not set the held-peak; the token still reads as a runner", () => {
  const rows = []; for (let a = 0; a <= 10 * 24; a += 12) rows.push([a, a === 24 ? 2.5e8 : 8e6, 400]);
  const r = classifyOutcome(S(rows), { now: T0 + 11 * D, t0: T0, curMcap: 7e6, curHolders: 390 });
  assert.equal(r.label, "runner"); assert.equal(r.peakMcap, 2.5e8); assert.ok(r.heldPeak <= 8e6 && r.heldPeak >= 7e6);
});

test("empty / unpriced series never throws", () => {
  assert.equal(classifyOutcome([], { now: T0 + 10 * D, t0: T0 }).label, "dead");
  assert.equal(classifyOutcome([{ t: T0, mcap: null, holders: 3 }], { now: T0 + 1 * D, t0: T0 }).label, "pending");
});

test("definitions mirror the rules and the platform token is excluded", () => {
  const d = definitions();
  assert.equal(d.find((x) => x.tier === "runner").rule, "held-peak ≥ $1M, stayed ≥ $1M for 7 days, holders ≥ 70% of peak, still ≥ 25% of its held-peak");
  assert.ok(EXCLUDE_TOKENS.has("0x39dbed3a2bd333467115de45665cc57f813c4571"));
});
