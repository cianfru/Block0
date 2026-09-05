import { test } from "node:test";
import assert from "node:assert/strict";
import { walletPnlReport } from "../wallet-pnl.mjs";

// per-token backtests keyed by token address; each carries a top-100 pnl list (as backtest.mjs returns)
const BT = {
  "0xaa": { sym: "AA", curPrice: 0.02, supply: 1e9, pnl: [
    { a: "0xme", invested: 1000, realized: 500, unrealized: 200, proceeds: 1500, pnl: 700, roi: 0.7, qty: 10000, avgCost: 0.01, nBuys: 3, nSells: 1, holding: true, up: true, untrackedSold: 0 },
    { a: "0xother", invested: 500, realized: -100, unrealized: 0, proceeds: 400, pnl: -100, roi: -0.2, qty: 0, avgCost: 0, nBuys: 1, nSells: 1, holding: false, up: false, untrackedSold: 0 },
  ] },
  "0xbb": { sym: "BB", curPrice: 0.005, supply: 1e9, pnl: [
    { a: "0xme", invested: 800, realized: -300, unrealized: 0, proceeds: 500, pnl: -300, roi: -0.375, qty: 0, avgCost: 0, nBuys: 2, nSells: 2, holding: false, up: false, untrackedSold: 0 },
  ] },
  "0xcc": { sym: "CC", curPrice: 0.1, supply: 1e9, pnl: [
    { a: "0xsomeone", invested: 999, realized: 999, unrealized: 0, proceeds: 1998, pnl: 999, roi: 1, qty: 0, avgCost: 0, nBuys: 1, nSells: 1, holding: false, up: true, untrackedSold: 0 },
  ] },
};
const computeBt = async (addr) => BT[addr];
const tokens = [{ address: "0xaa", graduated: true }, { address: "0xbb" }, { address: "0xcc" }];

test("aggregates one wallet's PnL across the winner set (realized + unrealized)", async () => {
  const r = await walletPnlReport("0xme", tokens, computeBt);
  assert.equal(r.found, true);
  assert.equal(r.tokens.length, 2);                 // traded AA + BB, not CC
  assert.equal(r.totals.realized, 200);             // +500 (AA) − 300 (BB)
  assert.equal(r.totals.unrealized, 200);           // +200 (AA)
  assert.equal(r.totals.pnl, 400);                  // 200 + 200
  assert.equal(r.totals.invested, 1800);            // 1000 + 800
  assert.equal(r.totals.tokensWon, 1);              // only AA cleared +$100 realized
  assert.equal(r.totals.tokensLost, 1);             // BB net negative
  assert.equal(r.totals.tokensHeld, 1);             // still holding AA
  assert.equal(r.totals.tokensRiding, 1);           // AA held with a positive unrealized
});

test("biggest swing first; case-insensitive address; per-token fields carried through", async () => {
  const r = await walletPnlReport("0xME", tokens, computeBt);   // upper-case in → normalized
  assert.equal(r.address, "0xme");
  assert.equal(r.tokens[0].sym, "AA");              // |700| > |−300|
  assert.equal(r.tokens[0].avgCost, 0.01);
  assert.equal(r.tokens[0].curPrice, 0.02);
  assert.equal(r.tokens[0].graduated, true);
});

test("a wallet that traded nothing in the set → found:false, no crash", async () => {
  const r = await walletPnlReport("0xghost", tokens, computeBt);
  assert.equal(r.found, false);
  assert.equal(r.tokens.length, 0);
  assert.equal(r.totals.pnl, 0);
});

test("a token that fails to backtest is skipped, not fatal", async () => {
  const r = await walletPnlReport("0xme", [...tokens, { address: "0xbad" }],
    async (a) => { if (a === "0xbad") throw new Error("no data"); return BT[a]; });
  assert.equal(r.found, true);
  assert.equal(r.tokens.length, 2);
});

test("deadline: a slow backtest returns a fast PARTIAL report instead of blocking the caller", async () => {
  const slow = () => new Promise((r) => setTimeout(() => r(BT["0xaa"]), 2000));   // slower than the deadline
  const t0 = Date.now();
  const r = await walletPnlReport("0xme", tokens, slow, { deadlineMs: 150 });
  const took = Date.now() - t0;
  assert.ok(took < 1000, `should return near the deadline, took ${took}ms`);
  assert.equal(r.partial, true);        // flagged so the endpoint reports "computing", never "traded nothing"
  assert.equal(r.found, false);         // nothing finished inside the deadline
});

test("deadline: fast backtests still complete fully (deadline never truncates a warm scan)", async () => {
  const r = await walletPnlReport("0xme", tokens, computeBt, { deadlineMs: 5000 });
  assert.equal(r.partial, false);
  assert.equal(r.found, true);
  assert.equal(r.tokens.length, 2);
});
