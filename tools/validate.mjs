// validate — does the winner-corridor signal actually SEPARATE winners from losers, and WHEN?
//
// Honest scope: this measures DISCRIMINATION on the study cohort itself (10 winners, 23 losers) — it is an
// in-sample separation check, NOT out-of-sample proof. A memecoin launchpad this young can't yet give a held-out,
// time-forward test; that comes as more launches graduate. But it answers the question that decides whether the
// signal is worth surfacing at all: at each age, do winners sit above losers in the corridor, and by how much?
//
// Metrics per age bin (all mix-independent so the artificial 10:23 cohort ratio can't flatter them):
//   • AUC  = P(random winner's trajectory > random loser's) — 0.5 is a coin flip, 1.0 is perfect separation.
//   • on-track rates: % of winners vs % of losers at/above the corridor's lower band (q1) at that age.
//   • survival: did the token even reach that age (dying early is itself the strongest signal).
// Run:  node tools/validate.mjs
import { readFileSync, writeFileSync } from "node:fs";
const ROOT = new URL("..", import.meta.url);
const rd = (f) => JSON.parse(readFileSync(new URL(f, ROOT), "utf8"));
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctile = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); if (!s.length) return 0; const i = (s.length - 1) * p; const l = Math.floor(i), h = Math.ceil(i); return l === h ? s[l] : s[l] + (s[h] - s[l]) * (i - l); };

const corr = rd("study/corridor_data.json"); // { bins, winners:[{path:[{a,t}]}], losers:[...] }
const bins = corr.bins.map((b) => ({ lo: b.lo, hi: b.hi, q1: b.q1 }));

// a token's trajectory at an age bin = mean of its path points inside the bin (null if it never reached that age)
const trajAt = (tok, b) => { const v = (tok.path || []).filter((p) => p.a >= b.lo && p.a < b.hi).map((p) => p.t); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
// AUC via all-pairs (Mann–Whitney): fraction of (winner,loser) pairs where winner ranks strictly higher (+½ ties)
function auc(pos, neg) { if (!pos.length || !neg.length) return null; let c = 0; for (const p of pos) for (const n of neg) c += p > n ? 1 : p === n ? 0.5 : 0; return c / (pos.length * neg.length); }

// The product's ACTUAL rule is "is the token at/above the winner corridor's lower band (q1) at this age?".
// Grade THAT — the number a trader actually acts on — and grade it honestly:
//   • winners are scored LEAVE-ONE-OUT: each winner is tested against a band rebuilt from the OTHER winners,
//     so it can't be flattered by having helped define the band it's measured against;
//   • losers never shaped the corridor at all, so their false-positive rate is already out-of-sample.
// "catches X% of winners at Y% false alarms" reads at a glance; the gap between the two IS the signal.
const W = corr.winners, L = corr.losers;
const perBin = [];
let poolWHit = 0, poolWtot = 0, poolLHit = 0, poolLtot = 0;   // pooled across every age checkpoint for the headline
for (const b of bins) {
  const wv = W.map((t) => trajAt(t, b)).filter((x) => x != null);
  const lv = L.map((t) => trajAt(t, b)).filter((x) => x != null);
  // pooled winner trajectory points in this bin, tagged by token, to rebuild the band leave-one-out
  const wpts = []; for (const w of W) for (const p of (w.path || [])) if (p.a >= b.lo && p.a < b.hi) wpts.push({ sym: w.sym, t: p.t });
  const wtok = W.map((w) => ({ sym: w.sym, t: trajAt(w, b) })).filter((x) => x.t != null);
  let looHit = 0;
  for (const w of wtok) { const others = wpts.filter((p) => p.sym !== w.sym).map((p) => p.t); const q1b = others.length ? pctile(others, 0.25) : b.q1; if (w.t >= q1b) looHit++; }
  const catchLOO = wtok.length ? looHit / wtok.length : null;
  const falsePos = lv.length ? lv.filter((x) => x >= b.q1).length / lv.length : null;
  poolWHit += looHit; poolWtot += wtok.length; poolLHit += lv.filter((x) => x >= b.q1).length; poolLtot += lv.length;
  perBin.push({
    age: `${b.lo}-${b.hi}h`, q1: b.q1,
    nW: wv.length, nL: lv.length,                                  // how many of each class were still alive at this age
    survW: +(wv.length / W.length).toFixed(2), survL: +(lv.length / L.length).toFixed(2),
    medW: wv.length ? Math.round(med(wv)) : null, medL: lv.length ? Math.round(med(lv)) : null,
    onW: wv.length ? +(wv.filter((x) => x >= b.q1).length / wv.length).toFixed(2) : null,  // % winners on/above the band (in-sample)
    onL: lv.length ? +(lv.filter((x) => x >= b.q1).length / lv.length).toFixed(2) : null,  // % losers on/above the band (false positives)
    catchLOO: catchLOO == null ? null : +catchLOO.toFixed(2),                                // % winners caught, HELD-OUT (the honest recall)
    falsePos: falsePos == null ? null : +falsePos.toFixed(2),                                // % losers falsely flagged (out-of-sample by construction)
    auc: auc(wv, lv) == null ? null : +auc(wv, lv).toFixed(2),
  });
}
// one-line headline: pooled across every age checkpoint (per-observation), held-out winners vs out-of-sample losers
const headline = {
  catch: poolWtot ? +(poolWHit / poolWtot).toFixed(2) : null,
  falsePos: poolLtot ? +(poolLHit / poolLtot).toFixed(2) : null,
  winnerObs: poolWtot, loserObs: poolLtot,
  note: "winners held out leave-one-out; losers never shaped the corridor",
};

// A blunt end-to-end read: classify each token by its LATE-LIFE trajectory (last third of its observed path),
// the "did it sustain the path" signal. Sweep a threshold, report the best-separating operating point.
const lateTraj = (t) => { const p = t.path || []; if (p.length < 3) return null; const late = p.slice(Math.floor(p.length * 0.66)); return late.reduce((a, x) => a + x.t, 0) / late.length; };
const wl = W.map(lateTraj).filter((x) => x != null), ll = L.map(lateTraj).filter((x) => x != null);
const lateAuc = auc(wl, ll);
let best = { thr: null, tpr: 0, fpr: 1, youden: -1 };
for (let thr = 40; thr <= 95; thr++) {
  const tpr = wl.filter((x) => x >= thr).length / wl.length, fpr = ll.filter((x) => x >= thr).length / ll.length;
  const y = tpr - fpr; if (y > best.youden) best = { thr, tpr: +tpr.toFixed(2), fpr: +fpr.toFixed(2), youden: +y.toFixed(2) };
}
// survival alone: does the token live past a given age?
const reached = (arr, age) => arr.filter((t) => (t.path || []).some((p) => p.a >= age)).length;
const survivalSignal = [4, 16, 48, 128].map((age) => ({ age: age + "h", winners: +(reached(W, age) / W.length).toFixed(2), losers: +(reached(L, age) / L.length).toFixed(2) }));

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  cohort: { winners: W.length, losers: L.length, note: "in-sample separation on the study cohort — not out-of-sample proof; refresh as more tokens graduate" },
  headline,
  perBin,
  lateLife: { aucWinnerVsLoser: lateAuc == null ? null : +lateAuc.toFixed(2), bestThreshold: best },
  survivalSignal,
};
writeFileSync(new URL("study/validation.json", ROOT), JSON.stringify(out));

// print
const pct = (x) => x == null ? "  —" : (Math.round(x * 100) + "%").padStart(4);
console.log(`\nSIGNAL VALIDATION · ${W.length} winners vs ${L.length} losers (in-sample separation)\n`);
console.log("age bin    alive:W/L   median traj W/L   on-band W/L   AUC   read");
for (const r of perBin) {
  const sep = r.auc == null ? "—" : r.auc >= 0.75 ? "STRONG" : r.auc >= 0.65 ? "useful" : r.auc >= 0.55 ? "weak" : "≈coin-flip";
  console.log(`  ${r.age.padEnd(8)} ${(r.nW + "/" + r.nL).padStart(6)}     ${String(r.medW ?? "—").padStart(3)} / ${String(r.medL ?? "—").padEnd(3)}        ${pct(r.onW)}/${pct(r.onL)}   ${r.auc == null ? " — " : r.auc.toFixed(2)}  ${sep}`);
}
console.log(`\nlate-life trajectory (did it SUSTAIN the path): AUC ${lateAuc == null ? "—" : lateAuc.toFixed(2)}`);
console.log(`  best operating point: traj ≥ ${best.thr} → catches ${pct(best.tpr)} of winners, ${pct(best.fpr)} false-positive on losers`);
console.log("\nsurvival alone (reached age at all):");
for (const s of survivalSignal) console.log(`  past ${s.age.padEnd(4)}  winners ${pct(s.winners)}  losers ${pct(s.losers)}`);
console.log("\n→ study/validation.json written");
