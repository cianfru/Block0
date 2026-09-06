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
  "0xtc": { sym: "TC", pnl: [
    { a: "w4", invested: 1500, realized: 600, unrealized: 0, pnl: 600, roi: 0.4, up: true, holding: false },
  ] },
};
const computeBt = async (addr) => BT[addr];
const tokens = [{ address: "0xta", sym: "TA" }, { address: "0xtb", sym: "TB" }, { address: "0xtc", sym: "TC" }];

test("aggregates realized PnL across tokens; proven multi-token winner surfaces", async () => {
  const lb = await buildLeaderboard(tokens, computeBt);
  assert.equal(lb.tokensScanned, 3);
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
  assert.equal(lb.rows[0].a, "w4"); // 1600 realized > w1's 800
  assert.equal(lb.rows[1].a, "w1");
});

test("PROVEN needs wins on MULTIPLE tokens — one win is indistinguishable from being that launch's insider", async () => {
  const oneHit = { sym: "ONE", pnl: [{ a: "w9", invested: 5000, realized: 99999, unrealized: 0, pnl: 99999, roi: 20, up: true, holding: false }] };
  const lb = await buildLeaderboard([{ address: "0xone", sym: "ONE" }], async () => oneHit);
  const w9 = lb.rows.find((r) => r.a === "w9");
  assert.ok(!w9 || w9.proven !== true, "a single-token winner is never 'proven', however large the win");
});

test("a win on a token the wallet SNIPED at block 0 does not count toward proof (launch access, not skill)", async () => {
  const row = (a, sniper) => ({ a, invested: 1000, realized: 5000, unrealized: 0, pnl: 5000, roi: 5, up: true, holding: false, sniper });
  // wS: one sniped win + one clean win → only 1 clean → NOT proven. wC: two clean wins → proven.
  const A = { sym: "A", pnl: [row("wS", true), row("wC", false)] };
  const B = { sym: "B", pnl: [row("wS", false), row("wC", false)] };
  const lb = await buildLeaderboard([{ address: "0xa", sym: "A" }, { address: "0xb", sym: "B" }], async (x) => (x === "0xa" ? A : B));
  const wC = lb.rows.find((r) => r.a === "wC");
  assert.ok(wC && wC.proven === true, "two clean wins → proven");
  assert.equal(wC.tokensWonClean, 2);
  const wS = lb.rows.find((r) => r.a === "wS");
  assert.ok(!wS || wS.proven !== true, "the sniped win cannot be the second proof — same cash, not proven");
});

test("riding: a diamond-hand with big unrealized on a REAL-MARKET token qualifies (kind=riding), gated by market quality", async () => {
  // a genuine runner: high mcap, live price, many traders → unrealized counts
  const realRunner = { sym: "RUN", curPrice: 0.01, supply: 1e9 /* mcap $10M */, pnlStats: { traders: 40 }, pnl: [
    { a: "diamond", invested: 1000, realized: 0, unrealized: 40000, pnl: 40000, roi: 40, up: true, holding: true },
  ] };
  // a thin mirage: tiny mcap / few traders → the same paper gain must NOT qualify anyone
  const mirage = { sym: "MIR", curPrice: 0.00001, supply: 1e6 /* mcap $10 */, pnlStats: { traders: 2 }, pnl: [
    { a: "paperhands", invested: 1000, realized: 0, unrealized: 40000, pnl: 40000, roi: 40, up: true, holding: true },
  ] };
  const lb = await buildLeaderboard(
    [{ address: "0xrun", sym: "RUN" }, { address: "0xmir", sym: "MIR" }],
    async (a) => (a === "0xrun" ? realRunner : mirage),
  );
  const d = lb.rows.find((r) => r.a === "diamond");
  assert.ok(d, "diamond should qualify on unrealized");
  assert.equal(d.kind, "riding");
  assert.equal(d.proven, false);
  assert.equal(d.tokensRiding, 1);
  assert.ok(d.ridingProfit >= 40000);
  assert.equal(lb.rows.find((r) => r.a === "paperhands"), undefined); // mirage gated out
});

test("contract wallets (bots/routers/pools) are checked and excluded, and the count is reported", async () => {
  // w4 (top of the board) is a contract → dropped; w1 stays. isContract only called for ranked candidates.
  const seen = [];
  const isContract = async (a) => { seen.push(a); return a === "w4"; };
  const lb = await buildLeaderboard(tokens, computeBt, { isContract });
  assert.equal(lb.contractsChecked, true);
  assert.equal(lb.contractsFiltered, 1);
  assert.equal(lb.rows.find((r) => r.a === "w4"), undefined); // the contract is gone
  assert.equal(lb.rows[0].a, "w1");                            // next-ranked human takes the top
  assert.ok(seen.includes("w4") && seen.includes("w1"));
});

test("no isContract probe → old behaviour, nothing filtered", async () => {
  const lb = await buildLeaderboard(tokens, computeBt);
  assert.equal(lb.contractsChecked, false);
  assert.equal(lb.contractsFiltered, 0);
  assert.ok(lb.rows.find((r) => r.a === "w4"));
});

test("a token that fails to backtest is skipped, not fatal", async () => {
  const lb = await buildLeaderboard(
    [...tokens, { address: "0xbad", sym: "BAD" }],
    async (a) => { if (a === "0xbad") throw new Error("no data"); return BT[a]; },
  );
  assert.equal(lb.tokensScanned, 3);
  assert.ok(lb.rows.length >= 1);
});
