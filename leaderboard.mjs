// PROVEN-PnL LEADERBOARD — the "follow the smart money" list. Aggregates per-token wallet PnL (from the backtest
// engine) across every graduated/DEX winner into one ranked table of wallets that have actually made money on
// this chain: who bought low and sold high, across how many launches, and whether they're still in.
//
// The unit of truth is a wallet's REALIZED profit summed over tokens (cash it actually took out), with unrealized
// on still-held bags reported alongside but never used to rank — a paper gain is not a proven trade. A wallet
// earns the board by winning on MULTIPLE tokens, not one lucky snipe, so we surface tokensWon + winRate too.
//
// Pure + injectable: `buildLeaderboard` takes a `computeBt(token)` function so it's testable with a stub and reuses
// the server's cached backtests in production (no extra RPC beyond what the token pages already pay for).
//
// Honesty rails baked in: PnL is swap-implied (reconstructed, not broker statements) → flagged rough; a wallet
// needs real skin (minInvested) and a real gain (minRealized) on a token to count, so dust and rounding never mint
// a "winner"; and untracked-cost coins credit zero profit (see pnl.mjs), so the numbers understate if anything.

const DEFAULTS = { minInvested: 200, minRealized: 100, topN: 100, perToken: 60 };

export async function buildLeaderboard(tokens, computeBt, opts = {}) {
  const { minInvested, minRealized, topN, perToken } = { ...DEFAULTS, ...opts };
  const wallets = new Map();
  const get = (a) => {
    let e = wallets.get(a);
    if (!e) wallets.set(a, e = { a, realized: 0, unrealized: 0, invested: 0, tokensWon: 0, tokensLost: 0, tokens: [] });
    return e;
  };
  let scanned = 0;
  for (const t of tokens) {
    let bt = null;
    try { bt = await computeBt(t.address); } catch { /* skip a token that won't backtest */ }
    if (!bt || !Array.isArray(bt.pnl)) continue;
    scanned++;
    const sym = bt.sym || t.sym || t.address.slice(0, 6);
    for (const p of bt.pnl.slice(0, perToken)) {
      if (!(p.invested >= minInvested)) continue;              // needs real skin in the trade
      const e = get(p.a);
      e.realized += p.realized || 0;
      e.unrealized += p.unrealized || 0;
      e.invested += p.invested || 0;
      const won = (p.realized || 0) >= minRealized;
      if (won) e.tokensWon++; else if ((p.realized || 0) < 0) e.tokensLost++;
      e.tokens.push({ sym, address: t.address, realized: +(p.realized || 0).toFixed(2), pnl: p.pnl,
        roi: p.roi, holding: !!p.holding, up: !!p.up });
    }
  }
  const rows = [...wallets.values()]
    .filter((e) => e.realized >= minRealized && e.tokensWon >= 1) // proven: real realized profit on ≥1 launch
    .map((e) => {
      const traded = e.tokensWon + e.tokensLost;
      e.tokens.sort((x, y) => y.realized - x.realized);
      return {
        a: e.a,
        realized: +e.realized.toFixed(2),
        unrealized: +e.unrealized.toFixed(2),
        pnl: +(e.realized + e.unrealized).toFixed(2),
        invested: +e.invested.toFixed(2),
        roi: e.invested > 0 ? +((e.realized + e.unrealized) / e.invested).toFixed(2) : null,
        tokensWon: e.tokensWon,
        tokensTraded: traded,
        winRate: traded ? Math.round((e.tokensWon / traded) * 100) : null,
        holdingAny: e.tokens.some((tk) => tk.holding),
        tokens: e.tokens.slice(0, 12),
      };
    })
    // rank by realized cash first (the proven part), win-count as the tiebreak (repeat performance beats one hit)
    .sort((x, y) => y.realized - x.realized || y.tokensWon - x.tokensWon)
    .slice(0, topN);
  return { updated: Date.now(), tokensScanned: scanned, wallets: rows.length, rough: true, rows };
}
