// Per-token transfer STORE with incremental delta pulls — the RPC-cost lever.
//
// The naive board re-pulled every token's FULL transfer history and binary-searched its deploy block on every
// 3-minute refresh: ~23 eth_getCode calls (findDeployBlock) + N pages of getAssetTransfers, per token, per cycle
// → thousands of RPC calls a cycle, ~all of it re-fetching data that hasn't changed. That is what tripped the
// Alchemy rate limit.
//
// This store keeps each token's transfers in memory and, on each cycle, pulls ONLY the delta since the last
// block it saw. A quiet token costs a single (usually empty) delta pull; a busy one costs one small pull. The
// deploy block is resolved ONCE and cached forever (it is immutable) — and on Alchemy it's free: getAssetTransfers
// pages by COUNT not block-range, so starting from block 0 costs the same as starting from deploy, so we skip
// findDeployBlock entirely. Result: ~30–100× fewer RPC calls, provider-agnostic.
import { latestBlock, findDeployBlock, PROVIDER } from "./rpc.mjs";
import { pullTransfers, detectPool } from "./engine.mjs";

const S = new Map(); // addr -> { ev, lastBlock, deployBlock, pool, newN }

// Shared latest-block cache: one eth_blockNumber per ~cycle instead of one per token.
let _lb = { v: 0, at: 0 };
export async function sharedLatest(maxAgeMs = 8000) {
  if (_lb.v && Date.now() - _lb.at < maxAgeMs) return _lb.v;
  _lb.v = await latestBlock(); _lb.at = Date.now();
  return _lb.v;
}

// Return the token's full transfer history, pulling only what's new since last call.
// opts.pool (from Pons) seeds the market so we never guess it; opts.decimals defaults to 18.
// → { ev, pool, deployBlock, latest, fresh, newN }  (fresh = there were new transfers this call)
export async function getTransfers(addr, decimals = 18, opts = {}) {
  addr = addr.toLowerCase();
  const latest = await sharedLatest();
  let s = S.get(addr);

  if (!s) {
    // Alchemy pages by count → block 0 is as cheap as the deploy block, so skip the binary search entirely.
    const deployBlock = PROVIDER === "alchemy" ? 0 : await findDeployBlock(addr, latest);
    const ev = await pullTransfers(addr, deployBlock, latest, decimals);
    s = { ev, lastBlock: latest, deployBlock, pool: ((opts.pool || "").toLowerCase() || detectPool(ev) || ""), newN: ev.length };
    S.set(addr, s);
    return { ev: s.ev, pool: s.pool, deployBlock, latest, fresh: true, newN: ev.length };
  }

  if (opts.pool && !s.pool) s.pool = opts.pool.toLowerCase();
  if (latest > s.lastBlock) {
    const delta = await pullTransfers(addr, s.lastBlock + 1, latest, decimals);
    if (delta.length) s.ev = s.ev.concat(delta); // [deploy..lastBlock] + [lastBlock+1..latest], no overlap
    s.lastBlock = latest; s.newN = delta.length;
    return { ev: s.ev, pool: s.pool, deployBlock: s.deployBlock, latest, fresh: delta.length > 0, newN: delta.length };
  }
  s.newN = 0;
  return { ev: s.ev, pool: s.pool, deployBlock: s.deployBlock, latest, fresh: false, newN: 0 };
}

export function storeStats() {
  let transfers = 0; for (const s of S.values()) transfers += s.ev.length;
  return { tokens: S.size, transfers, provider: PROVIDER };
}
// Drop a token from the store (e.g. it fell off the board) so memory doesn't grow unbounded.
export function evict(addr) { S.delete((addr || "").toLowerCase()); }
export function keep(addrs) { const set = new Set(addrs.map((a) => (a || "").toLowerCase())); for (const a of [...S.keys()]) if (!set.has(a)) S.delete(a); }
