// agent/stats.mjs — the week in numbers and its Monday post.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyStats, weeklyDue, weekKey, formatWeekly } from "../agent/stats.mjs";
import { lint } from "../agent/format.mjs";

const NOW = Date.UTC(2026, 9, 12, 17, 30);   // a Monday
const ag = (owner, daysAgo, graduated = false, usd = 0) => ({ owner, launchedAt: Math.floor((NOW - daysAgo * 86400e3) / 1000), graduated, usdgAtoms: BigInt(Math.round(usd * 1e6)) });

test("weekly stats: launches and graduations in the window, repeat vs single owners, fees, events, launch structure", () => {
  const agents = [ag("a", 1, true, 500), ...Array.from({ length: 6 }, (_, i) => ag("serial", i + 1, false, 10)), ag("b", 20, false)];
  const s = weeklyStats({ agents, now: NOW,
    ponsGrads: [{ graduatedAt: new Date(NOW - 86400e3).toISOString() }, { graduatedAt: new Date(NOW - 9 * 86400e3).toISOString() }],
    events: [{ at: NOW - 3600e3, kind: "insider-dump", address: "x", fate: "logged" }, { at: NOW - 3600e3, kind: "insider-dump", address: "x", fate: "dry-run" },
      { at: NOW - 10 * 86400e3, kind: "insider-dump", address: "y", fate: "logged" }, { at: NOW - 60e3, kind: "serial-owner", address: "z", fate: "held" }],
    reads: [{ graduated: false, flags: { holders: 10, top10Pct: 99, bundles: 1 } }, { graduated: true, flags: { holders: 300, top10Pct: 40, bundles: 0 } }] });
  assert.deepEqual([s.orbio.launched, s.orbio.graduated, s.orbio.repeatOwners, s.orbio.repeatLaunches, s.orbio.repeatGraduated, s.orbio.singleOwners, s.orbio.singleGraduated],
    [7, 1, 1, 6, 0, 2, 1]);
  assert.equal(s.orbio.feesUsd, 560);
  assert.equal(s.pons.graduated, 1);
  assert.deepEqual([s.events.earlySales, s.events.earlySalesLaunches, s.events.repeatOwnerLaunches, s.events.material], [2, 1, 1, 2]);
  assert.deepEqual([s.reads.bundledPct, s.reads.curve.top10, s.reads.graduated.holders], [50, 99, 300]);
  const text = formatWeekly(s);
  assert.match(text, /Orbio: 7 agents · 1 graduated \(14.3%\)/);
  assert.match(text, /Owners with 5\+ agents: 1 · 6 launches · 0 graduated/);
  assert.deepEqual(lint(text), []);
  // a busy week still fits, owners line included
  const big = formatWeekly({ ...s, orbio: { ...s.orbio, launched: 12345, graduated: 123, gradPct: 1, repeatOwners: 123, repeatLaunches: 4567, repeatGraduated: 12 },
    pons: { graduated: 1234 }, events: { ...s.events, earlySales: 12345, earlySalesLaunches: 1234, repeatOwnerLaunches: 1234 } });
  assert.match(big, /Owners with 5\+ agents/);
  assert.deepEqual(lint(big), []);
});

test("weekly post: Monday after 17:00 UTC, once per ISO week", () => {
  assert.equal(weeklyDue(null, NOW), true);
  assert.equal(weeklyDue(weekKey(NOW), NOW), false);
  assert.equal(weeklyDue(null, NOW - 2 * 3600e3), false);            // Monday 15:30
  assert.equal(weeklyDue(null, NOW + 86400e3), false);               // Tuesday
  assert.equal(weekKey(Date.UTC(2026, 9, 12)), "2026-W42");
  assert.equal(weekKey(Date.UTC(2027, 0, 1)), "2026-W53");
});
