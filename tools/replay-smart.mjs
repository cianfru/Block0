// THE SMART-MONEY EXPERIMENT — does "proven wallets are already in it" actually predict a RUN?
//
// This is the falsifiable test of the one signal the replay never saw. Same rails as tools/replay-picks.mjs:
//   • POINT-IN-TIME. A wallet counts as smart at day D only if ≥2 of its round trips CLOSED before D, on OTHER
//     tokens, none of them sniped at block 0 (see smart-money.provenLedger/provenAt). No future proof leaks in.
//   • DAY-WEIGHTED baseline (a random pick that day), never pooled candidate-days.
//   • Judged on MEDIAN FORWARD RETURN (entry → forward peak), never hit-rate: "reached $1M" is trivially won by
//     entering at $900k, which is how ranking by market cap alone beat our model last time.
// A ranker earns its place ONLY if it beats mcap / holders / random on median forward return, on the same days.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blueprintMatch } from "../intel.mjs";
import { provenLedger, provenAt } from "../smart-money.mjs";
import { STUDY_DIR } from "./cohort-lib.mjs";

const arg = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const MAXMC = Number(arg.maxMcap || 1e6), MINAGE = Number(arg.minAgeH || 1), MAXAGE = Number(arg.maxAgeH || 168);
const MINHOLD = Number(arg.minHolders || 20), MINWINS = Number(arg.minWins || 2);
const H = 3600, Dy = 86400, clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const $ = (x) => x == null ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : "$" + Math.round(x / 1e3) + "k";

const idx = JSON.parse(readFileSync(join(STUDY_DIR, "cohort.json"), "utf8"));
const meta = new Map(idx.tokens.map((t) => [t.addr, t]));
const profs = readdirSync(join(STUDY_DIR, "profiles")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(STUDY_DIR, "profiles", f), "utf8"))).filter((p) => p.series?.length && meta.has(p.addr));
const withTraders = profs.filter((p) => Array.isArray(p.traders) && p.traders.length);
if (withTraders.length < profs.length * 0.5) {
  console.log(`\n⚠ NOT ENOUGH DATA: ${withTraders.length}/${profs.length} profiles carry per-wallet trader records.`);
  console.log("  The profile cache predates the trader field. Run a FULL rebuild (rebuild-model with refresh=true)");
  console.log("  to backfill it, then re-run this experiment. Nothing is inferred in the meantime.\n");
  process.exit(2);
}
const ledger = provenLedger(profs);
console.log(`proven ledger: ${ledger.size} wallets with ≥1 clean closed win (bar = ${MINWINS} wins on distinct non-sniped tokens)`);

const stateAt = (p, T) => { if (T < p.t0 || T > p.t1) return null; let b = null; for (const pt of p.series) { if (pt.t > T) break; if (pt.mcap > 0) b = pt; } return b; };
const fwdPeak = (p, T) => { let m = 0; for (const pt of p.series) if (pt.t > T && pt.mcap > m) m = pt.mcap; return m || (meta.get(p.addr)?.heldPeak || 0); };
const promise = (p, pt) => blueprintMatch({ bundles: pt.bundles ?? p.bundles ?? 0, top10Pct: pt.top10 ?? 100, holders: pt.holders ?? 0, risk: pt.risk ?? 100 })
  + clamp(60 - (pt.risk ?? 100), 0, 60) + clamp((pt.holders || 0) / 10, 0, 30) - (pt.sniperHeld || 0) * 0.4;
// how many PROVEN wallets had already bought this token by T (their proof earned elsewhere, before T)
const smartIn = (p, T) => {
  let n = 0;
  for (const w of p.traders || []) { if (w.firstBuyT == null || w.firstBuyT > T) continue; if (provenAt(ledger, w.a, T, { exclude: p.addr, minWins: MINWINS })) n++; }
  return n;
};

const t0 = Math.min(...profs.map((p) => p.t0)), t1 = Math.max(...profs.map((p) => p.t1));
function replay(rank, seed = 7) {
  let rnd = seed; const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const picks = [], dayHit = [], dayMult = []; let smartDays = 0;
  for (let T = Math.ceil(t0 / Dy) * Dy; T <= t1; T += Dy) {
    const c = [];
    for (const p of profs) {
      const pt = stateAt(p, T); if (!pt) continue;
      const a = (T - p.t0) / H;
      if (a < MINAGE || a > MAXAGE || !(pt.mcap > 0) || pt.mcap >= MAXMC || (pt.holders || 0) < MINHOLD) continue;
      c.push({ p, mcap: pt.mcap, holders: pt.holders || 0, score: promise(p, pt), smart: smartIn(p, T),
        hit: (meta.get(p.addr)?.heldPeak || 0) >= 1e6, mult: fwdPeak(p, T) / pt.mcap });
    }
    if (c.length < 3) continue;
    dayHit.push(c.filter((x) => x.hit).length / c.length);
    dayMult.push(c.reduce((s, x) => s + x.mult, 0) / c.length);
    if (c.some((x) => x.smart > 0)) smartDays++;
    if (rank === "random") c.forEach((x) => (x._r = rand()));
    const key = rank === "smart" ? (x) => x.smart * 1000 + x.score      // smart money first, promise breaks ties
      : rank === "smartOnly" ? (x) => x.smart
      : rank === "promise" ? (x) => x.score : rank === "mcap" ? (x) => x.mcap : rank === "holders" ? (x) => x.holders : (x) => x._r;
    c.sort((a, b) => key(b) - key(a)); picks.push(c[0]);
  }
  const base = dayHit.reduce((s, x) => s + x, 0) / dayHit.length, baseMult = dayMult.reduce((s, x) => s + x, 0) / dayMult.length;
  const mults = picks.map((x) => x.mult), k = picks.filter((x) => x.hit).length;
  return { n: picks.length, k, hit: k / picks.length, base, baseMult, smartDays,
    medEntry: med(picks.map((x) => x.mcap)), medMult: med(mults), meanMult: mults.reduce((s, x) => s + x, 0) / mults.length,
    medSmart: med(picks.map((x) => x.smart)) };
}
console.log(`\nSMART-MONEY EXPERIMENT · candidates age ${MINAGE}–${MAXAGE}h, under ${$(MAXMC)}, ≥${MINHOLD} holders`);
console.log("  ranker                     hit%   base%    med entry   MEDIAN mult   mean mult   med smart-in-pick");
for (const [lab, r] of [["SMART then promise", "smart"], ["SMART only", "smartOnly"], ["PROMISE (old model)", "promise"], ["MARKET CAP", "mcap"], ["HOLDERS", "holders"], ["RANDOM", "random"]]) {
  const x = replay(r);
  console.log(`  ${lab.padEnd(23)} ${(x.hit * 100).toFixed(1).padStart(5)}  ${(x.base * 100).toFixed(1).padStart(5)}    ${$(x.medEntry).padStart(8)}   ${x.medMult.toFixed(2)}×        ${x.meanMult.toFixed(1)}×       ${x.medSmart ?? 0}`);
}
const z = replay("random");
console.log(`  (random pick's expected multiple ${z.baseMult.toFixed(1)}× · days where ANY candidate had proven money in: ${z.smartDays}/${z.n})`);
console.log("\n  VERDICT: smart money earns its place only if it beats mcap/holders/random on MEDIAN MULT.");
