import { test } from "node:test";
import assert from "node:assert/strict";
import { walletPnl, tradesFromTransfers } from "../pnl.mjs";

test("avg-cost profit: buy in two lots, sell half, hold half into a higher price", () => {
  const trades = [
    { w: "a", side: "buy", qty: 100, price: 1 },
    { w: "a", side: "buy", qty: 100, price: 2 },   // qty 200, cost 300, avg 1.5
    { w: "a", side: "sell", qty: 100, price: 3 },  // realized 100*(3-1.5)=150; qty 100, cost 150
  ];
  const e = walletPnl(trades, 4).get("a");           // current price 4 → unrealized 100*(4-1.5)=250
  assert.equal(e.realized, 150);
  assert.equal(e.unrealized, 250);
  assert.equal(e.qty, 100);
  assert.equal(e.avgCost, 1.5);
  assert.equal(e.invested, 300);
  assert.equal(e.pnl, 400);
  assert.equal(e.pnlPct, 133.3);
  assert.equal(e.up, true);
  assert.equal(e.holding, true);
});

test("realized loss: bought high, sold everything lower", () => {
  const e = walletPnl([
    { w: "b", side: "buy", qty: 50, price: 10 },
    { w: "b", side: "sell", qty: 50, price: 4 },
  ], 4).get("b");
  assert.equal(e.realized, -300);
  assert.equal(e.unrealized, 0);
  assert.equal(e.qty, 0);
  assert.equal(e.pnl, -300);
  assert.equal(e.pnlPct, -60);
  assert.equal(e.up, false);
  assert.equal(e.holding, false);
});

test("untracked coins never invent profit: a sell with no on-pool buy realizes nothing", () => {
  const e = walletPnl([{ w: "c", side: "sell", qty: 100, price: 5 }], 5).get("c");
  assert.equal(e.realized, 0);
  assert.equal(e.invested, 0);
  assert.equal(e.untrackedSold, 100);
  assert.equal(e.up, false);
});

test("partial untracked: only the bought-on-pool part is credited", () => {
  const e = walletPnl([
    { w: "d", side: "buy", qty: 40, price: 2 },
    { w: "d", side: "sell", qty: 100, price: 5 },   // matches 40 @ avg 2 → 40*(5-2)=120; 60 excess untracked
  ], 5).get("d");
  assert.equal(e.realized, 120);
  assert.equal(e.untrackedSold, 60);
  assert.equal(e.qty, 0);
  assert.equal(e.pnl, 120);
});

test("tradesFromTransfers emits only priced pool trades, mapped to the right wallet", () => {
  const POOL = "0xpool";
  const isBuy = (e) => e.from === POOL;   // pool → wallet = buy
  const isSell = (e) => e.to === POOL;    // wallet → pool = sell
  const priceAt = () => 2;
  const sorted = [
    { from: POOL, to: "0xw1", amt: 10, ts: 100 },     // buy
    { from: "0xw1", to: "0xw2", amt: 5, ts: 200 },    // wallet-to-wallet → ignored (no price side)
    { from: "0xw1", to: POOL, amt: 4, ts: 300 },      // sell
    { from: POOL, to: "0xw2", amt: 0, ts: 400 },      // zero qty → ignored
  ];
  const trades = tradesFromTransfers(sorted, { isBuy, isSell, priceAt });
  assert.equal(trades.length, 2);
  assert.deepEqual(trades[0], { w: "0xw1", side: "buy", qty: 10, price: 2 });
  assert.deepEqual(trades[1], { w: "0xw1", side: "sell", qty: 4, price: 2 });
});
