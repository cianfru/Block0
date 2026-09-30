import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTransfers, classify, positions, verdict, unknownCounterparties, unverifiedBuys, topicOf, TRANSFER, walletKind, blockClock } from "../public/radar-core.js";

const A = (n) => "0x" + String(n).padStart(40, "a");
const SW1 = A(1), SW2 = A(2), SW3 = A(3), JOE = A(4);           // three smart wallets, one ordinary wallet
const AMM = A(90), POOL = A(91), MEME = A(50), MEME2 = A(51), WETH = A(60);
const log = (token, from, to, amt, block, tx, i = 0) => ({ address: token, topics: [TRANSFER, topicOf(from), topicOf(to)],
  data: "0x" + (BigInt(Math.round(amt * 1e6)) * 10n ** 12n).toString(16).padStart(64, "0"), blockNumber: "0x" + block.toString(16), transactionHash: tx, logIndex: "0x" + i.toString(16) });
const ctx = { smart: new Set([SW1, SW2, SW3]), venues: new Set([AMM]), quotes: new Set([WETH]), kinds: { [POOL]: "contract", [JOE]: "eoa" } };
const meta = new Map([[SW1, { tier: "sharp", tokensWon: 5, winRate: 0.8 }], [SW2, { tier: "proven", tokensWon: 2, winRate: 0.5 }], [SW3, { tier: "proven" }]]);

test("decode: 18-decimal amounts, addresses from topics, non-transfers dropped", () => {
  const t = decodeTransfers([log(MEME, AMM, SW1, 1234.5, 100, "0x1"), { topics: ["0xdead"] }]);
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].token, t[0].from, t[0].to, t[0].amt, t[0].block], [MEME, AMM, SW1, 1234.5, 100]);
});

test("classify: venue→smart is a buy, smart→venue a sell, wallet↔wallet a transfer; quote legs ignored", () => {
  const moves = classify(decodeTransfers([
    log(MEME, AMM, SW1, 100, 10, "0xa"),                          // buy via the AMM
    log(WETH, SW1, AMM, 1, 10, "0xa", 1),                         // …paid in WETH — the quote leg, ignored
    log(MEME, POOL, SW2, 50, 11, "0xb"),                          // buy from a pool contract (resolved by getCode)
    log(MEME, SW2, JOE, 5, 12, "0xc"),                            // gift to a person — not a decision
    log(WETH, AMM, SW3, 2, 13, "0xd"), log(MEME2, SW3, AMM, 70, 13, "0xd", 1),   // SELLS MEME2: receiving WETH is not a buy
  ]), ctx);
  assert.deepEqual(moves.map((m) => [m.w, m.token, m.side]), [[SW1, MEME, "buy"], [SW2, MEME, "buy"], [SW2, MEME, "transfer"], [SW3, MEME2, "sell"]]);
});

test("classify: several legs of one routed swap merge into one move", () => {
  const moves = classify(decodeTransfers([log(MEME, AMM, SW1, 60, 10, "0xa", 0), log(MEME, AMM, SW1, 40, 10, "0xa", 3)]), ctx);
  assert.equal(moves.length, 1); assert.equal(moves[0].amt, 100);
});

test("positions: two holders converge; a round-tripper is exited; ranking puts convergence first", () => {
  const moves = classify(decodeTransfers([
    log(MEME, AMM, SW1, 100, 10, "0xa"), log(MEME, AMM, SW2, 50, 12, "0xb"),
    log(MEME, AMM, SW3, 80, 13, "0xc"), log(MEME, SW3, AMM, 79, 15, "0xd"),          // SW3 flips out
    log(MEME2, AMM, SW1, 10, 20, "0xe"),                                             // lone buy elsewhere
  ]), ctx);
  const rows = positions(moves, meta);
  assert.equal(rows[0].token, MEME); assert.equal(rows[0].signal, "converging");
  assert.equal(rows[0].nHolding, 2); assert.equal(rows[0].nSharp, 1); assert.equal(rows[0].nSellers, 1);
  assert.equal(rows[0].wallets.find((w) => w.a === SW3).status, "exited");
  assert.equal(rows[1].signal, "activity");
  assert.match(verdict(rows[0], { minutesAgo: 4, mcapUsd: 120000 }), /^2 proven wallets \(1 sharp\) bought and still hold · 1 selling · last buy 4 min ago · now \$120k$/);
});

test("positions: two wallets distributing old bags reads as exiting; sinceBlock trims the window", () => {
  const moves = classify(decodeTransfers([log(MEME, SW1, AMM, 5, 30, "0xa"), log(MEME, SW2, AMM, 5, 31, "0xb"), log(MEME2, AMM, SW1, 1, 5, "0xc")]), ctx);
  const rows = positions(moves, meta, { sinceBlock: 10 });
  assert.equal(rows.length, 1); assert.equal(rows[0].signal, "exiting");
  assert.ok(rows[0].wallets.every((w) => w.status === "selling"));
  assert.doesNotMatch(verdict(rows[0]), /buy now|moon|ape|100x/i);
});

test("unknownCounterparties lists only unresolved non-smart, non-venue sides", () => {
  const t = decodeTransfers([log(MEME, A(77), SW1, 1, 1, "0x1"), log(MEME, AMM, SW1, 1, 1, "0x2"), log(MEME, POOL, SW2, 1, 1, "0x3"), log(MEME, SW1, SW2, 1, 1, "0x4")]);
  assert.deepEqual(unknownCounterparties(t, ctx), [A(77)]);
});

test("walletKind + blockClock", () => {
  assert.equal(walletKind("0x"), "eoa");
  assert.equal(walletKind("0xef0100" + "ab".repeat(20)), "delegated");
  assert.equal(walletKind("0x6080"), "contract");
  const at = blockClock(1000, 5000, 2000, 5100);                  // 0.1 s blocks
  assert.equal(at(2000), 5100); assert.equal(at(2600), 5160);
});

test("buys the wallet did not send itself are 'pushed' (airdrop spam), unresolved ones 'pending' — neither counts", () => {
  const t = decodeTransfers([log(MEME, POOL, SW1, 10, 1, "0xself"), log(MEME, POOL, SW2, 10, 1, "0xdrop"), log(MEME, POOL, SW3, 10, 1, "0xunknown")]);
  const senders = { "0xself": { from: SW1, to: POOL }, "0xdrop": { from: A(66), to: POOL } };
  assert.deepEqual(unverifiedBuys(t, { ...ctx, senders }), ["0xunknown"]);
  const moves = classify(t, { ...ctx, senders });
  assert.deepEqual(moves.map((m) => m.side), ["buy", "pushed", "pending"]);
  const rows = positions(moves, meta);
  assert.equal(rows.length, 1); assert.equal(rows[0].wallets.length, 1); assert.equal(rows[0].signal, "activity");
});
