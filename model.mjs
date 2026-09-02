// The baked winner-study model — the VALUATION LADDER (unique wallets → market cap) from the top-graduated
// cohort, used to place a LIVE token against the winners' precedent in real time. model.json is regenerated
// from the backtest study (tools/gen-model); if it's missing the helpers no-op so the board still runs.
import { readFileSync } from "node:fs";
let LADDER = [];
try { LADDER = JSON.parse(readFileSync(new URL("./model.json", import.meta.url), "utf8")).ladder || []; } catch { /* no model yet */ }
const log10 = Math.log10;

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
export const hasModel = () => LADDER.length > 0;
