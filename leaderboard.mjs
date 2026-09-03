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

const DEFAULTS = { minInvested: 200, minRealized: 100, topN: 100, perToken: 60,
  // "riding a winner" (unrealized) qualification — gated so paper gains on thin tokens can't count:
  minRiding: 250,          // per-token unrealized $ needed for a "riding" position
  rideMinMcap: 250000,     // the token must be a real market (≥ this mcap)…
  rideMinTraders: 12,      // …with enough distinct traders that the price isn't one wallet's mirage
  rideWeight: 0.5 };       // unrealized counts half of realized when ranking (paper < cash)

export async function buildLeaderboard(tokens, computeBt, opts = {}) {
  const { minInvested, minRealized, topN, perToken, minRiding, rideMinMcap, rideMinTraders, rideWeight } = { ...DEFAULTS, ...opts };
  const budgetMs = opts.budgetMs || 0;          // 0 = no budget; else stop scanning after this long (partial result)
  const startMs = Date.now();
  let partial = false;
  const wallets = new Map();
  const get = (a) => {
    let e = wallets.get(a);
    if (!e) wallets.set(a, e = { a, realized: 0, unrealized: 0, invested: 0, tokensWon: 0, tokensLost: 0, riding: 0, tokensRiding: 0, tokens: [] });
    return e;
  };
  let scanned = 0;
  for (const t of tokens) {
    if (budgetMs && Date.now() - startMs > budgetMs) { partial = true; break; }   // stop early → partial smart set beats none
    let bt = null;
    try { bt = await computeBt(t.address); } catch { /* skip a token that won't backtest */ }
    if (!bt || !Array.isArray(bt.pnl)) continue;
    scanned++;
    const sym = bt.sym || t.sym || t.address.slice(0, 6);
    // REAL-MARKET gate for crediting UNREALIZED (a "riding a winner" signal): the token must have a genuine market —
    // a real market cap, a live swap price, and enough distinct traders that the price isn't one wallet's mirage.
    // This is the honesty rail: paper gains on a thin/dead token can never mint smart money; only real runners do.
    const mcap = t.mcapUsd || (bt.curPrice && bt.supply ? bt.curPrice * bt.supply : 0);
    const realMarket = mcap >= rideMinMcap && bt.curPrice > 0 && (bt.pnlStats?.traders || 0) >= rideMinTraders;
    for (const p of bt.pnl.slice(0, perToken)) {
      if (!(p.invested >= minInvested)) continue;              // needs real skin in the trade
      const e = get(p.a);
      e.realized += p.realized || 0;
      e.unrealized += p.unrealized || 0;
      e.invested += p.invested || 0;
      const won = (p.realized || 0) >= minRealized;
      if (won) e.tokensWon++; else if ((p.realized || 0) < 0) e.tokensLost++;
      // riding: still holding a meaningful unrealized gain on a real-market token
      const riding = realMarket && !!p.holding && (p.unrealized || 0) >= minRiding;
      if (riding) { e.riding += p.unrealized || 0; e.tokensRiding++; }
      e.tokens.push({ sym, address: t.address, realized: +(p.realized || 0).toFixed(2), unrealized: +(p.unrealized || 0).toFixed(2),
        pnl: p.pnl, roi: p.roi, holding: !!p.holding, up: !!p.up, riding });
    }
  }
  const isProven = (e) => e.realized >= minRealized && e.tokensWon >= 1;   // cash actually taken out
  const isRiding = (e) => e.riding >= minRiding && e.tokensRiding >= 1;     // unrealized on a real-market runner
  const rows = [...wallets.values()]
    .filter((e) => isProven(e) || isRiding(e))
    .map((e) => {
      const traded = e.tokensWon + e.tokensLost;
      const proven = isProven(e), riding = isRiding(e);
      e.tokens.sort((x, y) => (y.realized - x.realized) || (y.unrealized - x.unrealized));
      return {
        a: e.a,
        realized: +e.realized.toFixed(2),
        unrealized: +e.unrealized.toFixed(2),
        ridingProfit: +e.riding.toFixed(2),      // unrealized $ on real-market tokens still held
        pnl: +(e.realized + e.unrealized).toFixed(2),
        invested: +e.invested.toFixed(2),
        roi: e.invested > 0 ? +((e.realized + e.unrealized) / e.invested).toFixed(2) : null,
        tokensWon: e.tokensWon,
        tokensRiding: e.tokensRiding,
        tokensTraded: traded,
        winRate: traded ? Math.round((e.tokensWon / traded) * 100) : null,
        holdingAny: e.tokens.some((tk) => tk.holding),
        proven, riding,                          // how this wallet earned the board
        kind: proven && riding ? "both" : proven ? "proven" : "riding",
        tokens: e.tokens.slice(0, 12),
      };
    })
    // rank by a blend: proven cash first, unrealized on real runners counts half (paper < cash), wins as tiebreak
    .sort((x, y) => (y.realized + rideWeight * y.riding) - (x.realized + rideWeight * x.riding) || y.tokensWon - x.tokensWon)
    .slice(0, topN);
  return { updated: Date.now(), tokensScanned: scanned, tokensRequested: tokens.length, partial, wallets: rows.length, rough: true,
    proven: rows.filter((r) => r.proven).length, riding: rows.filter((r) => r.riding && !r.proven).length, rows };
}
