// The static site's live board. The agent already reads every live launch on the free node each cycle; this keeps the
// latest read per token and writes the slim subset the landing page and token cards render (public/block0-cards.js),
// in the /api/board shape: { cooking, graduated, dex, stats }. Pure.
const FLAGS = ["snipers", "sniperHeldPct", "bundles", "top10Pct", "holders", "wallets", "insiderSellersNow", "insiderDumpNowPct"];

export function mergeReads(prev, tokens, { now = Date.now(), maxAgeH = 72 } = {}) {
  const next = { ...(prev || {}) };
  for (const t of tokens || []) {
    if (!t?.address || t.risk == null) continue;
    const flags = {}; for (const k of FLAGS) if (t.flags?.[k] != null) flags[k] = t.flags[k];
    next[t.address] = { address: t.address, sym: t.sym, mcapUsd: t.mcapUsd ?? null, launchedAgeH: t.ageH ?? null, readAt: now,
      risk: t.risk, label: t.label ?? null, graduated: !!t.graduated, progress: t.progress ?? null, venue: t.venue ?? "pons", flags };
  }
  for (const [a, t] of Object.entries(next)) if ((t.launchedAgeH ?? 0) + (now - t.readAt) / 3.6e6 > maxAgeH) delete next[a];
  return next;
}

export function boardSnapshot(reads, stats, { now = Date.now(), limit = 60 } = {}) {
  const rows = Object.values(reads || {}).map(({ launchedAgeH, readAt, ...t }) => ({ ...t, ageH: launchedAgeH == null ? null : +(launchedAgeH + (now - readAt) / 3.6e6).toFixed(1),
    section: t.graduated ? "graduated" : "cooking" }))
    .sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, limit);
  return { updated: now, source: "block0 agent (free node) — refreshed every ~15 min", stats: { ...(stats || {}) },
    cooking: rows.filter((r) => !r.graduated), graduated: rows.filter((r) => r.graduated), dex: [] };
}
