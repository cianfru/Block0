import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPair, marketSnapshot, normalizeOhlc, tokenMarket } from "../market.mjs";

const A = "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a";
const pairFor = (addr, liq, vol) => ({ pairAddress: "0xpool" + liq, dexId: "uniswap", url: "u", labels: ["v4"],
  baseToken: { address: addr }, quoteToken: { address: "0xweth" }, priceUsd: "0.0166",
  liquidity: { usd: liq }, volume: { h24: vol }, priceChange: { h24: 31.9 }, txns: { h24: { buys: 35911, sells: 34493 } },
  fdv: 1.6e7, marketCap: 1.6e7, pairCreatedAt: 1788500000000 });

test("pickPair: deepest-liquidity pool where the token is the BASE asset", () => {
  const pairs = [pairFor(A, 100000, 5e6), pairFor(A, 374000, 2.3e7), { pairAddress: "0xother", baseToken: { address: "0xdead" }, liquidity: { usd: 9e9 } }];
  const p = pickPair(pairs, A);
  assert.equal(p.liquidity.usd, 374000, "picks the deepest MINE, never the pool where we're not the base");
});

test("pickPair: no indexed pair → null", () => {
  assert.equal(pickPair(null, A), null);
  assert.equal(pickPair([{ pairAddress: "x", baseToken: { address: "0xnotme" } }], A), null);
});

test("marketSnapshot: only real numeric fields, buys/sells extracted", () => {
  const s = marketSnapshot(pairFor(A, 374000, 2.3e7));
  assert.equal(s.liqUsd, 374000); assert.equal(s.vol24, 2.3e7); assert.equal(s.change24, 31.9);
  assert.equal(s.buys24, 35911); assert.equal(s.sells24, 34493); assert.equal(s.priceUsd, 0.0166);
  assert.equal(marketSnapshot(null), null);
});

test("normalizeOhlc: GeckoTerminal newest-first → oldest-first {t,o,h,l,c,v}, malformed dropped", () => {
  const json = { data: { attributes: { ohlcv_list: [
    [1788598800, 0.0121, 0.0165, 0.0121, 0.0164, 72410],
    [1788595200, 0.0154, 0.0172, 0.0109, 0.0121, 51000],
    [1788591600, 0, 0, 0, 0, 0],            // malformed → dropped
    "garbage",                                // malformed → dropped
  ] } } };
  const c = normalizeOhlc(json);
  assert.equal(c.length, 2);
  assert.ok(c[0].t < c[1].t, "sorted oldest first");
  assert.deepEqual([c[1].o, c[1].h, c[1].l, c[1].c], [0.0121, 0.0165, 0.0121, 0.0164]);
});

test("tokenMarket: assembles + caches; degrades honestly when no pair", async () => {
  let calls = 0;
  const okFetch = async (url) => { calls++;
    if (url.includes("/tokens/")) return { ok: true, json: async () => ({ pairs: [pairFor(A, 374000, 2.3e7)] }) };
    return { ok: true, json: async () => ({ data: { attributes: { ohlcv_list: [[1788598800, 0.0121, 0.0165, 0.0121, 0.0164, 72410]] } } }) };
  };
  let t = 1_000_000;
  const m1 = await tokenMarket(A, "1h", { fetch: okFetch, now: () => t });
  assert.equal(m1.hasMarket, true); assert.equal(m1.market.liqUsd, 374000); assert.equal(m1.candles.length, 1);
  const before = calls;
  await tokenMarket(A, "1h", { fetch: okFetch, now: () => t + 1000 }); // within TTL → served from cache, no new calls
  assert.equal(calls, before, "cached within TTL");

  const noPair = async () => ({ ok: true, json: async () => ({ pairs: [] }) });
  const m2 = await tokenMarket("0xabc0000000000000000000000000000000000000", "1h", { fetch: noPair, now: () => t });
  assert.equal(m2.hasMarket, false); assert.equal(m2.market, null); assert.ok(m2.note.includes("No indexed market"));
});
