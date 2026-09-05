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
import { latestBlock, findDeployBlock, PROVIDER, rpc, hx, toNum } from "./rpc.mjs";
import { pullTransfers, detectPool } from "./engine.mjs";

const S = new Map(); // addr -> { ev, lastBlock, deployBlock, pool, newN }

// Shared latest-block cache: one eth_blockNumber per ~cycle instead of one per token.
let _lb = { v: 0, at: 0 };
export async function sharedLatest(maxAgeMs = 8000) {
  if (_lb.v && Date.now() - _lb.at < maxAgeMs) return _lb.v;
  _lb.v = await latestBlock(); _lb.at = Date.now();
  return _lb.v;
}

const parseTs = (v) => { // Pons launchedAt may be unix (s/ms) or ISO
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : v;
  const p = Date.parse(v); return Number.isNaN(p) ? null : Math.floor(p / 1000);
};

// One-time chain calibration: measured seconds-per-block from two block HEADERS (no archive state needed,
// unlike eth_getCode). Lets us convert a token's launch timestamp → an approximate block, so a generic-RPC
// first-boot pulls from launch instead of genesis (the RH chain is 52M+ blocks deep at sub-second block times).
let _cal = null;
async function calibrate(latest) {
  if (_cal) return _cal;
  const ts = async (n) => { const b = await rpc("eth_getBlockByNumber", [hx(n), false]); return b ? toNum(b.timestamp) : null; };
  const lo = Math.max(1, latest - 1_000_000);
  const [tHi, tLo] = await Promise.all([ts(latest), ts(lo)]);
  const spb = (tHi && tLo && latest > lo) ? (tHi - tLo) / (latest - lo) : 2;
  _cal = { headBlock: latest, headTs: tHi || Math.floor(Date.now() / 1000), spb: spb > 0 ? spb : 2 };
  return _cal;
}
export async function estimateBlockAt(tsSec, latest, marginBlocks = 10000) {
  const c = await calibrate(latest);
  const est = c.headBlock - Math.floor((c.headTs - tsSec) / c.spb);
  return Math.max(0, est - marginBlocks); // margin so we never start after the token's first transfer
}
// Chain calibration for INVERSE use (block → timestamp): the generic backtest pulls raw eth_getLogs, which on
// the native RH node carry no blockTimestamp, so we derive each transfer's time from its block linearly.
export async function chainCalibration(latest) { return calibrate(latest); }
export { parseTs };
// Logs from the native node carry no usable blockTimestamp (absent or "0x0"), so a generic-RPC pull arrives with
// ts=null. Derive each missing time from its block via the calibration, so the live 30-min windows (dumping now,
// momentum, recent flow) mean the same thing on every provider instead of silently treating all history as "now".
async function fillTimestamps(ev, latest) {
  if (!ev.some((e) => e.ts == null)) return ev;
  const c = await calibrate(latest);
  for (const e of ev) if (e.ts == null && e.block != null) e.ts = Math.round(c.headTs - (c.headBlock - e.block) * c.spb);
  return ev;
}

// Return the token's full transfer history, pulling only what's new since last call.
// opts.pool (from Pons) seeds the market so we never guess it; opts.decimals defaults to 18.
// → { ev, pool, deployBlock, latest, fresh, newN }  (fresh = there were new transfers this call)
export async function getTransfers(addr, decimals = 18, opts = {}) {
  addr = addr.toLowerCase();
  const latest = await sharedLatest();
  let s = S.get(addr);

  if (!s) {
    // Where to start the first full pull:
    //  • Alchemy pages by count → block 0 is as cheap as the deploy block (skip the binary search entirely).
    //  • generic RPC (eth_getLogs) → start from the token's LAUNCH: estimate the block from Pons launchedAt
    //    (header-only, no archive state), else fall back to the eth_getCode binary search.
    let deployBlock;
    if (PROVIDER === "alchemy") deployBlock = 0;
    else {
      const ts = parseTs(opts.launchedAt);
      deployBlock = ts != null ? await estimateBlockAt(ts, latest) : await findDeployBlock(addr, latest);
    }
    const ev = await fillTimestamps(await pullTransfers(addr, deployBlock, latest, decimals), latest);
    s = { ev, lastBlock: latest, deployBlock, pool: ((opts.pool || "").toLowerCase() || detectPool(ev) || ""), newN: ev.length };
    S.set(addr, s);
    return { ev: s.ev, pool: s.pool, deployBlock, latest, fresh: true, newN: ev.length };
  }

  if (opts.pool && !s.pool) s.pool = opts.pool.toLowerCase();
  if (latest > s.lastBlock) {
    const delta = await fillTimestamps(await pullTransfers(addr, s.lastBlock + 1, latest, decimals), latest);
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
