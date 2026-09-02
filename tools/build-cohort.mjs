// build-cohort — populate the winner/loser study dirs by backtesting each cohort token. This is step 1 of the
// model pipeline (see tools/README.md): it needs an RPC (one backtest per token), so run it OFFLINE / on Railway,
// never in a sandbox. As Pons matures and more tokens graduate, re-running this is how the model — and its
// MEASURED reliability (tools/validate.mjs) — gets stronger. Everything downstream is deterministic.
//
// Cohort definition (honest + reproducible):
//   • winners = the top-N GRADUATED tokens by market cap (the proven cohort).
//   • losers  = active, AGED (> minLoserAgeH), NON-graduated, LOW-mcap tokens — launches that had their shot and
//               faded or died. Split into 'dead' (~0 mcap) vs 'faded' (small but nonzero).
// Survivorship is inherent (winners are defined by having graduated) — validate.mjs measures separation with that
// caveat stated. Widen the sets with --winners / --losers as the launchpad grows.
//
// Usage (from the scanner root):
//   node tools/build-cohort.mjs [--winners=12] [--losers=30] [--minLoserAgeH=48] [--maxLoserMcap=60000] [--points=90]
// Then: node tools/corridor.mjs && node tools/projection.mjs && node tools/gen-model.mjs && node tools/validate.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchActive, fetchGraduated } from "../pons.mjs";
import { backtest } from "../backtest.mjs";

const arg = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const N_WIN = Number(arg.winners || 12), N_LOSE = Number(arg.losers || 30);
const MIN_LOSER_AGE_H = Number(arg.minLoserAgeH || 48), MAX_LOSER_MCAP = Number(arg.maxLoserMcap || 60000);
const POINTS = Number(arg.points || 90);
const ageH = (t) => t.launchedAt ? (Date.now() - Date.parse(t.launchedAt)) / 3.6e6 : 0;
const key = (sym) => (sym || "?").replace(/\s+/g, "_");

for (const d of ["profiles", "winners_full", "losers"]) mkdirSync(d, { recursive: true });

async function bt(meta) {
  const r = await backtest(meta.address, { sym: meta.sym, pool: meta.pool, graduated: !!meta.graduated, launchedAt: meta.launchedAt, points: POINTS });
  return { ...r, mcapUsd: meta.mcapUsd, name: meta.name, deployer: meta.deployer }; // attach fields the study builders read
}

console.log("fetching the launch universe from Pons…");
const [grad, active] = await Promise.all([fetchGraduated(), fetchActive({ sort: "marketCap", pageSize: 400 })]);

// winners: top graduated by market cap
const winners = grad.items.filter((t) => t.address).sort((a, b) => b.mcapUsd - a.mcapUsd).slice(0, N_WIN);
// losers: aged, non-graduated, low-mcap active launches (had their shot, didn't make it)
const losers = active.items
  .filter((t) => t.address && !t.graduated && ageH(t) >= MIN_LOSER_AGE_H && (t.mcapUsd || 0) <= MAX_LOSER_MCAP)
  .sort((a, b) => ageH(b) - ageH(a)).slice(0, N_LOSE);

console.log(`winners: ${winners.length} (top graduated) · losers: ${losers.length} (aged <${MAX_LOSER_MCAP} mcap, >${MIN_LOSER_AGE_H}h)`);

let ok = 0, skip = 0;
for (const m of winners) {
  try { const r = await bt(m); if (r.error || !r.series?.length) { skip++; console.log("  skip winner", m.sym, r.error || "no series"); continue; }
    const j = JSON.stringify(r); writeFileSync(`profiles/${key(m.sym)}.json`, j); writeFileSync(`winners_full/${key(m.sym)}.json`, j); ok++;
    console.log(`  ✓ winner ${m.sym} — ${r.series.length} pts`);
  } catch (e) { skip++; console.log("  skip winner", m.sym, e.message); }
}
const loserMeta = { dead: [], faded: [] };
for (const m of losers) {
  try { const r = await bt(m); if (r.error || !r.series?.length) { skip++; continue; }
    writeFileSync(`losers/${key(m.sym)}.json`, JSON.stringify(r));
    const kind = (m.mcapUsd || 0) < 2000 ? "dead" : "faded";
    loserMeta[kind].push({ sym: m.sym, mcapUsd: Math.round(m.mcapUsd || 0), kind }); ok++;
    console.log(`  ✓ loser  ${m.sym} (${kind}) — ${r.series.length} pts`);
  } catch (e) { skip++; console.log("  skip loser", m.sym, e.message); }
}

// metadata the study builders read
writeFileSync("losers.json", JSON.stringify(loserMeta));
writeFileSync("board.json", JSON.stringify({ cooking: [], graduated: grad.items.map((t) => ({ sym: t.sym, mcapUsd: t.mcapUsd })) }));

console.log(`\ndone — ${ok} backtests written, ${skip} skipped.`);
console.log("next: node tools/corridor.mjs && node tools/projection.mjs && node tools/gen-model.mjs && node tools/validate.mjs");
