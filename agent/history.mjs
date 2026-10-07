// READ HISTORY — what a launch looked like, hour by hour. Pure.
// The agent re-reads every live launch about every 15 minutes, but the board keeps only the latest read, so how a
// launch got to where it is was thrown away. This keeps one compact row per launch per hour (agent-data/history/
// <UTC day>.jsonl, append-only) — enough to ask later, under a pre-registered test, whether launches that graduate or
// hold look different at hour 1, 6 or 24. Nothing here is shown as a signal; it is the record such a test needs.
//
// Row keys (short on purpose: ~350 launches × 24 h ≈ 1–2 MB a day):
//   t  read time (ms)        a   address              s   symbol             v   venue (o = Orbio agent, p = Pons)
//   ag launch age (h)         mc  market cap (USD)     g   graduated (0/1)    pr  curve progress (%)
//   h  holders                w   wallets that ever bought                 t10 top-10 share (%)
//   sn snipers                eh  share early wallets hold (%)             b   bundles   bh  share bundles hold (%)
//   sel early wallets selling now   so  share they sold (%)   mv  early wallets moving out now   r  risk summary
export const MIN_GAP_MS = 55 * 60e3, KEEP_DAYS = 60;

const num = (x, d = 1) => (x == null || !Number.isFinite(Number(x)) ? null : +Number(x).toFixed(d));

export function historyRow(t, now = Date.now()) {
  const f = t.flags || {};
  return { t: now, a: t.address, s: t.sym ?? null, v: t.venue === "orbio-agent" ? "o" : "p", ag: num(t.ageH, 2), mc: num(t.mcapUsd, 0),
    g: t.graduated ? 1 : 0, pr: t.progress ?? null, h: f.holders ?? null, w: f.wallets ?? null, t10: num(f.top10Pct), sn: f.snipers ?? null,
    eh: num(f.sniperHeldPct), b: f.bundles ?? null, bh: num(f.bundleHeldPct), sel: f.insiderSellersNow ?? null, so: num(f.insiderDumpNowPct, 2),
    mv: f.earlyMovedOutNow ?? null, r: t.risk ?? null };
}

// tokens read this cycle + when each was last written → the rows to append now, and the updated last-written map
// (entries older than KEEP_DAYS dropped, so the map tracks only live launches)
export function historyRows(tokens, lastAt = {}, { now = Date.now(), minGapMs = MIN_GAP_MS } = {}) {
  const next = {}, rows = [];
  for (const [a, at] of Object.entries(lastAt || {})) if (now - at < KEEP_DAYS * 86400e3) next[a] = at;
  for (const t of tokens || []) {
    if (!t?.address || t.risk == null) continue;
    if (next[t.address] && now - next[t.address] < minGapMs) continue;
    rows.push(historyRow(t, now)); next[t.address] = now;
  }
  return { rows, lastAt: next };
}

export const historyFile = (now = Date.now()) => new Date(now).toISOString().slice(0, 10) + ".jsonl";
