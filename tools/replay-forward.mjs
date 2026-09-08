// Offline paired checkpoint comparison. Reads ONLY exported forward observations, never study/profiles.
import { readFileSync } from "node:fs";
import { featuresAt } from "../features.mjs";
import { nextSetup, SETUP_VERSION } from "../setups.mjs";
import { freezeDecision } from "../decisions.mjs";
import { evaluateDecision, summarize } from "../evaluation.mjs";
const file = process.argv[2];
if (!file) throw new Error("Usage: node tools/replay-forward.mjs exported-forward.json");
const data = JSON.parse(readFileSync(file, "utf8"));
if (data.schema !== 1 || !Array.isArray(data.records)) throw new Error("Expected a forward experiment export");
const records = data.records.filter((r) => r.observations?.length);
if (!records.length) throw new Error("No observations yet");
const end = Math.max(...records.map((r) => r.observations.at(-1).observedAt));
const step = 6 * 3600000, start = Math.ceil(Math.min(...records.map((r) => r.observations[0].observedAt)) / step) * step;
const states = new Map(), decisions = [], opportunities = [];
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
// Advance the setup lifecycle at actual observation times, matching live behavior.
const positions = new Map(records.map((r) => [r.address, 0]));
for (let at = start; at <= end; at += step) {
  const candidates = [];
  for (const r of records) {
    let i = positions.get(r.address);
    while (i < r.observations.length && r.observations[i].observedAt <= at) {
      const t = r.observations[i].observedAt;
      states.set(r.address, nextSetup(states.get(r.address), featuresAt(r.observations, t), t)); i++;
    }
    positions.set(r.address, i);
    const f = featuresAt(r.observations, at);
    if (f.ready) candidates.push({ r, f, state: states.get(r.address)?.state });
  }
  if (candidates.length < 3) continue;
  const momentum = candidates.slice().sort((a, b) => b.f.momentum15m - a.f.momentum15m || a.r.address.localeCompare(b.r.address));
  const selected = [["momentum-v1", momentum[0]], ["structure-momentum-v1", momentum.find((c) => c.f.risk <= 45 && c.f.insiderSellers === 0)],
    [SETUP_VERSION, momentum.find((c) => c.state === "triggered")]];
  for (let seed = 1; seed <= 20; seed++) selected.push([`random-${seed}`, candidates.slice().sort((a, b) => hash(`${seed}:${at}:${a.r.address}`) - hash(`${seed}:${at}:${b.r.address}`))[0]]);
  opportunities.push({ at, candidates: candidates.map((c) => c.r.address), abstained: selected.filter(([, c]) => !c).map(([s]) => s) });
  for (const [strategy, c] of selected) {
    if (!c) continue;
    const d = freezeDecision(c.r.address, c.f, strategy, { checkpoint: at, candidates: candidates.map((c) => c.r.address) });
    decisions.push({ ...d, outcome: evaluateDecision(d, c.r.observations, end) });
  }
}
console.log(JSON.stringify({ schema: 1, scope: "Common six-hour checkpoints, one candidate per strategy, 20 random seeds. This is a checkpoint portfolio comparison, not the live transition-alert record.",
  coverage: data.coverage, truncatedRecords: records.filter((r) => r.droppedObservations > 0).length,
  warning: "Descriptive indicative returns only; repeated tokens and common market exposure are dependent. No significance or executable edge claimed.",
  strategies: summarize(decisions), opportunities, decisions }, null, 2));
