// All research/replay/live setup decisions call this exact causal function. Every timestamp is milliseconds.
export const FEATURE_VERSION = "forward-features-v2";
const MIN = 60000;
const ratio = (a, b) => a != null && b > 0 ? a / b - 1 : null;
export function featuresAt(history, at) {
  const rows = history.filter((o) => o.observedAt <= at && o.observedAt >= at - 24 * 60 * MIN)
    .slice().sort((a, b) => a.observedAt - b.observedAt);
  const last = rows.at(-1);
  if (!last) return { version: FEATURE_VERSION, at, ready: false, reasons: ["no observations"] };
  const priced = rows.filter((o) => o.priceUsd > 0);
  const past = priced.filter((o) => o.observedAt <= at - 15 * MIN);
  const ref = past.at(-1);
  const peak = past.length ? Math.max(...past.map((o) => o.priceUsd)) : null;
  const recent = priced.filter((o) => o.observedAt > (ref?.observedAt ?? at));
  const trough = recent.length ? Math.min(...recent.map((o) => o.priceUsd)) : null;
  // Require distinct forensic samples; repeating the board's cached read is not new holder growth.
  const holderRows = rows.filter((o) => o.holders != null && o.forensicAt != null && o.observedAt <= at - 15 * MIN);
  const hr = holderRows.at(-1);
  const reasons = [];
  const stage = last.graduated === true ? "post-graduation" : last.graduated === false ? "pre-graduation" : "unknown";
  if (stage !== "post-graduation") reasons.push("research only: pre-graduation liquidity and sell execution are not validated");
  if (!(last.priceUsd > 0)) reasons.push("current price unavailable");
  if (at - last.observedAt > 5 * MIN) reasons.push("latest observation is stale");
  if (priced.length < 6 || !ref || at - ref.observedAt > 30 * MIN || at - priced[0].observedAt < 30 * MIN) reasons.push("need at least 30 minutes of forward price observations");
  if (!hr || hr.forensicAt === last.forensicAt || at - hr.observedAt > 30 * MIN || last.holders == null || last.risk == null || last.insiderSellers == null) reasons.push("need fresh comparable forensic observations");
  if (last.forensicAt == null || at - last.forensicAt > 10 * MIN) reasons.push("forensic sample is stale");
  if (last.marketAt == null || at - last.marketAt > 5 * MIN) reasons.push("liquidity sample is stale");
  if (!(last.liquidityUsd > 0)) reasons.push("liquidity is unknown");
  const maxGapMs = rows.length > 1 ? Math.max(...rows.slice(1).map((o, i) => o.observedAt - rows[i].observedAt)) : 0;
  if (maxGapMs > 15 * MIN) reasons.push("observation coverage has a gap over 15 minutes");
  return { version: FEATURE_VERSION, at, observationId: last.id, ready: reasons.length === 0, reasons,
    stage, historyReady: priced.length >= 6 && !!ref && at - ref.observedAt <= 30 * MIN && at - priced[0].observedAt >= 30 * MIN && maxGapMs <= 15 * MIN,
    priceUsd: last.priceUsd, liquidityUsd: last.liquidityUsd, risk: last.risk, insiderSellers: last.insiderSellers,
    holderGrowth: hr && last.forensicAt !== hr.forensicAt ? ratio(last.holders, hr.holders) : null,
    momentum15m: ref ? ratio(last.priceUsd, ref.priceUsd) : null,
    pullback: peak && trough ? 1 - trough / peak : null,
    recovery: trough ? ratio(last.priceUsd, trough) : null,
    observations: rows.length, spanMs: at - rows[0].observedAt, maxGapMs,
    independence: "unverified", execution: "unverified", reflex: "not connected" };
}
