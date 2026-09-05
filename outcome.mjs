// OUTCOME LABELS — what a launch actually became, from its reconstructed history. ONE rule for every token on the
// chain (Pons or direct DEX listing); graduation is NOT a criterion. A "winner" is a token that reached a real
// valuation AND HELD it — a sustainable path to multi-million, not a spike.
//
//   major    held-peak ≥ $5M, held ≥ $1M for 14 consecutive days, holders retained, not collapsed since
//   runner   held-peak ≥ $1M, held ≥ $1M for  7 consecutive days, holders retained, not collapsed since
//   ("held-peak" = the highest cap the token stayed at for a full day — reconstructed caps wick on single swaps;
//    "not collapsed" = still at/above 25% of that held-peak, so a week-long pump that then went to zero is faded)
//   pending  too young to have satisfied (or failed) the sustain window yet — EXCLUDED from both cohorts (right-censoring)
//   mid      reached ≥ $300k, still alive, but neither held $1M nor collapsed — undecided, excluded from both cohorts
//   faded    reached ≥ $300k, now below 25% of its peak — the PRIMARY control: got to the same stages, didn't hold
//   stalled  aged ≥ 7 days, never reached $300k, still has a market — a non-runner control
//   dead     aged ≥ 48h, never reached $300k, under $10k now (or under $10k after reaching it)
//
// Every threshold is a named knob below and is published on the methodology page. Winners are still defined by
// having got there (survivorship is in the design) — more tokens tighten the model, they don't make it a forecast.
export const RULES = {
  runnerMcap: 1e6, majorMcap: 5e6,
  runnerSustainH: 7 * 24, majorSustainH: 14 * 24,
  heldPeakH: 24,            // the "held peak" = highest cap the token stayed at for a full day (a one-swap wick is not a peak)
  holderKeep: 0.7,          // holders at the end ≥ 70% of peak holders — a thin pool can hold a cap while wallets leave
  fadeReach: 3e5,           // "reached the same stages" bar for the faded control
  fadeKeep: 0.25,           // faded = now below 25% of peak
  deadMcap: 1e4,
  minAgeH: 48,              // nothing is called dead/stalled/faded before this
  stallAgeH: 7 * 24,        // never reached $300k by a week old → stalled
  pendingMaxH: 21 * 24,     // a $1M-peak token gets 3 weeks to hold a week; after that, unresolved = mid
};
export const TIERS = ["major", "runner", "pending", "mid", "faded", "stalled", "dead"];
export const WINNER_TIERS = new Set(["major", "runner"]);
export const CONTROL_TIERS = new Set(["faded", "stalled", "dead"]);

// tokens that are not launches: the launchpad's own token, quote/wrapper assets. Never in either cohort.
export const EXCLUDE_TOKENS = new Set([
  "0x39dbed3a2bd333467115de45665cc57f813c4571", // PONS — the launchpad token ($600M+, distorts every ladder rung)
  "0x0453dcf836dc35da9f8523ea2bb928268f16f073", // USDC
  "0xc20764d8cb3bb4d054c2c42aa5f59f97f60252d4", // USDG
]);

// longest run of consecutive hours the series stayed at/above `level`. `now`/`curMcap` extend the last point:
// if the token is above the level right now, the open stretch runs to now (it is still holding).
export function sustainedHours(series, level, { now = null, curMcap = null } = {}) {
  let best = 0, run = 0, prevT = null, prevAbove = false;
  for (const p of series) {
    if (!(p.mcap > 0) || !(p.t > 0)) continue;
    const above = p.mcap >= level;
    if (above && prevAbove && prevT != null) run += (p.t - prevT) / 3600;
    else if (above) run = 0;
    if (!above) run = 0;
    if (run > best) best = run;
    prevT = p.t; prevAbove = above;
  }
  if (prevAbove && prevT != null && now != null && (curMcap == null || curMcap >= level)) {
    run += Math.max(0, (now - prevT) / 3600);
    if (run > best) best = run;
  }
  return best;
}

// Classify one token. `series` = backtest points {t, mcap, holders}; curMcap/curHolders = live values when known
// (the launchpad's live market cap is free and current, so a cached profile re-classifies with zero RPC).
export function classifyOutcome(series, { now = Date.now() / 1000, t0 = null, curMcap = null, curHolders = null, rules = RULES } = {}) {
  const R = rules;
  const pts = (series || []).filter((p) => p && p.t > 0);
  const start = t0 ?? (pts.length ? pts[0].t : now);
  const ageH = Math.max(0, (now - start) / 3600);
  const priced = pts.filter((p) => p.mcap > 0);
  const lastPt = pts[pts.length - 1] || null;
  const cur = curMcap != null ? curMcap : (priced.length ? priced[priced.length - 1].mcap : 0);
  const curH = curHolders != null ? curHolders : (lastPt ? lastPt.holders || 0 : 0);
  let peak = 0, peakT = null; for (const p of priced) if (p.mcap > peak) { peak = p.mcap; peakT = p.t; }
  if (cur > peak) { peak = cur; peakT = now; }
  // held-peak: the highest level the token stayed at/above for ≥ heldPeakH (robust to single-swap wicks)
  let heldPeak = 0;
  for (const lvl of new Set(priced.map((p) => p.mcap))) if (lvl > heldPeak && sustainedHours(pts, lvl, { now, curMcap: cur }) >= R.heldPeakH) heldPeak = lvl;
  if (cur > heldPeak && cur >= peak) heldPeak = Math.max(heldPeak, cur * 0.999); // live cap IS a current level (not a wick)
  const peakHolders = Math.max(curH, ...pts.map((p) => p.holders || 0), 0);
  const retention = peakHolders ? +(curH / peakHolders).toFixed(2) : null;
  const sustainedH = sustainedHours(pts, R.runnerMcap, { now, curMcap: cur });
  const keptHolders = retention == null || retention >= R.holderKeep;
  const alive = cur >= heldPeak * R.fadeKeep;   // hasn't collapsed relative to its own held level
  const base = { ageH: +ageH.toFixed(1), peakMcap: Math.round(peak), heldPeak: Math.round(heldPeak), peakAtH: peakT == null ? null : +((peakT - start) / 3600).toFixed(1),
    curMcap: Math.round(cur), sustainedH: +sustainedH.toFixed(1), curHolders: curH, peakHolders, retention };
  const out = (label, why, extra = {}) => ({ label, why, ...base, ...extra });

  if (heldPeak >= R.runnerMcap) {
    const wasRunner = sustainedH >= R.runnerSustainH;
    if (wasRunner && !alive) return out("faded", "held $1M+ for " + Math.round(sustainedH / 24) + "d, then collapsed under 25% of its held peak", { wasRunner });
    if (wasRunner && sustainedH >= R.majorSustainH && heldPeak >= R.majorMcap && keptHolders) return out("major", "held $1M+ for 14d, held-peak $5M+");
    if (wasRunner && keptHolders) return out("runner", "held $1M+ for 7d");
    if (wasRunner && !keptHolders) return out("mid", "held the cap but holders left (retention " + retention + ")", { wasRunner });
    if (!alive) return out("faded", "reached $1M, now under 25% of its held peak");
    if (ageH < R.pendingMaxH) return out("pending", "reached $1M, sustain window still open");
    return out("mid", "reached $1M, never held it a full week");
  }
  if (Math.max(heldPeak, peak * 0.5) >= R.fadeReach) {   // a wick counts toward "reached" only at half weight
    if (ageH < R.minAgeH) return out("pending", "reached $300k, under 48h old");
    if (cur < R.deadMcap) return out("dead", "reached $300k, under $10k now");
    if (cur < Math.max(heldPeak, peak * 0.5) * R.fadeKeep) return out("faded", "reached $300k, now under 25% of peak");
    return out("mid", "reached $300k, still alive, hasn't held $1M");
  }
  if (ageH < R.minAgeH) return out("pending", "under 48h old");
  if (cur < R.deadMcap) return out("dead", "never reached $300k, under $10k");
  if (ageH < R.stallAgeH) return out("pending", "under a week old, never reached $300k");
  return out("stalled", "a week old, never reached $300k");
}

export const isWinner = (label) => WINNER_TIERS.has(label);
export const isControl = (label) => CONTROL_TIERS.has(label);
export const isSettled = (label) => label !== "pending" && label !== "mid";

// human definitions, published verbatim on the methodology page and in model.json so the rule can't drift from the text
export function definitions(rules = RULES) {
  const $ = (x) => x >= 1e6 ? "$" + (x / 1e6) + "M" : "$" + Math.round(x / 1e3) + "k";
  const d = (h) => Math.round(h / 24) + " days";
  return [
    { tier: "major", role: "winner", rule: `held-peak ≥ ${$(rules.majorMcap)}, stayed ≥ ${$(rules.runnerMcap)} for ${d(rules.majorSustainH)}, holders ≥ ${Math.round(rules.holderKeep * 100)}% of peak, still ≥ ${Math.round(rules.fadeKeep * 100)}% of its held-peak` },
    { tier: "runner", role: "winner", rule: `held-peak ≥ ${$(rules.runnerMcap)}, stayed ≥ ${$(rules.runnerMcap)} for ${d(rules.runnerSustainH)}, holders ≥ ${Math.round(rules.holderKeep * 100)}% of peak, still ≥ ${Math.round(rules.fadeKeep * 100)}% of its held-peak` },
    { tier: "pending", role: "excluded", rule: `too young to have satisfied or failed the sustain window (right-censored)` },
    { tier: "mid", role: "excluded", rule: `reached ≥ ${$(rules.fadeReach)}, alive, neither held ${$(rules.runnerMcap)} nor collapsed — undecided` },
    { tier: "faded", role: "control", rule: `reached ≥ ${$(rules.fadeReach)} (or held ≥ ${$(rules.runnerMcap)} a week, then collapsed), now below ${Math.round(rules.fadeKeep * 100)}% of its held-peak` },
    { tier: "stalled", role: "control", rule: `${d(rules.stallAgeH)}+ old, never reached ${$(rules.fadeReach)}, still has a market` },
    { tier: "dead", role: "control", rule: `${Math.round(rules.minAgeH)}h+ old, under ${$(rules.deadMcap)} now` },
  ];
}
