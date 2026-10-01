import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTransfers, classify, positions, verdict, unknownCounterparties, unverifiedBuys, topicOf, TRANSFER, walletKind, blockClock } from "../public/radar-core.js";

const A = (n) => "0x" + String(n).padStart(40, "a");
const SW1 = A(1), SW2 = A(2), SW3 = A(3), JOE = A(4);           // three smart wallets, one ordinary wallet
const AMM = A(90), POOL = A(91), POOL2 = A(92), MEME = A(50), MEME2 = A(51), WETH = A(60);
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
    log(MEME, POOL, SW2, 50, 11, "0xb"), log(WETH, SW2, POOL, 1, 11, "0xb", 1),   // buy from a pool contract, paid in WETH
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
  assert.match(verdict(rows[0], { minutesAgo: 4, mcapUsd: 120000 }), /^2 proven wallets \(1 sharp\) bought and have not sold or moved it since · 1 sold or moved out · last buy 4 min ago · now \$120k$/);
});

test("positions: two wallets distributing old bags reads as exiting; sinceBlock trims the window", () => {
  const moves = classify(decodeTransfers([log(MEME, SW1, AMM, 5, 30, "0xa"), log(MEME, SW2, AMM, 5, 31, "0xb"), log(MEME2, AMM, SW1, 1, 5, "0xc")]), ctx);
  const rows = positions(moves, meta, { sinceBlock: 10 });
  assert.equal(rows.length, 1); assert.equal(rows[0].signal, "exiting");
  assert.ok(rows[0].wallets.every((w) => w.status === "selling"));
  assert.doesNotMatch(verdict(rows[0]), /buy now|moon|ape|100x/i);
});

test("v3: partial sales, transfers and deposits cannot qualify as no-outflow convergence", () => {
  for (const side of ["sell", "transfer", "deposit"]) {
    const moves = [SW1, SW2].flatMap(w => [
      { w, token: MEME, side: "buy", dir: "in", amt: 100, block: 1 },
      { w, token: MEME, side, dir: "out", amt: 10, block: 2 },
      { w, token: MEME, side: "buy", dir: "in", amt: 100, block: 3 },
    ]);
    const r = positions(moves.reverse(), meta)[0];
    assert.equal(r.nHolding, 0);
    assert.notEqual(r.signal, "converging");
    assert.doesNotMatch(verdict(r), /have not sold|none bought/);
  }
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
  const senders = { "0xself": { from: SW1, to: POOL, value: "0x5" }, "0xdrop": { from: A(66), to: POOL, value: "0x0" } };
  assert.deepEqual(unverifiedBuys(t, { ...ctx, senders }), ["0xunknown"]);
  const moves = classify(t, { ...ctx, senders });
  assert.deepEqual(moves.map((m) => m.side), ["buy", "pushed", "pending"]);
  const rows = positions(moves, meta);
  assert.equal(rows.length, 1); assert.equal(rows[0].wallets.length, 1); assert.equal(rows[0].signal, "activity");
});

// ── audit F03 / F04 / F10 ──────────────────────────────────────────────────────────────────────────────────────────
test("F03: two wallets that bought and then sent everything away are not 'converging'", () => {
  const moves = classify(decodeTransfers([
    log(MEME, AMM, SW1, 100, 10, "0xa"), log(MEME, AMM, SW2, 100, 11, "0xb"),
    log(MEME, SW1, JOE, 100, 12, "0xc"), log(MEME, SW2, POOL2, 100, 13, "0xd"),        // to a person, and into a vault
  ]), { ...ctx, kinds: { ...ctx.kinds, [POOL2]: "contract" } });
  const rows = positions(moves, meta);
  assert.equal(rows[0].signal, "exiting");
  assert.deepEqual(rows[0].wallets.map((w) => w.status).sort(), ["moved", "moved"]);
  assert.doesNotMatch(verdict(rows[0]), /hold/);
});

test("F03: a sale with no buy in the window is 'selling', never 'sold out'; last buy is tracked apart from sells", () => {
  const moves = classify(decodeTransfers([log(MEME, AMM, SW1, 100, 10, "0xa"), log(MEME, AMM, SW2, 50, 12, "0xb"), log(MEME, SW3, AMM, 5, 40, "0xc")]), ctx);
  const r = positions(moves, meta)[0];
  assert.deepEqual([r.lastBuyBlock, r.lastBlock], [12, 40]);
  const ex = positions(classify(decodeTransfers([log(MEME, SW1, AMM, 5, 30, "0xa"), log(MEME, SW2, AMM, 5, 31, "0xb")]), ctx), meta)[0];
  assert.doesNotMatch(verdict(ex), /sold out/);
});

test("F04: tokens from a contract with nothing paid are 'received' (a claim), not a buy; a paid one is a buy", () => {
  const t = decodeTransfers([log(MEME, POOL, SW1, 10, 1, "0xclaim"), log(MEME, POOL, SW2, 10, 1, "0xbuy"), log(MEME, POOL, SW3, 10, 1, "0xweth"), log(WETH, SW3, POOL, 1, 1, "0xweth", 1)]);
  const senders = { "0xclaim": { from: SW1, to: POOL, value: "0x0" }, "0xbuy": { from: SW2, to: POOL, value: "0x2386f26fc10000" }, "0xweth": { from: SW3, to: POOL, value: "0x0" } };
  assert.deepEqual(classify(t, { ...ctx, senders }).map((m) => [m.w, m.side]), [[SW1, "received"], [SW2, "buy"], [SW3, "buy"]]);
});

test("F04: selling into the curve a wallet bought from is a sell; sending to an unrelated contract is a deposit", () => {
  const t = decodeTransfers([log(MEME, POOL, SW1, 10, 1, "0xbuy"), log(MEME, SW1, POOL, 4, 2, "0xsell"), log(MEME, SW1, POOL2, 4, 3, "0xstake")]);
  const senders = { "0xbuy": { from: SW1, to: POOL, value: "0x1" } };
  const sides = classify(t, { ...ctx, kinds: { ...ctx.kinds, [POOL2]: "contract" }, senders }).map((m) => m.side);
  assert.deepEqual(sides, ["buy", "sell", "deposit"]);
});

test("F10: a log seen twice (both queries, or a retried pull) is counted once", async () => {
  const { makeFeed, walletsFrom } = await import("../public/radar-feed.js");
  const W = walletsFrom({ wallets: [{ a: SW1 }, { a: SW2 }], venues: [AMM], quotes: [WETH] });
  const HEAD = 0x100000, B = HEAD - 30000;                       // 1 s blocks: a 10 h window is two 25k-block chunks
  const buy = log(MEME, AMM, SW1, 100, B, "0xa"), between = log(MEME, SW1, SW2, 10, B + 1, "0xb", 1);
  let failNext = true;
  const f = async (url, init) => {
    const body = JSON.parse(init.body), calls = Array.isArray(body) ? body : [body];
    const res = calls.map((c) => {
      if (c.method === "eth_blockNumber") return "0x" + HEAD.toString(16);
      if (c.method === "eth_getBlockByNumber") return { timestamp: "0x" + parseInt(c.params[0], 16).toString(16) };
      if (c.method === "eth_getLogs") {
        if (parseInt(c.params[0].fromBlock, 16) > B + 10) { if (failNext) { failNext = false; return { error: true }; } return []; }
        return [buy, between];                                   // the same logs from the in- AND the out-query
      }
      if (c.method === "eth_getTransactionByHash") return { from: SW1, to: AMM, value: "0x0" };
      return null;
    });
    if (res.some((r) => r?.error)) return { status: 200, json: async () => ({ error: { message: "node down" } }) };
    return { status: 200, json: async () => (Array.isArray(body) ? res.map((r, id) => ({ id, result: r })) : { result: res[0] }) };
  };
  const feed = makeFeed(W, { fetch: f });
  await assert.rejects(feed.tick(10));                           // second chunk fails after the first was ingested
  const r = await feed.tick(10);                                 // the retry pulls the first chunk again
  assert.equal(r.rows[0].wallets.find((w) => w.a === SW1).bought, 100);
  assert.equal(r.moves.filter((m) => m.tx === "0xb").length, 2); // out of SW1 + into SW2, once each
});
