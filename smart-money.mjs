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

// Build the smart-money set + per-wallet track record from a leaderboard snapshot.
export function smartMoneyFrom(leaderboard, { minWins = 1 } = {}) {
  const rows = (leaderboard && leaderboard.rows) || [];
  const set = new Set();
  const meta = {};
  for (const r of rows) {
    if (!r.a || (r.tokensWon || 0) < minWins) continue;
    const a = r.a.toLowerCase();
    set.add(a);
    meta[a] = { realized: r.realized, roi: r.roi, tokensWon: r.tokensWon, winRate: r.winRate, holdingAny: r.holdingAny };
  }
  return { set, meta, size: set.size, updated: (leaderboard && leaderboard.updated) || Date.now() };
}

// Given a token's holder list and the smart set, return the smart-money holders (sorted by bag) + summary.
export function smartHolders(holders, smartSet, smartMeta = {}, cap = 12) {
  if (!smartSet || !smartSet.size || !Array.isArray(holders)) return null;
  const hits = holders.filter((w) => w && w.bal > 1e-9 && smartSet.has((w.a || "").toLowerCase()));
  if (!hits.length) return null;
  hits.sort((a, b) => b.bal - a.bal);
  const wallets = hits.slice(0, cap).map((w) => {
    const m = smartMeta[(w.a || "").toLowerCase()] || {};
    return { a: w.a, bal: Math.round(w.bal), realized: m.realized ?? null, roi: m.roi ?? null, tokensWon: m.tokensWon ?? null, winRate: m.winRate ?? null };
  });
  return { count: hits.length, held: Math.round(hits.reduce((s, w) => s + w.bal, 0)), wallets };
}

// Rank the board's tokens by smart-money convergence (how many proven wallets currently hold each).
// `sections` = { cooking:[…], dex:[…], graduated:[…] }; each token may carry a `.smart` from the verdict.
export function convergence(sections, { minCount = 2 } = {}) {
  const out = [];
  for (const [section, arr] of Object.entries(sections || {})) {
    for (const t of arr || []) {
      const s = t.smart;
      if (s && s.count >= minCount) {
        out.push({ address: t.address, sym: t.sym, section, venue: t.venue || null, mcapUsd: t.mcapUsd || 0,
          risk: t.risk, ageH: t.ageH, count: s.count, held: s.held, wallets: s.wallets });
      }
    }
  }
  return out.sort((a, b) => b.count - a.count || (b.mcapUsd || 0) - (a.mcapUsd || 0));
}
