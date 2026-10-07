// agent/history.mjs — the hourly read history: one compact row per launch per hour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { historyRows, historyRow, historyFile, MIN_GAP_MS, KEEP_DAYS } from "../agent/history.mjs";

const NOW = Date.UTC(2026, 9, 7, 12);
const tok = (a, o = {}) => ({ address: a, sym: "X", venue: "pons", ageH: 3.456, mcapUsd: 51234.6, graduated: false, progress: 40, risk: 30,
  flags: { holders: 120, wallets: 300, top10Pct: 41.23, snipers: 4, sniperHeldPct: 2.04, bundles: 1, bundleHeldPct: 1.5, insiderSellersNow: 0, insiderDumpNowPct: 0, earlyMovedOutNow: 1 }, ...o });

test("a row keeps the facts in short keys", () => {
  assert.deepEqual(historyRow(tok("0xa"), NOW), { t: NOW, a: "0xa", s: "X", v: "p", ag: 3.46, mc: 51235, g: 0, pr: 40, h: 120, w: 300, t10: 41.2, sn: 4,
    eh: 2, b: 1, bh: 1.5, sel: 0, so: 0, mv: 1, r: 30 });
  assert.equal(historyRow(tok("0xb", { venue: "orbio-agent", graduated: true }), NOW).v, "o");
});

test("one row per launch per hour; unread launches and failed reads are skipped; old entries leave the map", () => {
  let r = historyRows([tok("0xa"), tok("0xb"), { address: "0xc", risk: null }], {}, { now: NOW });
  assert.deepEqual(r.rows.map((x) => x.a), ["0xa", "0xb"]);
  r = historyRows([tok("0xa"), tok("0xb")], r.lastAt, { now: NOW + 15 * 60e3 });
  assert.equal(r.rows.length, 0);                                       // 15 min later: nothing new
  r = historyRows([tok("0xa")], r.lastAt, { now: NOW + MIN_GAP_MS });
  assert.deepEqual(r.rows.map((x) => x.a), ["0xa"]);
  r = historyRows([], { "0xold": NOW - (KEEP_DAYS + 1) * 86400e3, "0xa": NOW }, { now: NOW });
  assert.deepEqual(Object.keys(r.lastAt), ["0xa"]);
  assert.equal(historyFile(NOW), "2026-10-07.jsonl");
});
