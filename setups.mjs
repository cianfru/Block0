export const SETUP_VERSION = "pullback-participation-v1";
// Frozen experiment parameters, deliberately separate from the legacy promise score. Not fitted to outcomes.
export const SETUP_RULES = Object.freeze({ maxRisk: 45, minLiquidityUsd: 10000, minHolderGrowth: 0.02,
  minMomentum: 0.03, minPullback: 0.1, maxPullback: 0.5, minRecovery: 0.03, expiresMs: 6 * 3600000 });
export function nextSetup(previous, f, now = f.at) {
  const prev = previous || { state: "observing", since: now, triggeredAt: null };
  let state = "observing", reasons = f.reasons || [];
  const triggeredAt = prev.triggeredAt ?? null;
  const terminal = ["invalidated", "expired"].includes(prev.state);
  if (terminal) return { ...prev }; // one setup episode per token/version; do not repeatedly mine the same move
  if (triggeredAt != null && now - triggeredAt >= SETUP_RULES.expiresMs) { state = "expired"; reasons = ["six-hour setup window ended"]; }
  else if (!f.ready) { state = triggeredAt != null ? "deteriorating" : "observing"; }
  else if (f.risk > SETUP_RULES.maxRisk || f.liquidityUsd < SETUP_RULES.minLiquidityUsd || f.insiderSellers > 0) {
    state = triggeredAt != null ? "invalidated" : "observing";
    reasons = ["structure, liquidity or observed selling fails the experimental filter"];
  } else {
    const demand = f.holderGrowth >= SETUP_RULES.minHolderGrowth;
    const timing = f.momentum15m >= SETUP_RULES.minMomentum && f.pullback >= SETUP_RULES.minPullback && f.pullback <= SETUP_RULES.maxPullback && f.recovery >= SETUP_RULES.minRecovery;
    state = demand && timing ? "triggered" : triggeredAt != null ? "deteriorating" : demand ? "building" : "observing";
    reasons = state === "triggered" ? ["holder count grew at least 2%", "price recovered after an observed pullback", "liquidity and structural filters passed"]
      : state === "building" ? ["holder participation growing; waiting for timing condition"] : ["participation or timing condition is absent"];
  }
  return { version: SETUP_VERSION, state, reasons, since: state === prev.state ? prev.since : now,
    triggeredAt: triggeredAt ?? (state === "triggered" ? now : null),
    caveat: "Experimental conditions; wallet independence and executable fills are unverified." };
}
