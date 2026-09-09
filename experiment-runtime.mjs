import { fetchLiveMarkets } from "./pons.mjs";
import { createExperiment } from "./experiment.mjs";
import { getBoard, getLaunchMetadata, setForensicTargets } from "./board.mjs";
import { fetchPair, marketSnapshot } from "./market.mjs";
const bounded = (key, fallback, max) => { const n = Number(process.env[key] ?? fallback); return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback; };
export const experiment = createExperiment({ enabled: process.env.EXPERIMENT_ON !== "0",
  live: fetchLiveMarkets, admissionRequiresForensics: true, balancedStages: true, admissionCandidates: getLaunchMetadata,
  cohortSize: bounded("EXPERIMENT_COHORT_SIZE", 4, 80),
  intervalMs: bounded("EXPERIMENT_INTERVAL_MS", 60000, 3600000),
  maxTokens: bounded("EXPERIMENT_MAX_TOKENS", 5000, 20000), sampleBudget: bounded("EXPERIMENT_SAMPLE_BUDGET", 80, 500),
  marketBudget: bounded("EXPERIMENT_MARKET_BUDGET", 4, 20),
  board: () => { const b = getBoard(); return [...b.cooking, ...b.graduated]; },
  market: async (address) => marketSnapshot(await fetchPair(address, { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(10000) }) })) });
setForensicTargets(() => experiment.trackedMetadata());
let timer = null;
export function startExperiment() {
  if (timer || process.env.EXPERIMENT_ON === "0") return;
  const run = async () => { const started = Date.now(); await experiment.cycle(); timer = setTimeout(run, Math.max(0, bounded("EXPERIMENT_INTERVAL_MS", 60000, 3600000) - (Date.now() - started))); };
  timer = setTimeout(run, 1000);
}
