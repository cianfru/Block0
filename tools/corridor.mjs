// Build the LAUNCH CORRIDOR: for each profiled token, a per-age Trajectory Score = distribution HEALTH
// (blueprint) blended with real DEMAND (wallet inflow + adoption depth). Then the winner ENVELOPE by age bin
// (the healthy zone), and every token's path through it. Winners thread the green corridor; losers fall out.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const pctile = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); if (!s.length) return 0; const i = (s.length - 1) * p; const l = Math.floor(i), h = Math.ceil(i); return l === h ? s[l] : s[l] + (s[h] - s[l]) * (i - l); };

const bpMatch = ({ bundles, top10, holders, risk }) => {
  let s = 0;
  s += bundles === 0 ? 40 : bundles === 1 ? 12 : 0;
  s += top10 <= 40 ? 25 : top10 <= 60 ? 16 : top10 <= 80 ? 7 : 0;
  s += risk < 25 ? 20 : risk < 45 ? 10 : 0;
  s += holders >= 200 ? 15 : holders >= 80 ? 10 : holders >= 30 ? 5 : 0;
  return clamp(s);
};
// demand: adoption depth (log holders) + recent wallet-inflow rate
const demandScore = (holders, inflowPerHr) => clamp(Math.min(55, 18 * Math.log10(holders + 1)) + Math.min(45, inflowPerHr * 1.3));

function loadDir(dir, cls) {
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const r = JSON.parse(readFileSync(dir + "/" + f, "utf8"));
    if (r.error || !r.series?.length) continue;
    const s = r.series, t0 = r.t0, bundles = r.bundles;
    const pts = [];
    for (let i = 0; i < s.length; i++) {
      const p = s[i], ageH = Math.max(0.02, (p.t - t0) / 3600);
      // inflow rate over a short trailing window (~3 buckets)
      const j = Math.max(0, i - 3), dt = Math.max(0.05, (s[i].t - s[j].t) / 3600), dH = s[i].holders - s[j].holders;
      const inflow = dH / dt;
      const health = bpMatch({ bundles, top10: p.top10, holders: p.holders, risk: p.risk });
      const demand = demandScore(p.holders, Math.max(0, inflow));
      const traj = Math.round(0.5 * health + 0.5 * demand);
      pts.push({ ageH: +ageH.toFixed(3), traj, health, demand: Math.round(demand), holders: p.holders, top10: p.top10, risk: p.risk, inflow: +Math.max(0, inflow).toFixed(1) });
    }
    // smooth the trajectory (the score has discrete bands, so raw it flickers) — centred moving average, w=5
    const raw = pts.map((p) => p.traj);
    pts.forEach((p, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - 2); k <= Math.min(pts.length - 1, i + 2); k++) { s += raw[k]; n++; } p.traj = Math.round(s / n); });
    out.push({ sym: r.sym, cls, mcapUsd: r.mcapUsd || 0, bundles, hours: +((r.t1 - r.t0) / 3600).toFixed(1), pts });
  }
  return out;
}

const winners = loadDir("profiles", "winner");
let losers = loadDir("losers", "dead");
try { const L = JSON.parse(readFileSync("losers.json", "utf8")); const km = {}; for (const t of [...L.dead, ...L.faded]) km[t.sym.replace(/\s+/g, "_")] = t.kind; losers = losers.map((w) => ({ ...w, cls: km[w.sym] || "dead" })); } catch {}

// age bins (hours), log-spaced-ish
const EDGES = [0, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 600];
const bins = [];
for (let b = 0; b < EDGES.length - 1; b++) {
  const lo = EDGES[b], hi = EDGES[b + 1], mid = Math.sqrt(Math.max(0.25, lo) * hi);
  const wv = [];
  for (const w of winners) for (const p of w.pts) if (p.ageH >= lo && p.ageH < hi) wv.push(p.traj);
  if (wv.length < 3) continue;
  bins.push({ lo, hi, mid: +mid.toFixed(2), n: wv.length,
    p10: Math.round(pctile(wv, 0.1)), q1: Math.round(pctile(wv, 0.25)), med: Math.round(pctile(wv, 0.5)), q3: Math.round(pctile(wv, 0.75)), p90: Math.round(pctile(wv, 0.9)) });
}
// downsample each token path to ~40 pts for the chart
const thin = (pts) => { const step = Math.max(1, Math.floor(pts.length / 40)); return pts.filter((_, i) => i % step === 0 || i === pts.length - 1); };
const outTok = (arr) => arr.map((w) => ({ sym: w.sym, cls: w.cls, mcapUsd: w.mcapUsd, hours: w.hours, path: thin(w.pts).map((p) => ({ a: p.ageH, t: p.traj, h: p.holders, c: p.top10 })) }));

writeFileSync("study/corridor_data.json", JSON.stringify({ bins, winners: outTok(winners), losers: outTok(losers) }, null, 0));

// debug
console.log("age bin        winners: p10  q1  med  q3  p90   (n)");
for (const b of bins) console.log(`  ${(b.lo + "–" + b.hi + "h").padEnd(12)}          ${String(b.p10).padStart(3)} ${String(b.q1).padStart(3)} ${String(b.med).padStart(3)} ${String(b.q3).padStart(3)} ${String(b.p90).padStart(3)}   (${b.n})`);
const trajAt = (tok, loH, hiH) => { const v = tok.pts.filter((p) => p.ageH >= loH && p.ageH < hiH).map((p) => p.traj); return v.length ? Math.round(v.reduce((a, x) => a + x, 0) / v.length) : null; };
console.log("\nlate-window trajectory (last third of each token's life):");
for (const w of [...winners, ...losers]) { const late = w.pts.slice(Math.floor(w.pts.length * 0.66)); const m = Math.round(late.reduce((a, p) => a + p.traj, 0) / late.length); console.log(`  ${w.sym.padEnd(11)} ${w.cls.padEnd(7)} traj ${String(m).padStart(3)}  (holders→${w.pts[w.pts.length-1].holders}, top10→${w.pts[w.pts.length-1].top10}%)`); }
