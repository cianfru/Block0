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
import { discoverDex, tokenMeta } from "../dex.mjs";
import { isTokenizedStock } from "../intel.mjs";

const arg = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const N_WIN = Number(arg.winners || 12), N_LOSE = Number(arg.losers || 30);
const MIN_LOSER_AGE_H = Number(arg.minLoserAgeH || 48), MAX_LOSER_MCAP = Number(arg.maxLoserMcap || 60000);
const POINTS = Number(arg.points || 90);
// DEX cohort (--dex): mine non-Pons Uniswap-v4 listings — the gold mine for a bigger, better-fit model. We backtest
// a bounded set of discovered tokens and classify each by its OUTCOME (final reconstructed mcap + holders).
const DEX_BLOCKS = Number(arg.dexBlocks || 1_500_000), DEX_CAP = Number(arg.dexCap || 120);
const DEX_WIN_MCAP = Number(arg.dexWinMcap || 300000), DEX_WIN_HOLDERS = Number(arg.dexWinHolders || 150);
const DEX_LOSE_MCAP = Number(arg.dexLoseMcap || 15000);
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

// ─── DEX cohort (non-Pons Uniswap-v4 listings) — the gold mine ───────────────────────────────────────
const dexBoard = []; // {sym, mcapUsd} for board.json currentMc
if (arg.dex) {
  const $ = (x) => x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
  console.log(`\n=== DEX cohort · scanning ${DEX_BLOCKS.toLocaleString()} blocks for listings ===`);
  const { tokens } = await discoverDex({ blocks: DEX_BLOCKS });
  const cand = tokens.sort((a, b) => b.block - a.block).slice(0, DEX_CAP);
  console.log(`discovered ${tokens.length} DEX tokens · profiling ${cand.length} (win ≥ ${$(DEX_WIN_MCAP)}/${DEX_WIN_HOLDERS} holders · lose < ${$(DEX_LOSE_MCAP)})`);
  let dw = 0, dl = 0, prof = 0;
  for (const t of cand) {
    let m; try { m = await tokenMeta(t.address); } catch { continue; }
    if (!m.symbol || !(m.supply > 0)) continue;
    try { if (await isTokenizedStock(t.address)) continue; } catch { /* keep on lookup error */ } // drop tokenized equities/ETFs
    let r; try { r = await backtest(t.address, { sym: m.symbol, graduated: false, points: POINTS }); } catch { continue; }
    if (r.error || !r.series?.length) continue;
    prof++;
    const last = r.series[r.series.length - 1], mcap = last.mcap || 0, holders = last.holders || 0;
    const k = `${key(m.symbol)}_${t.address.slice(2, 8)}`; // unique across Pons + DEX + same-symbol DEX tokens
    r.sym = k; r.mcapUsd = Math.round(mcap); r.name = m.name || m.symbol; r.venue = "uniswap-v4";
    if (mcap >= DEX_WIN_MCAP && holders >= DEX_WIN_HOLDERS) {
      const j = JSON.stringify(r); writeFileSync(`profiles/${k}.json`, j); writeFileSync(`winners_full/${k}.json`, j);
      dexBoard.push({ sym: k, mcapUsd: r.mcapUsd }); dw++; ok++;
      console.log(`  ✓ DEX WINNER ${m.symbol.padEnd(12)} ${$(mcap).padStart(7)} · ${holders} holders`);
    } else if (mcap < DEX_LOSE_MCAP || holders < 30) {
      const kind = mcap < 2000 ? "dead" : "faded";
      writeFileSync(`losers/${k}.json`, JSON.stringify(r));
      loserMeta[kind].push({ sym: k, mcapUsd: r.mcapUsd, kind }); dl++; ok++;
    }
  }
  console.log(`DEX cohort: ${dw} winners · ${dl} losers (from ${prof} profiled)`);
}

// metadata the study builders read
writeFileSync("losers.json", JSON.stringify(loserMeta));
writeFileSync("board.json", JSON.stringify({ cooking: [], graduated: [...grad.items.map((t) => ({ sym: t.sym, mcapUsd: t.mcapUsd })), ...dexBoard] }));

console.log(`\ndone — ${ok} backtests written, ${skip} skipped.`);
console.log("next: node tools/corridor.mjs && node tools/projection.mjs && node tools/gen-model.mjs && node tools/validate.mjs");
