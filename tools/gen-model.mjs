// gen-model — assemble the live model (public model.json) from the winner-study outputs.
//
// THE PIPELINE (all reproducible from public chain data):
//   1. tools/corridor.mjs   → study/corridor_data.json    (per-age trajectory envelope: winner q1/med/q3 by age bin)
//   2. tools/projection.mjs → study/projection_data.json  (valuation ladder + each winner's wallets/mcap-by-age path)
//   3. tools/gen-model.mjs  (this) → model.json           (ladder + corridor, WITH the concrete per-stage targets)
//
// Steps 1–2 consume the cohort BACKTESTS (one backtest() per winner/loser token — needs an RPC, so they run
// offline, not in the deploy). This step is pure data-join: it reads the two committed study JSONs and writes the
// model the server loads. The join is the important part — it is what puts the wallet/market-cap TARGETS on the
// corridor, so a model refresh can never silently drop them (the bug that prompted committing this).
//
// Run:  node tools/gen-model.mjs        (from the scanner root; reads study/, writes model.json)
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const rd = (f) => JSON.parse(readFileSync(new URL(f, ROOT), "utf8"));
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const MIN_N = 4; // a bin needs ≥ this many winner samples before we state a target — otherwise it stays null (never fabricated)

const proj = rd("study/projection_data.json"); // { ladder, winners:[{path:[{w,m,a}]}], losers }
const corr = rd("study/corridor_data.json");   // { bins:[{lo,hi,q1,med,q3,...}], winners, losers }

// ladder: winner market cap by unique-wallet stage (drop the working `n` count)
const ladder = proj.ladder.map((l) => ({ wallets: l.wallets, p25: l.p25, med: l.med, p75: l.p75, vol: l.vol ?? null }));

// corridor: the trajectory envelope by age bin + the CONCRETE STAGE TARGET (median winner wallets & mcap at that age).
// For each bin we take, per winner, its path point nearest the bin midpoint (within the bin, else a close neighbour so
// we don't invent a stage the winner never reached), then the median across winners — gated to MIN_N samples.
const clamp = (v) => Math.max(0, Math.min(100, v));
const corridor = corr.bins.map((b) => {
  const mid = b.mid ?? (b.lo + b.hi) / 2, ws = [], ms = [];
  for (const w of proj.winners) {
    const inBin = (w.path || []).filter((p) => p.a >= b.lo && p.a < b.hi);
    let pick = inBin.length ? inBin.sort((x, y) => Math.abs(x.a - mid) - Math.abs(y.a - mid))[0] : null;
    if (!pick) { const near = (w.path || []).filter((p) => Math.abs(p.a - mid) <= (b.hi - b.lo)); if (near.length) pick = near.sort((x, y) => Math.abs(x.a - mid) - Math.abs(y.a - mid))[0]; }
    if (pick) { if (pick.w > 0) ws.push(pick.w); if (pick.m > 0) ms.push(pick.m); }
  }
  // trajectory mean ± 1 standard deviation across the winners that were live in this age bin — the smooth CONE the
  // chart draws (a real ±1σ band, clamped to the 0–100 score, rather than the old discrete quartile boxes).
  const traj = [];
  for (const w of corr.winners) for (const p of (w.path || [])) if (p.a >= b.lo && p.a < b.hi && p.t != null) traj.push(p.t);
  const n = traj.length, mean = n ? traj.reduce((a, v) => a + v, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(traj.reduce((a, v) => a + (v - mean) ** 2, 0) / n) : 0;
  return {
    lo: b.lo, hi: b.hi, mid, q1: b.q1, med: b.med, q3: b.q3,
    mean: mean == null ? null : Math.round(mean * 10) / 10,      // cone centre-line
    sd: Math.round(sd * 10) / 10,                                 // ±1σ half-width
    band: mean == null ? null : [Math.round(clamp(mean - sd)), Math.round(clamp(mean + sd))], // the drawn cone band
    n_band: n,
    n_tgt: ws.length,
    tw: ws.length >= MIN_N ? Math.round(med(ws)) : null, // target unique-wallet count (median winner at this age)
    tm: ms.length >= MIN_N ? Math.round(med(ms)) : null, // target market cap (median winner at this age)
  };
});

const model = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "winner-study: top graduated cohort backtests (corridor.mjs + projection.mjs)",
  ladder, corridor,
};
writeFileSync(new URL("model.json", ROOT), JSON.stringify(model));

// summary
const $ = (x) => x == null ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x);
console.log(`model.json written · ${ladder.length} ladder rungs · ${corridor.length} corridor bins`);
console.log("age bin     traj q1–q3   target wallets   target mcap   (n)");
for (const c of corridor) console.log(`  ${(c.lo + "–" + c.hi + "h").padEnd(10)} ${String(c.q1).padStart(3)}–${String(c.q3).padStart(3)}      ${String(c.tw ?? "—").padStart(8)}       ${$(c.tm).padStart(7)}    (${c.n_tgt})`);
