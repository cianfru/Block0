import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeaderboard } from "../leaderboard.mjs";

const BT = {
  "0xta": { sym: "TA", pnl: [
    { a: "w1", invested: 1000, realized: 500, unrealized: 100, pnl: 600, roi: 0.6, up: true, holding: true },
    { a: "w2", invested: 500, realized: -200, unrealized: 0, pnl: -200, roi: -0.4, up: false, holding: false },
  ] },
  "0xtb": { sym: "TB", pnl: [
    { a: "w1", invested: 800, realized: 300, unrealized: 0, pnl: 300, roi: 0.375, up: true, holding: false },
    { a: "w3", invested: 50, realized: 80, unrealized: 0, pnl: 80, roi: 1.6, up: true, holding: false }, // dust: below minInvested
    { a: "w4", invested: 2000, realized: 1000, unrealized: 0, pnl: 1000, roi: 0.5, up: true, holding: false },
  ] },
};
const computeBt = async (addr) => BT[addr];
const tokens = [{ address: "0xta", sym: "TA" }, { address: "0xtb", sym: "TB" }];

test("aggregates realized PnL across tokens; proven multi-token winner surfaces", async () => {
  const lb = await buildLeaderboard(tokens, computeBt);
  assert.equal(lb.tokensScanned, 2);
  const w1 = lb.rows.find((r) => r.a === "w1");
  assert.ok(w1, "w1 should be on the board");
  assert.equal(w1.realized, 800);       // 500 + 300
  assert.equal(w1.tokensWon, 2);
  assert.equal(w1.tokensTraded, 2);
  assert.equal(w1.winRate, 100);
  assert.equal(w1.tokens.length, 2);
  assert.equal(w1.holdingAny, true);    // still in TA
});

test("a loser and a dust trader never make the board", async () => {
  const lb = await buildLeaderboard(tokens, computeBt);
  assert.equal(lb.rows.find((r) => r.a === "w2"), undefined); // net realized loss
  assert.equal(lb.rows.find((r) => r.a === "w3"), undefined); // below minInvested
});

test("ranking is by realized cash first", async () => {
  const lb = await buildLeaderboard(tokens, computeBt);
  assert.equal(lb.rows[0].a, "w4"); // 1000 realized > w1's 800
  assert.equal(lb.rows[1].a, "w1");
});

test("a token that fails to backtest is skipped, not fatal", async () => {
  const lb = await buildLeaderboard(
    [...tokens, { address: "0xbad", sym: "BAD" }],
    async (a) => { if (a === "0xbad") throw new Error("no data"); return BT[a]; },
  );
  assert.equal(lb.tokensScanned, 2);
  assert.ok(lb.rows.length >= 1);
});
