// SMART MONEY CONVERGENCE — turn the proven-PnL leaderboard into a live "where is smart money positioned" signal.
//
// The leaderboard already identifies the wallets that have ACTUALLY made money on this chain (realized profit across
// multiple launches — see leaderboard.mjs). This module exposes that set so every token verdict can flag how many of
// those proven wallets currently HOLD it, and the board can surface the tokens where several INDEPENDENT smart-money
// wallets have converged — the high-confidence "who's buying" read.
//
// Zero extra RPC: membership is a set lookup against the holder map the verdict already builds. Honest scope: "smart
// money" = proven realized-PnL wallets from OUR swap-implied reconstruction, not insider knowledge; convergence is a
// confidence signal (independent proven traders landing on the same token), never a recommendation.

// Shared current smart-money set — set by the server after each leaderboard refresh, read by every verdict (board
// AND the token dossier) so smart-money positioning is consistent everywhere. Empty until the first leaderboard build.
let CURRENT = { set: new Set(), meta: {}, size: 0, updated: 0 };
export function setCurrentSmartMoney(sm) { if (sm && sm.set) CURRENT = sm; }
export function getCurrentSmartMoney() { return CURRENT; }

// Build the smart-money set + per-wallet track record from a leaderboard snapshot. Includes both PROVEN wallets
// (realized cash) and RIDING wallets (large unrealized on a real-market runner still held) — the `kind` distinguishes
// them so the UI can be honest about proven vs paper.
export function smartMoneyFrom(leaderboard) {
  const rows = (leaderboard && leaderboard.rows) || [];
  const set = new Set();
  const meta = {};
  for (const r of rows) {
    if (!r.a) continue;
    const proven = r.proven ?? ((r.tokensWon || 0) >= 1);   // back-compat with pre-riding leaderboards
    const riding = r.riding ?? false;
    if (!proven && !riding) continue;
    const a = r.a.toLowerCase();
    set.add(a);
    meta[a] = { realized: r.realized, roi: r.roi, tokensWon: r.tokensWon, winRate: r.winRate, holdingAny: r.holdingAny,
      kind: r.kind || (proven && riding ? "both" : proven ? "proven" : "riding"), ridingProfit: r.ridingProfit ?? null, tokensRiding: r.tokensRiding || 0 };
  }
  return { set, meta, size: set.size, updated: (leaderboard && leaderboard.updated) || Date.now() };
}

// CONSENSUS — the sharper convergence read (the best definition in the FOMO tool ecosystem, done on-chain): not
// "N proven wallets hold it", but "N proven wallets BOUGHT it within a tight window of each other, weighted by each
// wallet's realised record". Independent smart traders landing on one launch inside an hour is a different fact from
// two proven wallets that happen to hold bags bought days apart. Pure, injectable clock, unit-tested.
//   weight(w) = 0.5 + 0.5·winRate + min(1, log10(1 + realised$)/6)  → ~0.5 (thin record) … ~2.0 ($1M realised, 100% hit)
//   strength  = Σ weight over the densest window · n = wallets in it · tight10 = most wallets inside any 10 minutes
const clamp01 = (x) => Math.max(0, Math.min(1, x));
export function smartWeight(m = {}) {
  const wr = m.winRate == null ? 0 : (m.winRate > 1 ? m.winRate / 100 : m.winRate);   // meta carries 0–100 or 0–1
  const rz = Math.max(0, +m.realized || 0);
  return +(0.5 + 0.5 * clamp01(wr) + Math.min(1, Math.log10(1 + rz) / 6)).toFixed(3);
}
export function consensusOf(hits, smartMeta = {}, { windowSec = 3600, now = Date.now() / 1000 } = {}) {
  // only wallets that actually BOUGHT on the pool (a bag that arrived by transfer is not a buy decision)
  const buyers = (hits || []).filter((w) => w && w.first > 0 && (w.bought || 0) > 0)
    .map((w) => ({ a: (w.a || "").toLowerCase(), t: w.first, wgt: smartWeight(smartMeta[(w.a || "").toLowerCase()]) }))
    .sort((x, y) => x.t - y.t);
  if (buyers.length < 2) return null;
  let best = null, tight10 = 1;
  for (let i = 0; i < buyers.length; i++) {
    let s = 0, n = 0, n10 = 0, j = i;
    for (; j < buyers.length && buyers[j].t - buyers[i].t <= windowSec; j++) { s += buyers[j].wgt; n++; if (buyers[j].t - buyers[i].t <= 600) n10++; }
    if (n10 > tight10) tight10 = n10;
    if (n >= 2 && (!best || s > best.strength || (s === best.strength && n > best.n))) best = { i, j: j - 1, n, strength: s };
  }
  if (!best) return null;
  const cl = buyers.slice(best.i, best.j + 1), lastAt = cl[cl.length - 1].t;
  return { n: best.n, strength: +best.strength.toFixed(2), windowMin: Math.round(windowSec / 60), spanMin: Math.round((lastAt - cl[0].t) / 60),
    tight10, lastAt, freshH: +Math.max(0, (now - lastAt) / 3600).toFixed(2), wallets: cl.map((b) => b.a) };
}

// Given a token's holder list and the smart set, return the smart-money holders (sorted by bag) + summary + consensus.
export function smartHolders(holders, smartSet, smartMeta = {}, cap = 12, opts = {}) {
  if (!smartSet || !smartSet.size || !Array.isArray(holders)) return null;
  const hits = holders.filter((w) => w && w.bal > 1e-9 && smartSet.has((w.a || "").toLowerCase()));
  if (!hits.length) return null;
  hits.sort((a, b) => b.bal - a.bal);
  const kindOf = (w) => (smartMeta[(w.a || "").toLowerCase()] || {}).kind || "proven";
  const wallets = hits.slice(0, cap).map((w) => {
    const m = smartMeta[(w.a || "").toLowerCase()] || {};
    return { a: w.a, bal: Math.round(w.bal), kind: m.kind || "proven", realized: m.realized ?? null, roi: m.roi ?? null, tokensWon: m.tokensWon ?? null, winRate: m.winRate ?? null, weight: smartWeight(m) };
  });
  const proven = hits.filter((w) => kindOf(w) !== "riding").length;   // proven or both
  const consensus = consensusOf(hits, smartMeta, { windowSec: opts.windowSec, now: opts.now });
  return { count: hits.length, proven, riding: hits.length - proven,
    held: Math.round(hits.reduce((s, w) => s + w.bal, 0)), wallets, consensus };
}

// Rank the board's tokens by smart-money CONSENSUS strength (record-weighted, bought-together), then by how many
// proven wallets hold. `sections` = { cooking:[…], dex:[…], graduated:[…] }; each token may carry a `.smart`.
export function convergence(sections, { minCount = 2 } = {}) {
  const out = [];
  for (const [section, arr] of Object.entries(sections || {})) {
    for (const t of arr || []) {
      const s = t.smart;
      if (s && s.count >= minCount) {
        out.push({ address: t.address, sym: t.sym, section, venue: t.venue || null, mcapUsd: t.mcapUsd || 0,
          risk: t.risk, ageH: t.ageH, count: s.count, held: s.held, wallets: s.wallets, consensus: s.consensus || null });
      }
    }
  }
  const st = (x) => (x.consensus && x.consensus.strength) || 0;
  return out.sort((a, b) => st(b) - st(a) || b.count - a.count || (b.mcapUsd || 0) - (a.mcapUsd || 0));
}
