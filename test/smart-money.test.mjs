import { test } from "node:test";
import assert from "node:assert/strict";
import { smartMoneyFrom, smartHolders, convergence } from "../smart-money.mjs";

test("smartMoneyFrom: only proven wallets (>=1 win), lowercased, with track record", () => {
  const lb = { updated: 7, rows: [
    { a: "0xAAA", realized: 5000, roi: 3.1, tokensWon: 4, winRate: 80, holdingAny: true },
    { a: "0xBbB", realized: 1200, roi: 1.4, tokensWon: 1, winRate: 66, holdingAny: false },
    { a: "0xCCC", realized: 300, roi: 0.5, tokensWon: 0, winRate: 0 }, // 0 wins → excluded
  ] };
  const sm = smartMoneyFrom(lb);
  assert.equal(sm.size, 2);
  assert.ok(sm.set.has("0xaaa") && sm.set.has("0xbbb"));
  assert.ok(!sm.set.has("0xccc"));
  assert.equal(sm.meta["0xaaa"].tokensWon, 4);
  assert.equal(sm.updated, 7);
});

test("smartHolders: intersects holders with the set, sorted by bag, ignores dust/non-members", () => {
  const { set, meta } = smartMoneyFrom({ rows: [
    { a: "0xaaa", realized: 5000, roi: 3, tokensWon: 4, winRate: 80 },
    { a: "0xbbb", realized: 1200, roi: 1, tokensWon: 2, winRate: 60 },
  ] });
  const holders = [{ a: "0xaaa", bal: 900000 }, { a: "0xnope", bal: 999999 }, { a: "0xbbb", bal: 120000 }, { a: "0xaaa2", bal: 0 }];
  const sh = smartHolders(holders, set, meta);
  assert.equal(sh.count, 2);
  assert.equal(sh.wallets[0].a, "0xaaa"); // biggest bag first
  assert.equal(sh.wallets[0].tokensWon, 4);
  assert.equal(sh.held, 1020000);
});

test("smartHolders: null when set empty or no smart holder present", () => {
  assert.equal(smartHolders([{ a: "0xaaa", bal: 5 }], new Set(), {}), null);
  assert.equal(smartHolders([{ a: "0xzzz", bal: 5 }], new Set(["0xaaa"]), {}), null);
});

test("convergence: only tokens at/above minCount, ranked by count then mcap", () => {
  const sections = {
    cooking: [{ address: "0x1", sym: "AAA", mcapUsd: 1e5, risk: 20, smart: { count: 3, held: 9, wallets: [] } }],
    dex: [{ address: "0x2", sym: "BBB", mcapUsd: 5e5, risk: 30, smart: { count: 2, held: 4, wallets: [] } },
          { address: "0x3", sym: "CCC", mcapUsd: 9e9, risk: 10, smart: { count: 1, held: 1, wallets: [] } }],
  };
  const rows = convergence(sections, { minCount: 2 });
  assert.deepEqual(rows.map((r) => r.sym), ["AAA", "BBB"]); // CCC (count 1) excluded; AAA (3) before BBB (2)
});
