// validate — does the winner-corridor signal actually SEPARATE winners from the rest, and WHEN?
//
// Cohort (study/cohort.json, outcome labels — graduation is not a criterion):
//   winners  = runner + major (reached ≥$1M and HELD it)
//   controls = faded (reached the same stages, then collapsed — the PRIMARY control, the one a scanner must catch)
//            + stalled / dead (never got there)
// Three honesty layers, all reported:
//   • in-sample separation per age bin (AUC vs ALL controls and vs FADED only — faded is the hard test);
//   • winners scored LEAVE-ONE-OUT against a band rebuilt from the other winners; controls never shaped the band;
//   • a TIME SPLIT: the band is fitted on tokens launched before a cutoff and graded on the later ones only —
//     the closest thing to out-of-sample a two-month-old chain allows. Reported as null (with the reason) when
//     the later slice is too small to say anything, never fabricated.
// Run:  node tools/validate.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STUDY_DIR, loadIndex } from "./cohort-lib.mjs";
const rd = (f) => JSON.parse(readFileSync(join(STUDY_DIR, f), "utf8"));
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctile = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); if (!s.length) return 0; const i = (s.length - 1) * p; const l = Math.floor(i), h = Math.ceil(i); return l === h ? s[l] : s[l] + (s[h] - s[l]) * (i - l); };
const r2 = (x) => x == null ? null : +x.toFixed(2);

const corr = rd("corridor_data.json"); // { bins, winners:[{path:[{a,t}], cls, t0}], losers:[...] }
const idx = loadIndex();
const bins = corr.bins.map((b) => ({ lo: b.lo, hi: b.hi, q1: b.q1 }));

// a token's trajectory at an age bin = mean of its path points inside the bin (null if it never reached that age)
const trajAt = (tok, b) => { const v = (tok.path || []).filter((p) => p.a >= b.lo && p.a < b.hi).map((p) => p.t); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
// AUC via all-pairs (Mann–Whitney): fraction of (winner,loser) pairs where winner ranks strictly higher (+½ ties)
function auc(pos, neg) { if (!pos.length || !neg.length) return null; let c = 0; for (const p of pos) for (const n of neg) c += p > n ? 1 : p === n ? 0.5 : 0; return c / (pos.length * neg.length); }
// the corridor's lower band (q1) for a bin, rebuilt from a given winner set
const q1Of = (ws, b) => { const pts = []; for (const w of ws) for (const p of (w.path || [])) if (p.a >= b.lo && p.a < b.hi) pts.push(p.t); return pts.length >= 3 ? pctile(pts, 0.25) : null; };

const W = corr.winners, L = corr.losers, LF = L.filter((t) => t.cls === "faded");
const perBin = [];
let poolWHit = 0, poolWtot = 0, poolLHit = 0, poolLtot = 0, poolFHit = 0, poolFtot = 0;
for (const b of bins) {
  const wv = W.map((t) => trajAt(t, b)).filter((x) => x != null);
  const lv = L.map((t) => trajAt(t, b)).filter((x) => x != null);
  const fv = LF.map((t) => trajAt(t, b)).filter((x) => x != null);
  // winners graded leave-one-out against a band rebuilt from the OTHER winners
  const wtok = W.map((w) => ({ sym: w.sym, t: trajAt(w, b) })).filter((x) => x != null);
  let looHit = 0;
  for (const w of wtok) { const q1b = q1Of(W.filter((x) => x.sym !== w.sym), b) ?? b.q1; if (w.t >= q1b) looHit++; }
  const catchLOO = wtok.length ? looHit / wtok.length : null;
  const falsePos = lv.length ? lv.filter((x) => x >= b.q1).length / lv.length : null;
  const falsePosFaded = fv.length ? fv.filter((x) => x >= b.q1).length / fv.length : null;
  poolWHit += looHit; poolWtot += wtok.length; poolLHit += lv.filter((x) => x >= b.q1).length; poolLtot += lv.length;
  poolFHit += fv.filter((x) => x >= b.q1).length; poolFtot += fv.length;
  perBin.push({
    age: `${b.lo}-${b.hi}h`, q1: b.q1,
    nW: wv.length, nL: lv.length, nF: fv.length,                  // how many of each class were still alive at this age
    survW: r2(wv.length / (W.length || 1)), survL: r2(lv.length / (L.length || 1)), survF: r2(fv.length / (LF.length || 1)),
    medW: wv.length ? Math.round(med(wv)) : null, medL: lv.length ? Math.round(med(lv)) : null, medF: fv.length ? Math.round(med(fv)) : null,
    onW: wv.length ? r2(wv.filter((x) => x >= b.q1).length / wv.length) : null,  // % winners on/above the band (in-sample)
    onL: falsePos == null ? null : r2(falsePos),                                  // % controls on/above the band (false positives)
    catchLOO: r2(catchLOO), falsePos: r2(falsePos), falsePosFaded: r2(falsePosFaded),
    auc: r2(auc(wv, lv)), aucFaded: r2(auc(wv, fv)),
  });
}
const headline = {
  catch: poolWtot ? r2(poolWHit / poolWtot) : null,
  falsePos: poolLtot ? r2(poolLHit / poolLtot) : null,
  falsePosFaded: poolFtot ? r2(poolFHit / poolFtot) : null,
  winnerObs: poolWtot, loserObs: poolLtot, fadedObs: poolFtot,
  note: "winners held out leave-one-out; controls never shaped the corridor; falsePosFaded = tokens that reached the same stages and collapsed",
};

// late-life read: classify each token by its LATE-LIFE trajectory (last third of its observed path) — "did it sustain
// the path". Sweep a threshold, report the best-separating operating point, vs all controls and vs faded only.
const lateTraj = (t) => { const p = t.path || []; if (p.length < 3) return null; const late = p.slice(Math.floor(p.length * 0.66)); return late.reduce((a, x) => a + x.t, 0) / late.length; };
const wl = W.map(lateTraj).filter((x) => x != null), ll = L.map(lateTraj).filter((x) => x != null), fl = LF.map(lateTraj).filter((x) => x != null);
function bestPoint(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let best = { thr: null, tpr: 0, fpr: 1, youden: -1 };
  for (let thr = 40; thr <= 95; thr++) { const tpr = pos.filter((x) => x >= thr).length / pos.length, fpr = neg.filter((x) => x >= thr).length / neg.length; const y = tpr - fpr; if (y > best.youden) best = { thr, tpr: r2(tpr), fpr: r2(fpr), youden: r2(y) }; }
  return best;
}
const lateLife = { aucWinnerVsLoser: r2(auc(wl, ll)), aucWinnerVsFaded: r2(auc(wl, fl)), bestThreshold: bestPoint(wl, ll), bestThresholdFaded: bestPoint(wl, fl) };

// PRECISION + BASE RATE — the honest counterweight to recall (ChatGPT #5). Winners are RARE, so even a low false-
// positive rate leaves most "on-path" tokens fading. Precision = of everything the band flags, how many were winners;
// lift = precision ÷ base rate (how much better than the prior). AUC/recall alone hide this; on a 6%-base-rate problem
// they must be read WITH precision or they flatter.
const baseRate = (W.length + L.length) ? W.length / (W.length + L.length) : null;
const precisionAt = (thr) => { const tp = wl.filter((x) => x >= thr).length, fp = ll.filter((x) => x >= thr).length;
  const prec = (tp + fp) ? tp / (tp + fp) : null; return { thr, tp, fp, precision: r2(prec), lift: (prec != null && baseRate) ? r2(prec / baseRate) : null }; };
const bt = lateLife.bestThreshold;
const precision = { baseRate: r2(baseRate), winners: W.length, controls: L.length,
  atBestPoint: bt ? precisionAt(bt.thr) : null,
  note: baseRate != null ? `winners are ${Math.round(baseRate * 100)}% of the graded cohort — a rare event. Precision is TP/(TP+FP) at the operating point; lift is precision ÷ base rate (1.0 = no better than the prior).` : "no base rate yet" };

// CALIBRATION — does a higher trajectory actually mean a higher observed win-rate? Bucket the late-life score and
// report the fraction of winners among {winners ∪ controls} in each band. Monotone-rising = the score means something.
const calibBands = [[0, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
const wlTok = W.map((t) => ({ v: lateTraj(t), win: 1 })).concat(L.map((t) => ({ v: lateTraj(t), win: 0 }))).filter((x) => x.v != null);
const calibration = calibBands.map(([lo, hi]) => { const inb = wlTok.filter((x) => x.v >= lo && x.v < hi); const w = inb.filter((x) => x.win).length;
  return { band: `${lo}–${hi > 100 ? "100" : hi}`, n: inb.length, winRate: inb.length ? r2(w / inb.length) : null }; });

// MISSES — name them. At the late-life operating point: winners the band DROPPED (false negatives) and controls it
// FLAGGED (false positives). The honest ledger — every model has these; hiding them is the dishonesty. Sorted worst-first.
let misses = null;
if (bt) { const thr = bt.thr;
  const fn = W.map((t) => ({ sym: t.sym, cls: t.cls, heldPeak: t.heldPeak, v: lateTraj(t) })).filter((x) => x.v != null && x.v < thr).sort((a, b) => a.v - b.v);
  const fp = L.map((t) => ({ sym: t.sym, cls: t.cls, heldPeak: t.heldPeak, v: lateTraj(t) })).filter((x) => x.v != null && x.v >= thr).sort((a, b) => b.v - a.v);
  misses = { thr,
    falseNeg: { n: fn.length, of: wl.length, tokens: fn.slice(0, 12).map((x) => ({ sym: x.sym, traj: Math.round(x.v), heldPeak: x.heldPeak })) },
    falsePos: { n: fp.length, of: ll.length, tokens: fp.slice(0, 12).map((x) => ({ sym: x.sym, cls: x.cls, traj: Math.round(x.v), heldPeak: x.heldPeak })) },
    note: "false negatives = winners scoring below the operating point (the band would have passed on them); false positives = faded/dead tokens scoring above it (the band would have called them on-path). This is the cost of the operating point above." };
}

// survival alone: does the token live past a given age?
const reached = (arr, age) => arr.filter((t) => (t.path || []).some((p) => p.a >= age)).length;
const survivalSignal = [4, 16, 48, 128].map((age) => ({ age: age + "h", winners: r2(reached(W, age) / (W.length || 1)), losers: r2(reached(L, age) / (L.length || 1)), faded: r2(reached(LF, age) / (LF.length || 1)) }));

// TIME SPLIT — fit on the earlier launches, grade the later ones. Cutoff = the launch date that leaves the latest 30%
// of winners as the test slice; controls launched after the cutoff are the test negatives.
const MIN_TEST = 5;
const t0Of = (t) => t.t0 || (t.launchedAt ? Date.parse(t.launchedAt) / 1000 : null);
const Wd = W.filter((t) => t0Of(t)).sort((a, b) => t0Of(a) - t0Of(b));
let timeSplit = { ready: false, reason: "not enough dated winners" };
if (Wd.length >= MIN_TEST * 2) {
  const cutIdx = Math.floor(Wd.length * 0.7), cutoff = t0Of(Wd[cutIdx]);
  const train = Wd.slice(0, cutIdx), test = Wd.slice(cutIdx), testL = L.filter((t) => t0Of(t) && t0Of(t) >= cutoff), testF = testL.filter((t) => t.cls === "faded");
  if (test.length >= MIN_TEST && testL.length >= MIN_TEST) {
    let hit = 0, tot = 0, lhit = 0, ltot = 0, fhit = 0, ftot = 0; const rows = [];
    for (const b of bins) {
      const q1 = q1Of(train, b); if (q1 == null) continue;
      const tw = test.map((t) => trajAt(t, b)).filter((x) => x != null), tl = testL.map((t) => trajAt(t, b)).filter((x) => x != null), tf = testF.map((t) => trajAt(t, b)).filter((x) => x != null);
      hit += tw.filter((x) => x >= q1).length; tot += tw.length; lhit += tl.filter((x) => x >= q1).length; ltot += tl.length; fhit += tf.filter((x) => x >= q1).length; ftot += tf.length;
      rows.push({ age: `${b.lo}-${b.hi}h`, q1Train: Math.round(q1), nW: tw.length, nL: tl.length, catch: tw.length ? r2(tw.filter((x) => x >= q1).length / tw.length) : null, falsePos: tl.length ? r2(tl.filter((x) => x >= q1).length / tl.length) : null, auc: r2(auc(tw, tl)) });
    }
    const twl = test.map(lateTraj).filter((x) => x != null), tll = testL.map(lateTraj).filter((x) => x != null);
    timeSplit = { ready: true, cutoff: new Date(cutoff * 1000).toISOString().slice(0, 10), trainWinners: train.length, testWinners: test.length, testControls: testL.length, testFaded: testF.length,
      catch: tot ? r2(hit / tot) : null, falsePos: ltot ? r2(lhit / ltot) : null, falsePosFaded: ftot ? r2(fhit / ftot) : null, lateAuc: r2(auc(twl, tll)), perBin: rows,
      note: "band fitted on winners launched before the cutoff; graded only on tokens launched after it" };
  } else timeSplit = { ready: false, reason: `later slice too small (${test.length} winners / ${testL.length} controls after the cutoff; need ${MIN_TEST} each)` };
}

const counts = idx?.counts || {};
const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  cohort: { winners: W.length, losers: L.length, faded: LF.length, counts, undecided: (counts.pending || 0) + (counts.mid || 0),
    definitions: idx?.definitions || null, rules: idx?.rules || null, basis: "outcome labels — winners held ≥$1M for a week or more; graduation is not a criterion",
    note: "in-sample separation on the study cohort plus a time-split hold-out — evidence that compounds as more launches settle, not proof" },
  headline, precision, calibration, misses, perBin, lateLife, survivalSignal, timeSplit,
};
writeFileSync(join(STUDY_DIR, "validation.json"), JSON.stringify(out));

// print
const pct = (x) => x == null ? "  —" : (Math.round(x * 100) + "%").padStart(4);
console.log(`\nSIGNAL VALIDATION · ${W.length} winners vs ${L.length} controls (${LF.length} faded) · undecided excluded: ${out.cohort.undecided}\n`);
console.log("age bin    alive:W/L   median traj W/L/F   on-band W/L   AUC all / faded   read");
for (const r of perBin) {
  const a = r.aucFaded ?? r.auc; const sep = a == null ? "—" : a >= 0.75 ? "STRONG" : a >= 0.65 ? "useful" : a >= 0.55 ? "weak" : "≈coin-flip";
  console.log(`  ${r.age.padEnd(8)} ${(r.nW + "/" + r.nL).padStart(7)}     ${String(r.medW ?? "—").padStart(3)} / ${String(r.medL ?? "—").padEnd(3)} / ${String(r.medF ?? "—").padEnd(3)}     ${pct(r.onW)}/${pct(r.onL)}    ${r.auc == null ? " — " : r.auc.toFixed(2)} / ${r.aucFaded == null ? " — " : r.aucFaded.toFixed(2)}   ${sep}`);
}
console.log(`\nlate-life (did it SUSTAIN the path): AUC vs all ${lateLife.aucWinnerVsLoser ?? "—"} · vs faded ${lateLife.aucWinnerVsFaded ?? "—"}`);
if (lateLife.bestThreshold) console.log(`  best operating point (all): traj ≥ ${lateLife.bestThreshold.thr} → catches ${pct(lateLife.bestThreshold.tpr)} of winners, ${pct(lateLife.bestThreshold.fpr)} false-positive`);
if (lateLife.bestThresholdFaded) console.log(`  best operating point (faded): traj ≥ ${lateLife.bestThresholdFaded.thr} → catches ${pct(lateLife.bestThresholdFaded.tpr)} of winners, ${pct(lateLife.bestThresholdFaded.fpr)} false-positive`);
console.log("\nsurvival alone (reached age at all):");
for (const s of survivalSignal) console.log(`  past ${s.age.padEnd(4)}  winners ${pct(s.winners)}  controls ${pct(s.losers)}  faded ${pct(s.faded)}`);
console.log(`\ntime split (FORWARD, out-of-sample by launch date — the honest headline): ${timeSplit.ready ? `cutoff ${timeSplit.cutoff} · train ${timeSplit.trainWinners} winners → test ${timeSplit.testWinners} winners / ${timeSplit.testControls} controls · catch ${pct(timeSplit.catch)} · false-pos ${pct(timeSplit.falsePos)} (faded ${pct(timeSplit.falsePosFaded)}) · late AUC ${timeSplit.lateAuc ?? "—"}` : "not ready — " + timeSplit.reason}`);
console.log(`\nprecision & base rate (winners are rare — recall alone flatters):`);
console.log(`  base rate: ${pct(precision.baseRate)} of the cohort are winners (${precision.winners} vs ${precision.controls})`);
if (precision.atBestPoint) console.log(`  at the operating point traj ≥ ${precision.atBestPoint.thr}: precision ${pct(precision.atBestPoint.precision)} (${precision.atBestPoint.tp} winners / ${precision.atBestPoint.tp + precision.atBestPoint.fp} flagged) · lift ${precision.atBestPoint.lift ?? "—"}×`);
console.log(`\ncalibration (does a higher score mean a higher win-rate?):`);
for (const c of calibration) console.log(`  traj ${c.band.padEnd(7)} n=${String(c.n).padStart(3)}  win-rate ${pct(c.winRate)}`);
if (misses) {
  console.log(`\nmisses at traj ≥ ${misses.thr} — the honest ledger:`);
  console.log(`  false negatives (winners the band would drop): ${misses.falseNeg.n}/${misses.falseNeg.of}  ${misses.falseNeg.tokens.map((x) => `${x.sym}(${x.traj})`).join(" ")}`);
  console.log(`  false positives (faded/dead it would flag on-path): ${misses.falsePos.n}/${misses.falsePos.of}  ${misses.falsePos.tokens.map((x) => `${x.sym}(${x.traj})`).join(" ")}`);
}
console.log(`\n→ ${STUDY_DIR}/validation.json written`);
