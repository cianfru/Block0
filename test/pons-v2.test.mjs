// pons.mjs against the Pons v2 API (/api/launches, 2026-10-07): normalisation, cursor paging, the active/graduated split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, fetchActive, fetchGraduated, fetchSlice } from "../pons.mjs";

const item = (i, o = {}) => ({ address: "0x" + String(i).padStart(40, "A"), symbol: "T" + i, name: "n", stage: "curve", createdAt: 1791370000 - i * 600,
  marketCapUsd: 4000 + i, priceUsd: 0.000004, deployer: "0xDEAD", curve: "0xC" + "0".repeat(39), pool: null, progress: 0.25, protocol: "v2", artwork: "ipfs://cid", ...o });

test("norm maps a v2 item onto the fields every caller reads", () => {
  const t = norm(item(1, { stage: "graduated", graduatedAt: 1791371000, quote: { address: "0xQ", symbol: "NVDA" } }));
  assert.equal(t.address, "0x" + "0".repeat(0) + String(1).padStart(40, "a"));
  assert.deepEqual([t.sym, t.graduated, t.progress, t.deployer, t.pool, t.quoteSymbol, t.logo], ["T1", true, 25, "0xdead", "0xc" + "0".repeat(39), "NVDA", "https://ipfs.io/ipfs/cid"]);
  assert.equal(t.launchedAt, new Date((1791370000 - 600) * 1000).toISOString());
});

test("fetchActive pages newest-first by cursor, adds the top 40 by market cap, and stops at the age window", async () => {
  const urls = [], now = Date.now() / 1000;
  const fetch = async (u) => { urls.push(u); const q = new URL(u).searchParams;
    const page = q.get("sort") === "marketCap" ? [item(900, { marketCapUsd: 90000, createdAt: now - 3600 })]
      : q.get("cursor") ? [item(3, { createdAt: now - 7200 }), item(4, { createdAt: now - 9 * 86400 })] : [item(1, { createdAt: now - 60 }), item(2, { createdAt: now - 120 })];
    return { ok: true, json: async () => ({ items: page, nextCursor: q.get("cursor") ? "c2" : "c1" }) }; };
  const r = await fetchActive({ sort: "marketCap", age: "7d", pageSize: 200, fetch });
  assert.equal(r.items[0].sym, "T900");                       // sorted by market cap
  assert.deepEqual(r.items.map((t) => t.sym).sort(), ["T1", "T2", "T3", "T900"]);   // T4 is 9 days old: outside 7d
  assert.ok(urls.filter((u) => !u.includes("marketCap")).length <= 2);              // stopped once a page reached past the window
});

test("fetchGraduated reads stage=graduated and a schema change fails loudly", async () => {
  const fetch = async (u) => ({ ok: true, json: async () => (new URL(u).searchParams.get("stage") === "graduated" ? { items: [item(5, { stage: "graduated" })], nextCursor: null } : {}) });
  const g = await fetchGraduated({ fetch });
  assert.equal(g.items[0].graduated, true);
  await assert.rejects(() => fetchActive({ fetch: async () => ({ ok: true, json: async () => ({ error: "The board is briefly unavailable." }) }) }), /schema changed: The board/);
});

test("the newest feed asks for sort=newest explicitly, and a stale 'newest' page fails loudly", async () => {
  const urls = [], now = Date.now() / 1000;
  const ok = async (u) => { urls.push(u); const q = new URL(u).searchParams;
    return { ok: true, json: async () => ({ items: q.get("sort") === "marketCap" ? [] : [item(1, { createdAt: now - 60 })], nextCursor: null }) }; };
  await fetchActive({ age: "7d", fetch: ok });
  assert.ok(urls.some((u) => /stage=curve&sort=newest/.test(u)));
  // Pons switched its default order on 2026-10-08: a "newest" page full of month-old launches must not pass as fresh
  const stale = async (u) => ({ ok: true, json: async () => ({ items: [item(2, { createdAt: now - 20 * 86400 })], nextCursor: null }) });
  await assert.rejects(() => fetchActive({ age: "all", fetch: stale }), /feed is stale/);
});

test("fetchSlice starts at a synthetic time cursor and keeps only launches inside [from, to)", async () => {
  const urls = [], to = 1791500000, from = to - 8 * 3600;
  const fetch = async (u) => { urls.push(u); const c = new URL(u).searchParams.get("cursor");
    const page = c.startsWith(String(to)) ? [item(1, { createdAt: to - 60 }), item(2, { createdAt: to - 4 * 3600 })] : [item(3, { createdAt: from + 10 }), item(4, { createdAt: from - 10 })];
    return { ok: true, json: async () => ({ items: page, nextCursor: "next" }) }; };
  const r = await fetchSlice({ fromSec: from, toSec: to, fetch });
  assert.deepEqual(r.map((t) => t.sym), ["T1", "T2", "T3"]);                          // T4 is older than the slice
  assert.equal(new URL(urls[0]).searchParams.get("cursor"), `${to}.0x${"f".repeat(40)}`);
  assert.equal(urls.length, 2);                                                        // stopped past the slice
  assert.ok(urls.every((u) => /stage=curve&sort=newest/.test(u)));
});
