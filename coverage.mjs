// COVERAGE MONITOR — the proof that discovery misses nothing, and the alarm if that ever changes.
//
// Discovery is chain-wide by creation signature (v2 PairCreated · v3 PoolCreated · v4 Initialize), so every factory/
// AMM is caught automatically — no address allowlist to fall behind. This module makes that VISIBLE and AUDITABLE:
// it censuses every factory currently producing tokens, and remembers the set we've ever seen so a BRAND-NEW factory
// (a fresh DEX or launchpad deploying its first pools) surfaces as "new" instead of slipping in unnoticed. The point
// isn't to gate discovery (signature matching already covers it) — it's so a human can SEE the whole launch surface
// and confirm, at a glance, that nothing is unaccounted for.
import { discoverDex } from "./dex.mjs";
import { getJSON, setJSON } from "./store/kv.mjs";

let _cache = null, _at = 0;
const TTL = Number(process.env.COVERAGE_TTL_MS || 10 * 60 * 1000);
const DAY = 86400000;

// Census every factory over a window, tag which are newly-seen (persisted across runs when a KV store is connected).
export async function coverageReport({ blocks = 250000, force = false } = {}) {
  if (!force && _cache && Date.now() - _at < TTL) return _cache;
  const disc = await discoverDex({ blocks });
  const now = Date.now();
  const byFactory = new Map();
  for (const t of disc.tokens || []) {
    const f = (t.factory || "").toLowerCase(); if (!f) continue;
    const e = byFactory.get(f) || byFactory.set(f, { addr: f, venue: t.dex || "?", tokens: 0, newestBlock: 0 }).get(f);
    e.tokens++; if (t.block > e.newestBlock) e.newestBlock = t.block;
  }
  // persisted "ever seen" ledger → detect brand-new factories (best-effort; needs a KV store to survive restarts)
  let seen = {};
  try { seen = (await getJSON("coverage-seen")) || {}; } catch { /* no store — degrade to no history */ }
  let added = false;
  const factories = [...byFactory.values()].map((e) => {
    const first = seen[e.addr];
    if (!first) { seen[e.addr] = now; added = true; }
    return { ...e, firstSeen: first || now, isNew: !first || (now - first < DAY) };
  }).sort((a, b) => b.tokens - a.tokens);
  if (added) setJSON("coverage-seen", seen).catch(() => {});

  const byVenue = {};
  for (const f of factories) byVenue[f.venue] = (byVenue[f.venue] || 0) + f.tokens;
  _cache = {
    updated: now, window: blocks, latestBlock: disc.latestBlock,
    discovery: "chain-wide by creation signature (v2 PairCreated · v3 PoolCreated · v4 Initialize) — no address allowlist",
    factories: factories.length, tokens: (disc.tokens || []).length, byVenue,
    newFactories: factories.filter((f) => f.isNew).length,
    list: factories,
  };
  _at = now;
  return _cache;
}
