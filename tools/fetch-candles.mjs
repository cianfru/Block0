#!/usr/bin/env node
// Market-sourced hourly candles for every profiled token's first 16 days — the outcome data the study was missing.
//
// Why: profiles were snapshotted a median 6.6 days after launch, so any 7-day forward outcome was censored, and the
// swap-implied price reconstruction is not trustworthy at the wallet level. GeckoTerminal indexes Robinhood Chain
// pools from launch; this pulls ONE hourly OHLCV page per token (launch → +16d) plus one pool lookup per 30 tokens.
// Keyless, free, adaptively paced (backs off on 429). Cached under data/candles/ (gitignored) — never re-fetched.
//
//   node tools/fetch-candles.mjs            → data/candles/<addr>.json = { pool, supply, c: [[t, open, high, close], …] }
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles } from "./cohort-lib.mjs";

const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const OUT = join("data", "candles"), SPAN_H = 16 * 24;
let gap = 3000;                                   // adaptive: widens on 429, narrows slowly on success
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 6; i++) {
    await sleep(gap);
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status === 429) { gap = Math.min(gap * 1.5, 20000); console.log(`  429 → gap ${Math.round(gap)}ms`); await sleep(20000); continue; }
    gap = Math.max(2000, gap * 0.97);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error("rate-limited: " + url);
}

const todo = loadProfiles().filter((p) => !existsSync(join(OUT, p.addr + ".json")));
console.log(`${todo.length} tokens without candles`);
let ok = 0, none = 0;
for (let i = 0; i < todo.length; i += 30) {
  const batch = todo.slice(i, i + 30);
  const multi = await get(`${GT}/tokens/multi/${batch.map((p) => p.addr).join(",")}?include=top_pools`);
  const pools = new Map((multi?.data || []).map((d) => [d.attributes.address.toLowerCase(), d.relationships?.top_pools?.data?.[0]?.id?.replace(/^robinhood_/, "")]));
  for (const p of batch) {
    const pool = pools.get(p.addr);
    let c = [];
    if (pool) {
      const before = Math.floor(p.t0 / 3600) * 3600 + SPAN_H * 3600;
      const r = await get(`${GT}/pools/${pool}/ohlcv/hour?aggregate=1&limit=${SPAN_H + 2}&before_timestamp=${before}&currency=usd&token=${p.addr}`);
      c = (r?.data?.attributes?.ohlcv_list || []).map(([t, o, h, , cl]) => [t, o, h, cl]).sort((a, b) => a[0] - b[0]);
    }
    writeFileSync(join(OUT, p.addr + ".json"), JSON.stringify({ pool: pool || null, supply: p.supply || 1e9, c }));
    c.length ? ok++ : none++;
  }
  console.log(`  ${Math.min(i + 30, todo.length)}/${todo.length} · with candles ${ok} · none ${none}`);
}
console.log("done");
