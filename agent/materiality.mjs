// WHAT IS WORTH A POST — pure. Every detected event goes on the launch's timeline; only MATERIAL ones are offered to
// the posting gate (budget.plan). An account that posts "creator withdrew 67 ORBIO (≈$6)" or "1 wallet sold 0.5%" is
// noise nobody follows; the bar below is what the 2026-10-01…03 dry run showed was missing. Thresholds are knobs, not
// findings: they decide what is news, never what is predictive.
//
//   insider-dump     ≥2 early wallets, or ≥5% of the wallet-held supply — on a launch worth ≥$25k
//   serial-owner     the owner launched ≥5 agents before this one, none graduated
//   principal-withdrawn / cliff-24h / first-harvest / credit-idle — timeline only. Withdrawing the staked half of
//                    claimed fees after its lock is Orbio's normal fee flow (every creator does it: SEEKER, POL, FNDRY,
//                    ORA all withdrew 100% on 2026-10-03), so posting it as news would misrepresent routine behaviour.
export const BAR = { minMcap: 25000, dumpWallets: 2, dumpPct: 5, serialPrior: 5 };
export const TIMELINE_ONLY = new Set(["principal-withdrawn", "cliff-24h", "first-harvest", "credit-idle"]);

// → null when the event is worth posting, else the reason it stays on the timeline
export function notMaterial(ev, bar = BAR) {
  const d = ev.detail || {};
  if (TIMELINE_ONLY.has(ev.kind)) return "timeline only: routine Orbio fee mechanics";
  if (ev.kind === "insider-dump") {
    if ((ev.mcapUsd || 0) < bar.minMcap) return `below the $${bar.minMcap / 1000}k posting floor`;
    if ((d.sellers || 0) < bar.dumpWallets && (d.pct || 0) < bar.dumpPct) return `1 wallet, under ${bar.dumpPct}% of wallet-held supply`;
  }
  if (ev.kind === "serial-owner" && (d.prior || 0) < bar.serialPrior) return `owner has fewer than ${bar.serialPrior} earlier launches`;
  return null;
}
