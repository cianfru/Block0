// Build the PROJECTION model: from the winners' reconstructed (unique-wallets → market-cap) curves, a valuation
// LADDER — at each wallet stage, what were the winners worth — plus each winner's path and the losers' actual
// endpoints (survivorship reality). A token at W wallets reads its winner-precedent valuation + forward path.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const pctile = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); if (!s.length) return 0; const i = (s.length - 1) * p; const l = Math.floor(i), h = Math.ceil(i); return l === h ? s[l] : s[l] + (s[h] - s[l]) * (i - l); };

// current market caps (today) from the Pons universe snapshots we saved
const currentMc = {};
try { const b = JSON.parse(readFileSync("board.json", "utf8")); for (const r of [...(b.cooking || []), ...(b.graduated || [])]) currentMc[(r.sym || "").toUpperCase()] = r.mcapUsd; } catch {}

const winners = [];
for (const f of readdirSync("winners_full").filter((f) => f.endsWith(".json"))) {
  const r = JSON.parse(readFileSync("winners_full/" + f, "utf8"));
  if (r.error || !r.series?.length) { console.log("skip", f, r.error); continue; }
  // clean, monotonic-ish points: unique wallets vs market cap (drop nulls / zero)
  const pts = r.series.filter((p) => p.mcap > 0 && p.wallets > 0).map((p) => ({ w: p.wallets, m: p.mcap, a: +((p.t - r.t0) / 3600).toFixed(2), v: p.volUsd || 0 }));
  if (pts.length < 6) continue;
  winners.push({ sym: r.sym, supply: r.supply, curMc: currentMc[r.sym.toUpperCase()] || null, wEnd: pts[pts.length - 1].w, mEnd: pts[pts.length - 1].m, path: pts });
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

// losers' actual outcomes: (peak wallets/holders, current mcap) — where the field really ended up
const losers = [];
try {
  const meta = JSON.parse(readFileSync("losers.json", "utf8"));
  const curL = {}; for (const t of [...(meta.dead || []), ...(meta.faded || [])]) curL[t.sym.replace(/\s+/g, "_")] = { mc: t.mcapUsd, kind: t.kind };
  for (const f of readdirSync("losers").filter((f) => f.endsWith(".json"))) {
    const r = JSON.parse(readFileSync("losers/" + f, "utf8")); if (r.error || !r.series?.length) continue;
    const peakH = Math.max(...r.series.map((p) => p.holders));
    const c = curL[r.sym]; if (!c || !peakH) continue;
    losers.push({ sym: r.sym, w: peakH, m: c.mc, kind: c.kind });
  }
} catch {}

// downsample winner paths for the chart
const thin = (p) => { const s = Math.max(1, Math.floor(p.length / 40)); return p.filter((_, i) => i % s === 0 || i === p.length - 1); };
writeFileSync("study/projection_data.json", JSON.stringify({
  ladder, losers,
  winners: winners.map((t) => ({ sym: t.sym, curMc: t.curMc, wEnd: t.wEnd, mEnd: t.mEnd, path: thin(t.path) })),
}, null, 0));

const $ = (x) => x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
console.log("VALUATION LADDER (winner market cap by unique-wallet stage):");
console.log("wallets   p25      median    p75     (n winners)");
for (const l of ladder) console.log(`  ${String(l.wallets).padStart(5)}   ${$(l.p25).padStart(7)}  ${$(l.med).padStart(7)}  ${$(l.p75).padStart(7)}   (${l.n})`);
console.log("\nwinners (window end wallets → mcap | today):");
for (const t of winners) console.log(`  ${t.sym.padEnd(11)} ${String(t.wEnd).padStart(5)} wallets → ${$(t.mEnd).padStart(7)}  | today ${$(t.curMc)}`);
console.log("\nlosers actual outcome (peak wallets → current mcap):");
for (const t of losers.sort((a, b) => b.m - a.m)) console.log(`  ${t.sym.padEnd(11)} ${String(t.w).padStart(5)} → ${$(t.m)} (${t.kind})`);
