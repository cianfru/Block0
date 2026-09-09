// Reserve existing board slots; never add scans beyond the existing total budget.
export function boardTargets(active, graduated, tracked, budget) {
  const out = [], seen = new Set();
  for (const m of [...tracked, ...active, ...graduated]) {
    if (out.length >= budget) break;
    if (!m?.address || seen.has(m.address)) continue;
    seen.add(m.address); out.push(m);
  }
  return out;
}
export function evidenceAt(o, f, at) {
  const recent = !!o && at - o.observedAt <= 5 * 60000;
  return { stage: o?.graduated === true ? 'post-graduation' : o?.graduated === false ? 'pre-graduation' : 'unknown',
    price: recent && o.priceUsd > 0,
    forensics: recent && o.forensicAt != null && at - o.forensicAt <= 10 * 60000 && o.holders != null && o.risk != null && o.insiderSellers != null,
    liquidity: recent && o.graduated === true && o.marketAt != null && at - o.marketAt <= 5 * 60000 && o.liquidityUsd > 0,
    history: recent && !!f?.historyReady, ready: recent && !!f?.ready };
}
// Fixed prospective window. Expected slots accrue in wall-clock time, including skipped
// cycles/restarts. An observation covers at most one slot; late reads never backfill gaps.
export function accountValidation(previous, tracked, samples, at, intervalMs = 60000) {
  const first = Math.min(at, ...[...samples.values()].map(s => s.observedAt));
  const v = structuredClone(previous || { version: 'evidence-validation-v1', startedAt: first, endsAt: first + 86400000,
    intervalMs, expected: 0, recorded: 0, freshForensics: 0, stages: {}, cursors: {} });
  for (const r of tracked) {
    const start = Math.max(v.startedAt, r.trackedAt || at);
    const end = Math.min(at, v.endsAt - 1, r.pending ? Infinity : (r.trackUntil || at));
    if (end < start) continue;
    const slot = Math.floor((end - start) / v.intervalMs), key = r.address + ':' + r.trackedAt;
    const before = v.cursors[key] ?? -1;
    if (slot <= before) continue;
    const expected = slot - before;
    v.expected += expected; v.cursors[key] = slot;
    const sample = samples.get(r.address);
    if (sample && sample.observedAt >= start + slot * v.intervalMs && sample.observedAt < v.endsAt) {
      v.recorded++; if (sample.evidence.forensics) v.freshForensics++;
      const stage = sample.evidence.stage;
      const counts = v.stages[stage] ||= { recorded: 0, usableLiquidity: 0, historyReady: 0 };
      counts.recorded++; if (sample.evidence.liquidity) counts.usableLiquidity++;
      if (sample.evidence.history) counts.historyReady++;
    }
  }
  return v;
}
export function validationReport(v, at) {
  if (!v) return null;
  const { cursors, ...rest } = v;
  return { ...rest, status: at >= v.endsAt ? 'complete' : 'collecting',
    observationRate: v.expected ? v.recorded / v.expected : null,
    forensicFreshnessRate: v.recorded ? v.freshForensics / v.recorded : null,
    observationTarget: 0.95, note: 'Prospective 24-hour collection validation, not a performance backtest. Missing slots are not reconstructed.' };
}
