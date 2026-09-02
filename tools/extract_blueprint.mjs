// Read the cohort profiles, extract each winner's launch-window signature, aggregate into a blueprint.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

const winners = [];
for (const f of readdirSync("profiles").filter((f) => f.endsWith(".json"))) {
  const r = JSON.parse(readFileSync("profiles/" + f, "utf8"));
  if (r.error || !r.series?.length) { console.log("skip", f, r.error || "no series"); continue; }
  const s = r.series;
  const t10 = s.map((p) => p.top10), risk = s.map((p) => p.risk), snip = s.map((p) => p.sniperHeld), hold = s.map((p) => p.holders);
  // downsample the trajectory to ~28 points for the sparkline
  const step = Math.max(1, Math.floor(s.length / 28));
  const traj = s.filter((_, i) => i % step === 0).map((p) => ({ top10: p.top10, risk: p.risk, holders: p.holders }));
  // SETTLED metrics (last 55% of the window) — robust to the launch-instant illiquidity blip where a brand-new
  // token with a handful of holders reads 100% top-10 / high risk purely for being new, before it distributes.
  const late = s.slice(Math.floor(s.length * 0.45));
  const lateT10 = late.map((p) => p.top10), lateRisk = late.map((p) => p.risk);
  winners.push({
    sym: r.sym, mcapUsd: r.mcapUsd, transfers: r.transfers, hours: +((r.t1 - r.t0) / 3600).toFixed(1),
    bundles: r.bundles, launchSnipers: r.snipers,
    t10Launch: t10[0], t10End: t10[t10.length - 1], t10Min: Math.min(...t10),
    t10Settled: median(lateT10), riskSettled: median(lateRisk), riskLateMax: Math.max(...lateRisk),
    sniperHeldMax: Math.max(...snip), riskMax: Math.max(...risk), riskEnd: risk[risk.length - 1],
    holders0: hold[0], holdersEnd: Math.max(...hold), distributed: median(lateT10) < t10[0] - 2 || t10[0] <= 35,
    traj,
  });
}
winners.sort((a, b) => b.mcapUsd - a.mcapUsd);

const n = winners.length;
const sig = {
  n,
  t10SettledMed: median(winners.map((w) => w.t10Settled)),
  t10SettledHi: q(winners.map((w) => w.t10Settled), 0.9),
  distributedFrac: winners.filter((w) => w.distributed).length / n,
  zeroBundlesFrac: winners.filter((w) => w.bundles === 0).length / n,
  sniperHeldHi: q(winners.map((w) => w.sniperHeldMax), 0.9),
  sniperHeldMed: median(winners.map((w) => w.sniperHeldMax)),
  riskSettledMed: median(winners.map((w) => w.riskSettled)),
  riskSettledHi: q(winners.map((w) => w.riskSettled), 0.9),
  cleanFrac: winners.filter((w) => w.riskSettled < 25).length / n,
  holdersEndMed: median(winners.map((w) => w.holdersEnd)),
};
writeFileSync("study/blueprint_data.json", JSON.stringify({ winners, sig }, null, 0));
console.log(`\ncohort: ${n} winners`);
console.log("sym        mc     t10 launch→settled  distr  snipMax  riskSettled(max)  bundles  holders");
for (const w of winners) console.log(`  ${w.sym.padEnd(10)} $${(w.mcapUsd/1e6).toFixed(0).padStart(3)}M  ${String(w.t10Launch).padStart(5)}→${String(w.t10Settled).padStart(5)}%  ${w.distributed?"yes":"no "}  ${String(w.sniperHeldMax).padStart(5)}%  ${String(w.riskSettled).padStart(3)} (${w.riskMax})   ${w.bundles}       ${w.holders0}→${w.holdersEnd}`);
console.log("\n── SIGNATURE (settled) ──");
console.log(`top-10 settled: median ${sig.t10SettledMed}% (90th ${sig.t10SettledHi}%)`);
console.log(`float distributed/moderate in ${(sig.distributedFrac*100).toFixed(0)}% of winners`);
console.log(`zero bundles in ${(sig.zeroBundlesFrac*100).toFixed(0)}% of winners`);
console.log(`sniper-held max: median ${sig.sniperHeldMed}% (90th ${sig.sniperHeldHi}%)`);
console.log(`risk settled: median ${sig.riskSettledMed} (90th ${sig.riskSettledHi}); ${(sig.cleanFrac*100).toFixed(0)}% settled <25 (CLEAN)`);
console.log(`holders reached: median ${sig.holdersEndMed}`);
