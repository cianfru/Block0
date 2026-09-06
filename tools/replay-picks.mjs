// REPLAY THE PICK — the honest backtest of the PRODUCT. Point-in-time: at each day D a token is scored ONLY from its
// reconstructed series up to D. No label, no future point, no peak is visible to the ranker.
//
// This tool exists because the first version of this measurement was WRONG in two ways, and both flattered us:
//   1. BASELINE. Pooling candidate-days makes a random daily pick look like it has 1.9× "lift". The correct baseline
//      for one-pick-per-day is the DAY-WEIGHTED mean of each day's hit fraction. With that fix, random ≈ 1.19× (sane).
//   2. OBJECTIVE. "Did it reach $1M" is trivially gamed by entering late: ranking by market cap alone scores the best
//      hit-rate while entering at $815k, i.e. buying a 1.2×. The product metric is RETURN — entry → forward peak.
// Both corrections are baked in below. Run it against naive rankers (mcap / holders / random) or the number means nothing.
//
// Pool caveat, stated not hidden: every profiled token eventually graduated, so absolute rates are optimistic. The
// ranker-vs-ranker comparison on the SAME days is what's meaningful, because the pool bias cancels there.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blueprintMatch } from "../intel.mjs";
import { STUDY_DIR } from "./cohort-lib.mjs";

const arg = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const MAXMC = Number(arg.maxMcap || 1e6), MINAGE = Number(arg.minAgeH || 1), MAXAGE = Number(arg.maxAgeH || 168), MINHOLD = Number(arg.minHolders || 20);
const H = 3600, Dy = 86400, clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const $ = (x) => x == null ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : "$" + Math.round(x / 1e3) + "k";
const pval = (k, n, p) => { const lg = (x) => { let s = 0; for (let i = 2; i < x; i++) s += Math.log(i); return s; }; let t = 0; for (let i = k; i <= n; i++) t += Math.exp(lg(n + 1) - lg(i + 1) - lg(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return t; };

const idx = JSON.parse(readFileSync(join(STUDY_DIR, "cohort.json"), "utf8"));
const meta = new Map(idx.tokens.map((t) => [t.addr, t]));
const profs = readdirSync(join(STUDY_DIR, "profiles")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(STUDY_DIR, "profiles", f), "utf8"))).filter((p) => p.series?.length && meta.has(p.addr));
const stateAt = (p, T) => { if (T < p.t0 || T > p.t1) return null; let b = null; for (const pt of p.series) { if (pt.t > T) break; if (pt.mcap > 0) b = pt; } return b; };
const fwdPeak = (p, T) => { let m = 0; for (const pt of p.series) if (pt.t > T && pt.mcap > m) m = pt.mcap; return m || (meta.get(p.addr)?.heldPeak || 0); };
const promise = (p, pt) => blueprintMatch({ bundles: pt.bundles ?? p.bundles ?? 0, top10Pct: pt.top10 ?? 100, holders: pt.holders ?? 0, risk: pt.risk ?? 100 })
  + clamp(60 - (pt.risk ?? 100), 0, 60) + clamp((pt.holders || 0) / 10, 0, 30) - (pt.sniperHeld || 0) * 0.4;

const t0 = Math.min(...profs.map((p) => p.t0)), t1 = Math.max(...profs.map((p) => p.t1));
function replay(rank, seed = 7) {
  let rnd = seed; const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const picks = [], dayHit = [], dayMult = [];
  for (let T = Math.ceil(t0 / Dy) * Dy; T <= t1; T += Dy) {
    const c = [];
    for (const p of profs) {
      const pt = stateAt(p, T); if (!pt) continue;
      const a = (T - p.t0) / H;
      if (a < MINAGE || a > MAXAGE || !(pt.mcap > 0) || pt.mcap >= MAXMC || (pt.holders || 0) < MINHOLD) continue;
      c.push({ p, mcap: pt.mcap, holders: pt.holders || 0, score: promise(p, pt), hit: (meta.get(p.addr)?.heldPeak || 0) >= 1e6, mult: fwdPeak(p, T) / pt.mcap });
    }
    if (c.length < 3) continue;
    dayHit.push(c.filter((x) => x.hit).length / c.length);          // a RANDOM pick's odds that day
    dayMult.push(c.reduce((s, x) => s + x.mult, 0) / c.length);      // a RANDOM pick's expected multiple that day
    if (rank === "random") c.forEach((x) => (x._r = rand()));
    const key = rank === "promise" ? (x) => x.score : rank === "mcap" ? (x) => x.mcap : rank === "holders" ? (x) => x.holders : (x) => x._r;
    c.sort((a, b) => key(b) - key(a)); picks.push(c[0]);
  }
  const base = dayHit.reduce((s, x) => s + x, 0) / dayHit.length, baseMult = dayMult.reduce((s, x) => s + x, 0) / dayMult.length;
  const k = picks.filter((x) => x.hit).length, hit = k / picks.length, mults = picks.map((x) => x.mult);
  return { n: picks.length, k, hit, base, lift: hit / base, p: pval(k, picks.length, base), medEntry: med(picks.map((x) => x.mcap)),
    medMult: med(mults), meanMult: mults.reduce((s, x) => s + x, 0) / mults.length, baseMult };
}
console.log(`\nREPLAY · daily top pick · candidates age ${MINAGE}–${MAXAGE}h, under ${$(MAXMC)}, ≥${MINHOLD} holders`);
console.log("  ranker                     hit%   base%   lift      p        med entry   MEDIAN mult   mean mult");
for (const [lab, r] of [["PROMISE (our model)", "promise"], ["MARKET CAP (naive)", "mcap"], ["HOLDERS (naive)", "holders"], ["RANDOM (sanity)", "random"]]) {
  const x = replay(r);
  console.log(`  ${lab.padEnd(23)} ${(x.hit * 100).toFixed(1).padStart(5)}  ${(x.base * 100).toFixed(1).padStart(5)}  ${x.lift.toFixed(2)}×  ${x.p.toExponential(1).padStart(9)}   ${$(x.medEntry).padStart(8)}   ${x.medMult.toFixed(2)}×        ${x.meanMult.toFixed(1)}×`);
}
console.log(`  (a random daily pick's expected multiple: ${replay("random").baseMult.toFixed(1)}×)`);
console.log("\n  VERDICT RULE: the model earns its place only if it beats every naive ranker on MEDIAN MULT, not on hit%.");
