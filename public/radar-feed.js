// Smart-money radar feed — the I/O half, browser-safe (fetch is injected, no Node APIs). The page and Node
// (radar-feed.mjs, tests) run this exact code: FREE native node for logs / getCode / tx senders, DexScreener
// (keyless) for price, mcap and liquidity. It talks to the native node directly, never through a configurable RPC
// URL, so nothing can route it to a metered provider.
import { TRANSFER, topicOf, decodeTransfers, unknownCounterparties, unverifiedBuys, classify, positions, walletKind, blockClock } from "./radar-core.js";

export const NATIVE = "https://rpc.mainnet.chain.robinhood.com";
const SPAN = 25000;                                    // node caps a log query at 30k blocks without an address filter

// smart-wallets.json (tools/build-smart-wallets.mjs) → the lookup sets the core needs
export function walletsFrom(d) {
  return { ...d, smart: new Set(d.wallets.map((w) => w.a)), meta: new Map(d.wallets.map((w) => [w.a, w])),
    venues: new Set(d.venues), quotes: new Set(d.quotes) };
}

//   cache: { kinds, senders } — both immutable facts (an address's code kind, a tx's sender), so callers may persist
//   them (the page keeps them in localStorage) and a reload skips every lookup already done.
//   onProgress({ phase, done, total }) fires while buys are being verified, so a caller can show partial results.
export function makeFeed(W, { fetch: f = fetch, rpcUrl = NATIVE, cache = {} } = {}) {
  let id = 0;
  const rpc = async (method, params) => {
    for (let i = 0; i < 4; i++) {
      const r = await f(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      if (r.status === 429) { await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); continue; }
      const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
    }
    throw new Error(method + ": rate-limited");
  };
  const topics = W.wallets.map((w) => topicOf(w.a));
  const kinds = cache.kinds || {}, senders = cache.senders || {}, transfers = [];
  let onProgress = null;
  // the node accepts JSON-RPC batches of ≤20 (larger ones are 429'd as a burst)
  const batch = async (calls) => {
    for (let i = 0; i < 4; i++) {
      const r = await f(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map(([method, params], k) => ({ jsonrpc: "2.0", id: k, method, params }))) });
      const j = await r.json().catch(() => null);
      if (Array.isArray(j)) return j.sort((a, b) => a.id - b.id).map((x) => x.result ?? null);
      await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
    }
    return calls.map(() => null);
  };
  let last = null, clock = null;

  async function calibrate(head) {
    const [a, b] = await Promise.all([rpc("eth_getBlockByNumber", ["0x" + (head - 20000).toString(16), false]), rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false])]);
    clock = blockClock(head - 20000, parseInt(a.timestamp, 16), head, parseInt(b.timestamp, 16));
  }
  // pull every smart-wallet transfer (in + out) in [from, to], ≤2 calls per 25k blocks
  async function pull(from, to) {
    for (let s = from; s <= to; s += SPAN) {
      const e = Math.min(to, s + SPAN - 1), range = { fromBlock: "0x" + s.toString(16), toBlock: "0x" + e.toString(16) };
      const [inn, out] = await Promise.all([rpc("eth_getLogs", [{ ...range, topics: [TRANSFER, null, topics] }]), rpc("eth_getLogs", [{ ...range, topics: [TRANSFER, topics] }])]);
      transfers.push(...decodeTransfers([...inn, ...out]));
    }
    const cps = unknownCounterparties(transfers, { ...W, kinds });
    for (let i = 0; i < cps.length; i += 20) {
      const codes = await batch(cps.slice(i, i + 20).map((a) => ["eth_getCode", [a, "latest"]]));
      cps.slice(i, i + 20).forEach((a, k) => { if (codes[k] != null) kinds[a] = walletKind(codes[k]); });
    }
    const txs = unverifiedBuys(transfers, { ...W, kinds, senders });
    for (let i = 0; i < txs.length; i += 20) {
      const got = await batch(txs.slice(i, i + 20).map((h) => ["eth_getTransactionByHash", [h]]));
      txs.slice(i, i + 20).forEach((h, k) => { const t = got[k]; if (t) senders[h] = { from: String(t.from).toLowerCase(), to: String(t.to || "").toLowerCase() }; });
      onProgress?.({ phase: "verify", done: Math.min(i + 20, txs.length), total: txs.length });
      await new Promise((s) => setTimeout(s, 400));
    }
  }
  return {
    rpc, kinds, senders,
    // advance to the chain head; the first call backfills `hours`
    // current rows from whatever is verified so far (for progressive rendering during a long first pull)
    snapshot(sinceBlock = 0) { return positions(classify(transfers, { ...W, kinds, senders }), W.meta, { sinceBlock }); },
    async tick(hours = 6, { progress = null } = {}) {
      onProgress = progress;
      const head = parseInt(await rpc("eth_blockNumber", []), 16);
      if (!clock || head % 50000 < 500) await calibrate(head);
      const secPerBlock = (clock(head) - clock(head - 10000)) / 10000;
      const from = last == null ? Math.max(0, head - Math.ceil((hours * 3600) / secPerBlock)) : last + 1;
      if (from <= head) await pull(from, head);
      last = head;
      const keepFrom = head - Math.ceil((hours * 3600) / secPerBlock);
      for (let i = transfers.length - 1; i >= 0; i--) if (transfers[i].block < keepFrom) transfers.splice(i, 1);
      const moves = classify(transfers, { ...W, kinds, senders });
      return { head, at: clock, moves, rows: positions(moves, W.meta, { sinceBlock: keepFrom }) };
    },
  };
}

// DexScreener: deepest pair per token, ≤30 addresses a call. Soft-fails to {} (the radar still works without prices).
export async function marketFor(addrs, { fetch: f = fetch } = {}) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 30) {
    try {
      const r = await f(`https://api.dexscreener.com/tokens/v1/robinhood/${addrs.slice(i, i + 30).join(",")}`);
      if (!r.ok) continue;
      for (const p of await r.json()) {
        const a = p.baseToken?.address?.toLowerCase(); if (!a) continue;
        if (!out[a] || (p.liquidity?.usd || 0) > (out[a].liquidityUsd || 0)) out[a] = { sym: p.baseToken.symbol, name: p.baseToken.name, priceUsd: +p.priceUsd || null,
          mcapUsd: p.marketCap || p.fdv || null, liquidityUsd: p.liquidity?.usd ?? null, pairCreatedAt: p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null,
          change24: p.priceChange?.h24 ?? null, url: p.url, logo: p.info?.imageUrl || null };
      }
    } catch { /* soft */ }
  }
  return out;
}
