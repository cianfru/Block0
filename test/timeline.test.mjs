// The token timeline (agent/timeline.mjs) + the evidence it carries (intel.mjs early sellers) + its dossier rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { entryOf, stateEntries, appendTimeline, backfillEntries, expired, MAX_ENTRIES } from "../agent/timeline.mjs";
import { analyzeTransfers } from "../intel.mjs";
import { detectEvents } from "../alert-events.mjs";

const A = "0x" + "a".repeat(40), NOW = Date.UTC(2026, 9, 3, 12);

test("an early-wallet sale carries its evidence: wallet, amount, block — and the share can never pass 100%", () => {
  const ZERO = "0x" + "0".repeat(40), P = "0x" + "1".repeat(40), W = (n) => "0x" + String(n).padStart(40, "b"), T0 = 1_790_000_000;
  // every wallet sells everything back: nothing is left in wallets (the live "312429251.95%" case)
  const ev = [{ from: ZERO, to: P, amt: 1000, block: 1, ts: T0 }, { from: P, to: W(1), amt: 100, block: 10, ts: T0 + 10 },
    { from: W(1), to: P, amt: 100, block: 500, ts: T0 + 7200 }];
  const out = analyzeTransfers(ev, { ponsPool: P, obsTs: T0 + 7260 }).out;
  assert.equal(out.flags.insiderSellersNow, 1);
  assert.equal(out.flags.insiderDumpNowPct, 100);
  assert.deepEqual(out.earlySellersNow, [{ a: W(1), amt: 100, block: 500, bal: 0 }]);
  // …and the detector puts it on the event
  const t = { address: A, sym: "X", mcapUsd: 50000, ageH: 2, risk: 40, flags: { ...out.flags, holders: 10 }, earlySellersNow: out.earlySellersNow, latestBlock: 501 };
  const seed = detectEvents(null, [{ ...t, flags: { ...t.flags, insiderSellersNow: 0 } }], { now: NOW });
  const { events } = detectEvents(seed.next, [t], { now: NOW });
  assert.equal(events.length, 1);
  assert.match(events[0].headline, /100% of wallet-held supply/);
  const e = entryOf(events[0]);
  assert.equal(e.evidence.wallets[0].a, W(1));
  assert.equal(e.evidence.wallets[0].block, 500);
  assert.equal(e.evidence.block, 501);
  assert.deepEqual([e.sev, e.label, e.context.mcapUsd], ["bad", "early wallets selling", 50000]);
});

test("Orbio events carry the owner wallet and the source", () => {
  const e = entryOf({ id: "principal-withdrawn:" + A + ":1", at: 1, kind: "principal-withdrawn", address: A, owner: "0xowner", agentId: "7", detail: { withdrawnOrbio: 10 }, headline: "creator withdrew 10 staked ORBIO" });
  assert.equal(e.evidence.owner, "0xowner");
  assert.match(e.evidence.source, /Orbio/);
  assert.equal(e.evidence.detail.withdrawnOrbio, 10);
});

test("state entries: a coverage marker on first sight only (graduation is a detector event in the tick)", () => {
  const cur = { address: A, graduated: true, mcapUsd: 1, flags: { holders: 9 }, risk: 3, launchedAgeH: 5 };
  assert.deepEqual(stateEntries(null, cur, { now: 5, first: true }).map((e) => e.kind), ["coverage"]);
  assert.equal(stateEntries(null, cur, { now: 5, first: true })[0].context.holders, 9);
  assert.deepEqual(stateEntries({ graduated: false }, cur, { now: 5 }), []);
});

test("appendTimeline: newest first, deduped by id, bounded, the coverage marker kept", () => {
  const cov = stateEntries(null, { address: A }, { now: 1, first: true });
  let tl = appendTimeline(null, cov, { address: A, now: 1 });
  const evs = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ id: "e" + i, at: 10 + i, kind: "insider-dump", sev: "bad" }));
  tl = appendTimeline(tl, evs, { address: A, sym: "X", now: 2 });
  assert.equal(tl.entries.length, MAX_ENTRIES);
  assert.equal(tl.entries[0].id, "e" + (MAX_ENTRIES + 4));
  assert.ok(tl.entries.some((e) => e.kind === "coverage"));
  tl = appendTimeline(tl, [{ id: "e104", at: 114, kind: "insider-dump", headline: "updated" }], { address: A, now: 3 });
  assert.equal(tl.entries.filter((e) => e.id === "e104").length, 1);
  assert.equal(tl.entries[0].headline, "updated");
  assert.equal(tl.sym, "X");
  assert.equal(tl.lastEventAt, 114);
});

test("expiry: 30 days after the last event or update", () => {
  assert.equal(expired({ lastEventAt: NOW - 31 * 86400e3, updated: NOW - 31 * 86400e3 }, NOW), true);
  assert.equal(expired({ lastEventAt: NOW - 31 * 86400e3, updated: NOW - 86400e3 }, NOW), false);
});

test("backfill: ledger rows become entries marked as such; the first detector's 'insider' rows are left out", () => {
  const rows = [
    { at: 1, kind: "insider-dump", address: A, sym: "X", headline: "6 insider wallets started selling" },
    { at: 2, kind: "serial-owner", address: A, sym: "X", headline: "owner wallet launched 4 agents" },
    { at: 2, kind: "serial-owner", address: A, sym: "X", headline: "owner wallet launched 4 agents", validated: true },   // same event in alerts.json
    { at: 3, kind: "clean-launch", address: A, headline: "risk 10" },
  ];
  const out = backfillEntries(rows);
  assert.deepEqual(out.map((e) => e.kind).sort(), ["clean-launch", "serial-owner"]);
  assert.ok(out.every((e) => e.evidence.backfilled));
  assert.equal(out.find((e) => e.kind === "clean-launch").validated, false);
});

// the dossier page renders the timeline from /api/timeline/<address>
test("dossier: the timeline section renders entries, evidence and the unvalidated tag, escaped", async () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/m, "").replace(/\nload\(\);\s*$/, "");
  const address = "0x" + "c".repeat(40), tlbox = { innerHTML: "" };
  const tl = appendTimeline(null, [
    entryOf({ id: "a", at: NOW - 3600e3, kind: "insider-dump", address, headline: "2 early wallets sold <b>x</b>", mcapUsd: 40000, holders: 80, ageH: 3,
      detail: { wallets: [{ a: "0x" + "d".repeat(40), amt: 5000, block: 123, bal: 0 }] } }),
    entryOf({ id: "b", at: NOW - 7200e3, kind: "clean-launch", address, headline: "risk 10" }, { validated: false }),
  ], { address, now: NOW });
  const ctx = vm.createContext({
    dossierView: (x) => x, LIVE_MIN: 45, MAX_READ_MIN: 180, URLSearchParams, Date: class extends Date { static now() { return NOW; } },
    location: { search: `?address=${address}` }, window: {},
    document: { querySelector: (s) => (s === "#tlbox" ? tlbox : null), addEventListener() {} }, setTimeout() {}, clearTimeout() {},
    fetch: async (url) => (url === `/api/timeline/${address}` ? { ok: true, headers: { get: () => "text/plain" }, json: async () => tl } : { ok: false }),
  });
  vm.runInContext(script, ctx);
  await vm.runInContext("loadTimeline()", ctx);
  const h = tlbox.innerHTML;
  assert.match(h, /early wallets selling/);
  assert.match(h, /2 early wallets sold &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(h, /block 123/);
  assert.match(h, /holds none now/);
  assert.match(h, /not validated · not posted/);
  assert.match(h, /\$40\.0k market cap · 80 holders · 3\.0h after launch/);
  assert.match(h, /2 events recorded/);
});
