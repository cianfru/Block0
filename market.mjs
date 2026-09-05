// LIVE MARKET DATA — the one place price/liquidity/volume come from a market source, kept strictly SEPARATE from the
// forensic engine (which is 100% our own on-chain reconstruction). Price is price: we source real OHLC candles +
// liquidity/volume, render them OURSELVES in the Block0 palette, and always label them "via <source>". This never
// touches a verdict — it's context, drawn next to the analysis, not part of it.
//
// Sources (both keyless, free, no CORS from the browser is needed because we proxy server-side + cache):
//   • DexScreener  /latest/dex/tokens/<addr>  → the best pair (pool address) + liquidity/volume/txns/priceChange snapshot
//   • GeckoTerminal /networks/robinhood/pools/<pool>/ohlcv/<tf> → real [t,o,h,l,c,v] candles for that pool
// Both index the Robinhood Chain (verified). Newer/thin tokens may be absent → we degrade to "no market yet", never fake.
//
// The pure helpers (pickPair, normalizeOhlc, marketSnapshot) are unit-tested; the network functions take an injectable
// fetch so tests never hit the wire.

const GT_NET = process.env.GECKOTERMINAL_NETWORK || "robinhood";
const DS_BASE = "https://api.dexscreener.com/latest/dex";
const GT_BASE = "https://api.geckoterminal.com/api/v2";
const UA = { "user-agent": "Block0/1.0 (+https://block0.app)", "accept": "application/json" };
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

// Choose the pair to chart: the deepest-liquidity pool for THIS token as the base asset (never a pool where it's the
// quote — that inverts the price). Ties broken by 24h volume. Returns null when the token has no indexed pair yet.
export function pickPair(pairs, address) {
  const a = (address || "").toLowerCase();
  const mine = (pairs || []).filter((p) => p && p.pairAddress && (p.baseToken?.address || "").toLowerCase() === a);
  if (!mine.length) return null;
  mine.sort((x, y) => (num(y.liquidity?.usd) || 0) - (num(x.liquidity?.usd) || 0) || (num(y.volume?.h24) || 0) - (num(x.volume?.h24) || 0));
  return mine[0];
}

// The compact market snapshot the UI shows above the chart — only fields we actually got, all numeric or null.
export function marketSnapshot(pair) {
  if (!pair) return null;
  const t = pair.txns?.h24 || {};
  return {
    pair: (pair.pairAddress || "").toLowerCase(),
    dex: pair.dexId || null, url: pair.url || null, labels: pair.labels || [],
    priceUsd: num(pair.priceUsd), fdv: num(pair.fdv), mcap: num(pair.marketCap),
    liqUsd: num(pair.liquidity?.usd),
    vol24: num(pair.volume?.h24), vol6: num(pair.volume?.h6), vol1: num(pair.volume?.h1),
    change24: num(pair.priceChange?.h24), change6: num(pair.priceChange?.h6), change1: num(pair.priceChange?.h1),
    buys24: num(t.buys), sells24: num(t.sells),
    pairCreatedAt: num(pair.pairCreatedAt),
  };
}

// GeckoTerminal returns { data:{ attributes:{ ohlcv_list:[[ts,o,h,l,c,v], …] } } }, NEWEST first. Normalize to
// oldest→newest {t,o,h,l,c,v}, drop malformed rows, cap the count.
export function normalizeOhlc(json, cap = 300) {
  const rows = json?.data?.attributes?.ohlcv_list || [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const [ts, o, h, l, c, v] = r;
    if (!(ts > 0) || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
    out.push({ t: Math.round(ts), o: +o, h: +h, l: +l, c: +c, v: num(v) || 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-cap);
}

// GeckoTerminal timeframe/aggregate for a requested bucket. Their API path is /ohlcv/<timeframe>?aggregate=<n>.
const TF = { "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };

async function jget(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: UA });
  if (!r.ok) throw Object.assign(new Error("http " + r.status), { status: r.status });
  return r.json();
}

// Resolve the pair for a token (DexScreener) — cached briefly upstream by the caller.
export async function fetchPair(address, { fetch: fetchImpl = fetch } = {}) {
  const j = await jget(`${DS_BASE}/tokens/${address}`, fetchImpl).catch(() => null);
  return pickPair(j?.pairs, address);
}

// Real candles for a pool (GeckoTerminal). tf ∈ TF keys. Returns [] when the pool isn't indexed there yet.
export async function fetchCandles(pool, tf = "1h", { fetch: fetchImpl = fetch, limit = 200 } = {}) {
  const [timeframe, aggregate] = TF[tf] || TF["1h"];
  const url = `${GT_BASE}/networks/${GT_NET}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`;
  const j = await jget(url, fetchImpl).catch(() => null);
  return normalizeOhlc(j, limit);
}

// The full chart payload for /api/chart, TTL-cached so a busy token page (and any card enrichment) never hammers the
// free endpoints. One DexScreener + one GeckoTerminal call per token per TTL; both soft-fail to a partial result.
const _cache = new Map(); // key `${address}:${tf}` → { at, data }
const TTL_MS = Number(process.env.MARKET_TTL_MS || 150000);

export async function tokenMarket(address, tf = "1h", { fetch: fetchImpl = fetch, now = Date.now } = {}) {
  address = (address || "").toLowerCase();
  const key = `${address}:${tf}`;
  const hit = _cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.data;
  const pair = await fetchPair(address, { fetch: fetchImpl }).catch(() => null);
  const snap = marketSnapshot(pair);
  let candles = [];
  if (snap?.pair) candles = await fetchCandles(snap.pair, tf, { fetch: fetchImpl }).catch(() => []);
  const data = {
    address, tf, source: "geckoterminal", priceSource: "dexscreener",
    hasMarket: !!(snap && candles.length),
    market: snap, candles, updated: now(),
    note: snap ? null : "No indexed market for this token yet — it may be too new or too thin to have a price feed.",
  };
  _cache.set(key, { at: now(), data });
  return data;
}
