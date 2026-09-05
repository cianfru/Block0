// The baked winner-study model — the VALUATION LADDER (unique wallets → market cap) from the top-graduated
// cohort, used to place a LIVE token against the winners' precedent in real time. model.json is regenerated
// from the backtest study (tools/gen-model); if it's missing the helpers no-op so the board still runs.
import { readFileSync } from "node:fs";
let LADDER = [], CORRIDOR = [], WINNER_VENUES = null;
try { const m = JSON.parse(readFileSync(new URL("./model.json", import.meta.url), "utf8")); LADDER = m.ladder || []; CORRIDOR = m.corridor || []; WINNER_VENUES = m.cohort?.winnerVenues || null; } catch { /* no model yet */ }
export const winnerVenues = () => WINNER_VENUES;
const log10 = Math.log10;
const clamp = (x) => Math.max(0, Math.min(100, x));

// live TRAJECTORY score for a token at a given age = distribution health (blueprint) blended with real demand
// (adoption depth + average wallet inflow over its life) — the same score the launch-corridor study is built on.
export function liveTrajectory({ blueprint = 0, holders = 0, ageH = 0 }) {
  const inflow = ageH > 0 ? holders / ageH : holders; // avg unique wallets/hr — a live proxy for the study's trailing rate
  const demand = clamp(Math.min(55, 18 * log10(holders + 1)) + Math.min(45, inflow * 1.3));
  return Math.round(0.5 * blueprint + 0.5 * demand);
}
// where a token sits vs the winner corridor at this age — on TWO honest axes that must agree:
//   • SHAPE  — the trajectory score (clean distribution + arrival rate) vs the winners' score cone;
//   • ADOPTION — the ABSOLUTE wallets + market cap vs where winners actually were at this age (the gate).
// The shape score saturates on any clean young launch (a fresh token trivially maxes the arrival-rate term), so it
// can read "above the winners" while the token has a fraction of the winners' wallets/mcap. Reporting only the shape
// was the "numbers don't match" bug: a token 4× below the winners' wallet floor read "on the winner path". We now
// gate the headline on adoption too — a clean shape can't claim on-track while adoption is well below the pace.
export function corridorStatus(ageH, traj, { wallets = 0, mcap = 0 } = {}) {
  if (!CORRIDOR.length) return null;
  const b = CORRIDOR.find((x) => ageH >= x.lo && ageH < x.hi) || CORRIDOR[CORRIDOR.length - 1];
  const shape = traj < 35 ? "failing" : traj >= b.q1 ? "on-track" : "behind";
  const walletFloor = b.twLo || 0, mcapMed = b.tm || 0;
  // adoption vs the winners' actual pace: below half the wallet floor OR under a quarter of the median mcap = lagging
  const lagging = (walletFloor && wallets && wallets < walletFloor * 0.5) || (mcapMed && mcap && mcap < mcapMed * 0.25);
  const ahead = (walletFloor && wallets >= walletFloor) || (mcapMed && mcap >= mcapMed);
  const adoption = lagging ? "lagging" : ahead ? "keeping-pace" : "early";
  // combined verdict — the concrete numbers govern: a clean shape over a lagging float is NOT "on the winner path"
  let status = shape;
  if (shape === "on-track" && adoption === "lagging") status = "adoption-behind";
  return { traj, zoneLo: b.q1, zoneHi: b.q3, med: b.med, status, shape, adoption,
    walletFloor: walletFloor || null, mcapMed: mcapMed || null, wallets: wallets || null, mcap: mcap || null };
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

// how much to TRUST this read — uncertainty as a first-class output, never a silent neutral. A very new token, a thin
// holder base, sparse transfer coverage, or a stage with few comparable winners all LOWER confidence — the read is
// still shown, but stamped so "unknown" can't masquerade as "clean". Pure + unit-tested; every reason is a plain fact.
//   level: "high" | "limited" | "low"   reasons: short human strings   nWinners: comparable winners at this age
export function readConfidence({ ageH = 0, holders = 0, events = null, priceReconstructed = true, venue = null } = {}) {
  const reasons = [];
  // comparable winners at this age (the corridor bin's target count) — the resemblance read leans on this many examples
  const bin = CORRIDOR.find((x) => ageH >= x.lo && ageH < x.hi) || CORRIDOR[CORRIDOR.length - 1];
  const nWinners = bin ? (bin.n_tgt ?? bin.nW ?? null) : null;
  const RANK = { high: 0, limited: 1, low: 2 }, NAME = ["high", "limited", "low"];
  let sev = 0;
  const drop = (to) => { sev = Math.max(sev, RANK[to]); };
  if (ageH < 1)        { reasons.push(`only ${Math.max(1, Math.round(ageH * 60))} min old — the earliest reads barely separate winners from traps`); drop("low"); }
  else if (ageH < 6)   { reasons.push(`${Math.round(ageH)}h old — still early, the read firms up over the first day`); drop("limited"); }
  if (holders > 0 && holders < 30)       { reasons.push(`just ${holders} holders — too thin to read distribution reliably`); drop("low"); }
  else if (holders > 0 && holders < 100) { reasons.push(`${holders} holders — a small sample`); drop("limited"); }
  if (events != null && events < 40)     { reasons.push(`sparse on-chain history (${events} transfers) — coverage is partial`); drop("limited"); }
  if (!priceReconstructed)               { reasons.push("price is reconstructed from swaps — treat exact figures as estimates"); drop("limited"); }
  // calibrate by context: the resemblance read compares against winners that all launched on ONE venue so far. A token
  // from a venue with few/no comparable winners is judged cross-venue — say so, and lower confidence (ChatGPT #3).
  if (venue && WINNER_VENUES) { const dom = Object.entries(WINNER_VENUES).sort((a, b) => b[1] - a[1])[0];
    if ((WINNER_VENUES[venue] || 0) < 2 && dom) { reasons.push(`no ${venue.toUpperCase()} launches among the winners yet — the model is fitted on ${dom[0].toUpperCase()} launches, so this is a cross-venue read`); drop("limited"); } }
  // NOTE: the small comparable-winner count (nWinners) is a limit of the RESEMBLANCE read, not the data/trap read —
  // it's reported here and surfaced beside the resemblance verdict, but it never caps confidence in the structure check.
  if (!reasons.length) reasons.push("enough history, holders and comparable winners for a confident read");
  return { level: NAME[sev], reasons, nWinners };
}
