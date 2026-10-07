// Pons launchpad data source — the source of truth for the Robinhood-Chain launch universe.
// ⚠ PONS v2 (2026-10-07): the site moved to ponsfamily.com and the old /api/pons-launches endpoints now 404 (the agent
// and the radar both lost Pons for it). The new public API is GET /api/launches — 40 launches a page, newest first,
// paged with `cursor=<nextCursor>`, filterable by `stage=curve|graduated`, `sort=marketCap` (one page, the top 40); and
// GET /api/launches/pinned?addresses=… for specific tokens. Items carry USD market cap and price (also for launches
// still on the curve), deployer, createdAt (unix s), stage, curve/pool/poolId. Pons now gets ~1,600 launches a day, so
// "active" = the newest few pages (~5 h) + the 40 largest on the curve, not every launch of the week.
const BASE = "https://ponsfamily.com";
const HDR = { "user-agent": "Mozilla/5.0 (compatible; Block0/1.0) curl/8.5.0", "referer": BASE + "/launchpad", "accept": "application/json" };

// ipfs://<cid> → a public gateway (the v2 site has no same-origin ipfs route)
export const logoUrl = (logo) => !logo ? null : logo.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + logo.slice(7) : logo;

// a v2 /api/launches item → the shape every caller already reads
export function norm(t) {
  const n = (x) => (x == null || x === "" ? null : Number(x));
  return {
    address: String(t.address || t.token || "").toLowerCase(), sym: t.symbol || "?", name: t.name || "",
    logo: logoUrl(t.artwork || t.logo), mcapUsd: n(t.marketCapUsd) ?? 0, priceUsd: n(t.priceUsd) ?? 0,
    pool: String(t.pool || t.curve || "").toLowerCase(), curve: String(t.curve || "").toLowerCase(), poolId: t.poolId || null,
    pairToken: String(t.quote?.address || t.pairToken || "").toLowerCase(), quoteSymbol: t.quote?.symbol || null,
    deployer: String(t.deployer || "").toLowerCase(),
    launchedAt: t.createdAt ? new Date(Number(t.createdAt) * 1000).toISOString() : t.launchedAt || null,
    latestBuyAt: t.lastTradeAt ? new Date(Number(t.lastTradeAt) * 1000).toISOString() : null,
    graduated: t.stage ? t.stage === "graduated" : !!t.graduated,
    graduatedAt: t.graduatedAt ? new Date(Number(t.graduatedAt) * 1000).toISOString() : null,
    progress: t.progress == null ? null : Math.round(Number(t.progress) * 100),
    holdersHint: null, tradeCount: n(t.tradeCount), volumeUsd: n(t.volumeUsd),
    factory: String(t.factory || "").toLowerCase(), version: t.protocol || t.version || null,
  };
}

async function j(url, fetchImpl = fetch) { const r = await fetchImpl(url, { headers: HDR, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error("pons " + r.status); return r.json(); }

// one page of /api/launches → { items (normalised), nextCursor }
export async function launchesPage(params = {}, { fetch: fetchImpl = fetch } = {}) {
  const d = await j(`${BASE}/api/launches?${new URLSearchParams(params)}`, fetchImpl);
  if (!Array.isArray(d?.items)) throw new Error("pons launches schema changed" + (d?.error ? `: ${d.error}` : ""));
  return { items: d.items.map(norm), nextCursor: d.nextCursor || null };
}
// newest-first pages of one stage until `pages` are read or a launch older than `sinceSec`
async function pagesOf(stage, { pages, sinceSec = 0, fetch: fetchImpl }) {
  const out = []; let cursor = null;
  for (let k = 0; k < pages; k++) {
    const p = await launchesPage({ stage, ...(cursor ? { cursor } : {}) }, { fetch: fetchImpl });
    out.push(...p.items);
    if (!p.nextCursor || !p.items.length || Date.parse(p.items.at(-1).launchedAt) / 1000 < sinceSec) break;
    cursor = p.nextCursor;
  }
  return out;
}
const AGE_S = { "24h": 86400, "7d": 7 * 86400, all: 0 };

// active (pre-graduation) universe: the newest pages (`pageSize` launches, 40 a page) + the 40 largest on the curve.
// sort "marketCap" orders the result by market cap; anything else keeps newest first.
export async function fetchActive({ sort = "marketCap", age = "all", pageSize = 120, fetch: fetchImpl = fetch } = {}) {
  const since = AGE_S[age] ? Date.now() / 1000 - AGE_S[age] : 0;
  const [fresh, top] = await Promise.all([
    pagesOf("curve", { pages: Math.max(1, Math.ceil(pageSize / 40)), sinceSec: since, fetch: fetchImpl }),
    launchesPage({ stage: "curve", sort: "marketCap" }, { fetch: fetchImpl }).then((p) => p.items),
  ]);
  const byAddr = new Map(); for (const t of [...fresh, ...top]) if (t.address && (!since || Date.parse(t.launchedAt) / 1000 >= since)) byAddr.set(t.address, t);
  const items = [...byAddr.values()];
  if (sort === "marketCap") items.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0));
  return { items, total: items.length, launchTotal: null, observedAt: Date.now() };
}

// graduated universe, newest graduations first (default: the last 30 days, at most 15 pages = 600)
export async function fetchGraduated({ days = 30, pages = 15, fetch: fetchImpl = fetch } = {}) {
  const items = await pagesOf("graduated", { pages, sinceSec: Date.now() / 1000 - days * 86400, fetch: fetchImpl });
  return { items, total: items.length, observedAt: Date.now() };
}

// specific launches by address (≤40 per call)
export async function fetchLaunches(addresses, { fetch: fetchImpl = fetch } = {}) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 40) {
    const d = await j(`${BASE}/api/launches/pinned?addresses=${addresses.slice(i, i + 40).join(",")}`, fetchImpl);
    if (!Array.isArray(d?.items)) throw new Error("pons pinned schema changed");
    out.push(...d.items.map(norm));
  }
  return out;
}

// ⚠ v1 endpoint, gone since Pons v2 (2026-10-07); only the parked forward experiment used it.
// The launchpad's own batched quote refresh. Token identity is checked against the request;
// missing entries remain missing, never filled with an old catalog price.
export async function fetchLiveMarkets(tokens, { fetch: fetchImpl = fetch } = {}) {
  if (!tokens.length) return { items: [], observedAt: Date.now() };
  const requested = new Map(tokens.map(t => [t.address.toLowerCase(), t]));
  const params = new URLSearchParams();
  for (const t of tokens) params.append("market", `${t.address.toLowerCase()},${t.pool || "0x" + "0".repeat(40)}`);
  const d = await j(`${BASE}/api/pons-launches/live-markets?${params}`, fetchImpl);
  if (!Array.isArray(d)) throw new Error("pons live market schema changed");
  const observedAt = Date.now();
  return { observedAt, items: d.filter(t => requested.has(String(t.token).toLowerCase())).map(t => {
    const old = requested.get(t.token.toLowerCase());
    return { ...old, address: old.address, priceUsd: t.priceUsd ?? null, mcapUsd: t.marketCapUsd ?? null,
      graduated: t.graduated ?? old.graduated, pool: t.pool?.toLowerCase() || old.pool,
      pairedPrincipalEth: t.pairedPrincipalEth ?? null, graduationThresholdEth: t.graduationThresholdEth ?? null,
      latestBuyAt: t.latestBuyAt || null, availableAt: observedAt, priceSource: "pons-live-markets" };
  }) };
}
