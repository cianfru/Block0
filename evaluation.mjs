// Observed future peaks are context only. Terminal return uses the first quote after a fixed delayed entry and horizon.
export function evaluateDecision(d, history, now) {
  const p = d.policy, entryAt = d.at + p.delayMs;
  const rows = history.filter((o) => o.observedAt > d.at && o.observedAt <= now).slice().sort((a, b) => a.observedAt - b.observedAt);
  const price = (o) => o.priceUsd > 0;
  const entry = rows.find((o) => o.observedAt >= entryAt && o.observedAt <= entryAt + p.toleranceMs && price(o));
  if (!entry) return now <= entryAt + p.toleranceMs ? { status: "pending" } : { status: "unknown", reason: "no entry observation within tolerance" };
  const exitAt = entry.observedAt + p.horizonMs;
  const exit = rows.find((o) => o.observedAt >= exitAt && o.observedAt <= exitAt + p.toleranceMs && price(o));
  if (!exit) return now <= exitAt + p.toleranceMs ? { status: "pending", entryAt: entry.observedAt } : { status: "unknown", reason: "no exit observation within tolerance" };
  const path = rows.filter((o) => o.observedAt >= entry.observedAt && o.observedAt <= exit.observedAt && price(o));
  const gap = path.slice(1).some((o, i) => o.observedAt - path[i].observedAt > p.maxGapMs);
  const grossReturn = exit.priceUsd / entry.priceUsd - 1, fee = p.feeBpsPerSide / 10000;
  return { status: "resolved", metric: p.metric, entryAt: entry.observedAt, exitAt: exit.observedAt,
    entryPrice: entry.priceUsd, exitPrice: exit.priceUsd, grossReturn,
    scenarioReturn: exit.priceUsd * (1 - fee) / (entry.priceUsd * (1 + fee)) - 1,
    adverseMove: gap ? null : Math.min(...path.map((o) => o.priceUsd / entry.priceUsd - 1)),
    opportunityPeak: gap ? null : Math.max(...path.map((o) => o.priceUsd / entry.priceUsd)),
    pathCoverage: gap ? "gaps; intraperiod metrics unavailable" : "sampled observations only",
    executable: false, impact: null, gas: null };
}
const median = (a) => { const s = a.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : null; };
export function summarize(decisions) {
  const strategies = [...new Set(decisions.map((d) => d.strategy))];
  return strategies.map((strategy) => {
    const all = decisions.filter((d) => d.strategy === strategy), resolved = all.filter((d) => d.outcome?.status === "resolved");
    return { strategy, calls: all.length, resolved: resolved.length, unknown: all.filter((d) => d.outcome?.status === "unknown").length,
      pending: all.filter((d) => !d.outcome || d.outcome.status === "pending").length,
      positiveFraction: resolved.length ? resolved.filter((d) => d.outcome.scenarioReturn > 0).length / resolved.length : null,
      medianScenarioReturn: median(resolved.map((d) => d.outcome.scenarioReturn)),
      distinctTokens: new Set(all.map((d) => d.address)).size, note: "Descriptive sample; no statistical edge claim or executable returns." };
  });
}
