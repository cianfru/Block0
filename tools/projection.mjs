// Build the PROJECTION model: from the winners' reconstructed (unique-wallets → market-cap) curves, a valuation
// LADDER — at each wallet stage, what were the winners worth — plus each winner's path and the losers' actual
// endpoints (survivorship reality). A token at W wallets reads its winner-precedent valuation + forward path.
import { writeFileSync } from "node:fs";
import { loadCohort, STUDY_DIR } from "./cohort-lib.mjs";
const pctile = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); if (!s.length) return 0; const i = (s.length - 1) * p; const l = Math.floor(i), h = Math.ceil(i); return l === h ? s[l] : s[l] + (s[h] - s[l]) * (i - l); };

// cohort = study/cohort.json outcome labels: winners are runner+major (held a real valuation), live caps from the index
const cohort = loadCohort();
const winners = [];
for (const r of cohort.winners) {
  // clean, monotonic-ish points: unique wallets vs market cap (drop nulls / zero)
  const pts = r.series.filter((p) => p.mcap > 0 && p.wallets > 0).map((p) => ({ w: p.wallets, m: p.mcap, a: +((p.t - r.t0) / 3600).toFixed(2), v: p.volUsd || 0 }));
  if (pts.length < 6) { console.log("skip", r.sym, "too few priced points"); continue; }
  winners.push({ sym: r.sym, addr: r.addr, label: r.meta.label, supply: r.supply, curMc: r.meta.curMcap || null, heldPeak: r.meta.heldPeak, wEnd: pts[pts.length - 1].w, mEnd: pts[pts.length - 1].m, path: pts });
}

// valuation ladder: at each wallet stage, the winners' market-cap distribution
const STAGES = [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];
const ladder = [];
for (const W of STAGES) {
  const mc = [], vol = [];
  for (const t of winners) {
    // the winner's mcap + per-bucket volume at ~W wallets (nearest point at or before W)
    const at = t.path.filter((p) => p.w <= W);
    if (at.length && t.wEnd >= W * 0.6) { mc.push(at[at.length - 1].m); if (at[at.length - 1].v > 0) vol.push(at[at.length - 1].v); }
  }
  if (mc.length >= 3) ladder.push({ wallets: W, n: mc.length, p25: Math.round(pctile(mc, 0.25)), med: Math.round(pctile(mc, 0.5)), p75: Math.round(pctile(mc, 0.75)), vol: vol.length ? Math.round(pctile(vol, 0.5)) : null });
}

// controls' actual outcomes: (peak holders, current mcap, kind) — where the field really ended up
const losers = cohort.controls.map((r) => ({ sym: r.sym, addr: r.addr, w: r.meta.peakHolders || Math.max(...r.series.map((p) => p.holders || 0)), m: r.meta.curMcap || 0, peak: r.meta.heldPeak || 0, kind: r.kind })).filter((l) => l.w > 0);

// downsample winner paths for the chart
const thin = (p) => { const s = Math.max(1, Math.floor(p.length / 40)); return p.filter((_, i) => i % s === 0 || i === p.length - 1); };
writeFileSync(`${STUDY_DIR}/projection_data.json`, JSON.stringify({
  generatedAt: new Date().toISOString().slice(0, 10), cohort: { winners: winners.length, controls: losers.length },
  ladder, losers,
  winners: winners.map((t) => ({ sym: t.sym, addr: t.addr, label: t.label, curMc: t.curMc, heldPeak: t.heldPeak, wEnd: t.wEnd, mEnd: t.mEnd, path: thin(t.path) })),
}, null, 0));

const $ = (x) => x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
console.log("VALUATION LADDER (winner market cap by unique-wallet stage):");
console.log("wallets   p25      median    p75     (n winners)");
for (const l of ladder) console.log(`  ${String(l.wallets).padStart(5)}   ${$(l.p25).padStart(7)}  ${$(l.med).padStart(7)}  ${$(l.p75).padStart(7)}   (${l.n})`);
console.log("\nwinners (window end wallets → mcap | today):");
for (const t of winners) console.log(`  ${t.sym.padEnd(11)} ${String(t.wEnd).padStart(5)} wallets → ${$(t.mEnd).padStart(7)}  | today ${$(t.curMc)}`);
console.log("\nlosers actual outcome (peak wallets → current mcap):");
for (const t of losers.sort((a, b) => b.m - a.m)) console.log(`  ${t.sym.padEnd(11)} ${String(t.w).padStart(5)} → ${$(t.m)} (${t.kind})`);
