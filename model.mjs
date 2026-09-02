// The baked winner-study model — the VALUATION LADDER (unique wallets → market cap) from the top-graduated
// cohort, used to place a LIVE token against the winners' precedent in real time. model.json is regenerated
// from the backtest study (tools/gen-model); if it's missing the helpers no-op so the board still runs.
import { readFileSync } from "node:fs";
let LADDER = [], CORRIDOR = [];
try { const m = JSON.parse(readFileSync(new URL("./model.json", import.meta.url), "utf8")); LADDER = m.ladder || []; CORRIDOR = m.corridor || []; } catch { /* no model yet */ }
const log10 = Math.log10;
const clamp = (x) => Math.max(0, Math.min(100, x));

// live TRAJECTORY score for a token at a given age = distribution health (blueprint) blended with real demand
// (adoption depth + average wallet inflow over its life) — the same score the launch-corridor study is built on.
export function liveTrajectory({ blueprint = 0, holders = 0, ageH = 0 }) {
  const inflow = ageH > 0 ? holders / ageH : holders; // avg unique wallets/hr — a live proxy for the study's trailing rate
  const demand = clamp(Math.min(55, 18 * log10(holders + 1)) + Math.min(45, inflow * 1.3));
  return Math.round(0.5 * blueprint + 0.5 * demand);
}
// where that score sits vs the winner corridor's healthy zone at this age
export function corridorStatus(ageH, traj) {
  if (!CORRIDOR.length) return null;
  const b = CORRIDOR.find((x) => ageH >= x.lo && ageH < x.hi) || CORRIDOR[CORRIDOR.length - 1];
  const status = traj < 35 ? "failing" : traj >= b.q1 ? "on-track" : "behind";
  return { traj, zoneLo: b.q1, zoneHi: b.q3, med: b.med, status };
}

// winner-precedent market cap at a given unique-wallet count (log-interpolated across the ladder rungs)
export function precedentValuation(wallets) {
  const L = LADDER; if (!L.length || !wallets) return null;
  if (wallets <= L[0].wallets) return { wallets, p25: L[0].p25, med: L[0].med, p75: L[0].p75, vol: L[0].vol };
  if (wallets >= L[L.length - 1].wallets) { const b = L[L.length - 1]; return { wallets, p25: b.p25, med: b.med, p75: b.p75, vol: b.vol }; }
  for (let i = 1; i < L.length; i++) {
    if (wallets <= L[i].wallets) {
      const a = L[i - 1], b = L[i], f = (log10(wallets) - log10(a.wallets)) / (log10(b.wallets) - log10(a.wallets));
      const ip = (x, y) => Math.round(10 ** (log10(x) + (log10(y) - log10(x)) * f));
      return { wallets, p25: ip(a.p25, b.p25), med: ip(a.med, b.med), p75: ip(a.p75, b.p75), vol: a.vol && b.vol ? ip(a.vol, b.vol) : null };
    }
  }
  const b = L[L.length - 1]; return { wallets, p25: b.p25, med: b.med, p75: b.p75, vol: b.vol };
}

// where a live token's (wallets, market cap) sits versus the winner valuation band at its stage
export function pathPosition(wallets, mcap) {
  const p = precedentValuation(wallets);
  if (!p || !mcap) return null;
  const pos = mcap >= p.p75 ? "ahead" : mcap >= p.p25 ? "on-path" : mcap >= p.p25 / 3 ? "lagging" : "off-path";
  return { precedent: p.med, p25: p.p25, p75: p.p75, vol: p.vol, ratio: +(mcap / p.med).toFixed(2), pos };
}
// the raw study artifacts, for drawing the corridor cone + ladder on the token page
export const corridorBins = () => CORRIDOR;
export const ladderRungs = () => LADDER;
export const hasModel = () => LADDER.length > 0;
