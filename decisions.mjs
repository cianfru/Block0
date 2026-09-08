import { SETUP_VERSION, SETUP_RULES } from "./setups.mjs";
export const EVALUATION_POLICY = Object.freeze({ version: "indicative-6h-v1", delayMs: 60000,
  horizonMs: 6 * 3600000, toleranceMs: 10 * 60000, maxGapMs: 15 * 60000,
  feeBpsPerSide: 100, metric: "indicative catalog-price return with a 1% per-side cost scenario; not executable PnL" });
export function freezeDecision(address, f, strategy = SETUP_VERSION, context = {}) {
  return { id: `${strategy}:${address}:${f.at}`, address, strategy, at: f.at, featureVersion: f.version,
    features: structuredClone(f), rules: { ...SETUP_RULES }, policy: { ...EVALUATION_POLICY }, context: structuredClone(context) };
}
