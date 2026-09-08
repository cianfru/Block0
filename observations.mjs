// Forward observations only. No backtest imports, interpolation, retrospective anchoring or missing-to-zero defaults.
export const OBSERVATION_VERSION = "forward-observation-v1";
export const addressOf = (a) => /^0x[0-9a-f]{40}$/i.test(a || "") ? a.toLowerCase() : null;
export const finite = (x) => x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null;
const positive = (x) => finite(x) > 0 ? Number(x) : null;

export function observation(meta, { now, forensic = null, market = null, maxForensicAgeMs = 10 * 60000 } = {}) {
  const address = addressOf(meta.address);
  if (!address || !Number.isFinite(now)) throw new Error("invalid observation identity/time");
  const forensicAt = finite(forensic?.observedAt);
  const fresh = forensicAt != null && forensicAt <= now && now - forensicAt <= maxForensicAgeMs;
  const flags = fresh ? forensic.flags || {} : {};
  const marketAt = finite(market?.observedAt);
  const marketFresh = marketAt != null && marketAt <= now && now - marketAt <= 5 * 60000;
  const launchedAt = meta.launchedAt ? Date.parse(meta.launchedAt) : NaN;
  const lastEvent = meta.latestBuyAt ? Date.parse(meta.latestBuyAt) : NaN;
  const price = positive(meta.priceUsd);
  return {
    version: OBSERVATION_VERSION, id: `${address}:${now}`, address, observedAt: now,
    catalogReceivedAt: finite(meta.availableAt) ?? now,
    // A source event timestamp is not a timestamp for the quote or the whole snapshot.
    eventAt: Number.isFinite(lastEvent) && lastEvent <= now ? lastEvent : null,
    launchedAt: Number.isFinite(launchedAt) && launchedAt <= now ? launchedAt : null,
    venue: "pons", graduated: !!meta.graduated, priceUsd: price, mcapUsd: positive(meta.mcapUsd),
    priceSource: "pons-catalog", priceAsOf: null, executable: false,
    forensicAt: fresh ? forensicAt : null, holders: finite(flags.holders), risk: fresh ? finite(forensic.risk) : null,
    top10Pct: finite(flags.top10Pct), insiderSellers: finite(flags.insiderSellersNow),
    liquidityUsd: marketFresh ? positive(market.liqUsd) : null,
    marketAt: marketFresh ? marketAt : null, marketSource: marketFresh ? "dexscreener" : null,
    quality: [!price && "price unavailable", !fresh && "forensics unavailable or stale",
      !marketFresh && "liquidity unavailable or stale", "indicative catalog price; execution unverified"].filter(Boolean),
  };
}

export function appendObservation(history, next, { cap = 2048 } = {}) {
  const last = history.at(-1);
  if (last && (next.address !== last.address || next.observedAt < last.observedAt)) throw new Error("observation order/identity mismatch");
  if (last?.observedAt === next.observedAt) return history; // retry idempotence
  return [...history, structuredClone(next)].slice(-cap);
}
