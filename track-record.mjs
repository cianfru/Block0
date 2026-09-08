// Version 2 reads the forward experiment only. The old KV key is preserved, never rewritten or combined.
import { experiment } from "./experiment-runtime.mjs";
import { getJSONStrict } from "./store/kv.mjs";
import { report as legacyReport, callsList as legacyCalls } from "./track-record-legacy.mjs";
export async function trackRecord() {
  const s = await experiment.snapshot({ limit: 0 });
  return { schema: 2, methodology: "forward-indicative-6h-v1", updated: s.updated, enabled: s.enabled,
    error: s.error, coverage: s.coverage, strategies: s.strategies, predicted: s.calls.length,
    resolved: s.calls.filter(d => d.outcome?.status === "resolved").length,
    unknown: s.calls.filter(d => d.outcome?.status === "unknown").length,
    pending: s.calls.filter(d => !d.outcome || d.outcome.status === "pending").length,
    ready: false, note: s.note, legacyUrl: "/api/track-record/legacy" };
}
export async function trackCalls(n = 300) { return (await experiment.snapshot({ limit: 0 })).calls.slice(0, n); }
export async function legacyTrackRecord(n = 300) {
  const s = await getJSONStrict("track-record") || { tokens: {} };
  return { ...legacyReport(s), schema: 1, archived: true, ready: false,
    warning: "Legacy graduation/peak methodology. Not evidence of post-decision returns; collection stopped in v2.", calls: legacyCalls(s, n) };
}
