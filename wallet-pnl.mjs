// PER-WALLET PnL REPORT — one wallet's reconstructed trading across the chain's winner tokens.
//
// This is the on-brand answer to "show me the actual PnL, reconstructed by our engine" (vs. a third-party
// portfolio service that doesn't even index this chain). It reuses the exact same per-token backtests the
// leaderboard aggregates — cached, so it's cheap and its numbers reconcile with the leaderboard to the cent —
// and slices out ONE wallet's position on each token: what it put in, what it took out (realized), what it's
// still sitting on (unrealized, marked at the live swap price), and how that nets to a total.
//
// Pure + injectable: takes a `computeBt(address)` so it's testable with a stub and reuses the server's cache in
// production. Honesty rails inherited from pnl.mjs: realized only on coins actually sold, unrealized only on
// coins still held, untracked-cost coins credited zero — so a wallet's number understates if anything.

export async function walletPnlReport(address, tokens, computeBt, opts = {}) {
  address = (address || "").toLowerCase();
  const minRealized = opts.minRealized ?? 100;         // a "win" = at least this much cash actually taken out
  const budgetMs = opts.budgetMs || 0;                 // 0 = scan all; else stop early (partial) so it can't run long
  const conc = Math.max(1, opts.concurrency || 20);    // fetch the per-token backtests in PARALLEL, not one-by-one
  const deadlineMs = opts.deadlineMs || 0;             // hard wall-clock cap on how long the CALLER waits (0 = none)
  const start = Date.now();
  const rows = [];
  let scanned = 0, partial = false;

  // The reports reuse the leaderboard's WARMED backtests, so per token this is usually a single cache read — but a
  // sequential await over ~100 tokens is still ~100 serial round-trips (seconds). Fetch them with a bounded worker
  // pool so a warm report resolves in roughly one round-trip; the budget still caps a cold (RPC) scan.
  const bts = new Array(tokens.length).fill(null);
  let next = 0, stopped = false;
  const worker = async () => {
    for (;;) {
      if (stopped) return;
      const i = next++; if (i >= tokens.length) return;
      if (budgetMs && Date.now() - start > budgetMs) { stopped = true; partial = true; return; }
      try { bts[i] = await computeBt(tokens[i].address); } catch { /* a token that won't backtest is skipped, never fatal */ }
    }
  };
  // A cold backtest is ~30-60s on the native RPC and a worker can't be interrupted mid-await, so the budget alone
  // still makes the caller wait for the first batch. The DEADLINE races the pool against a timer: when it fires we
  // stop launching new tokens and return what has finished (partial). The in-flight backtests are NOT cancelled —
  // they keep running and land in the server's memo/KV, so the page's next poll finds them warm. Never block a user.
  const pool = Promise.all(Array.from({ length: Math.min(conc, tokens.length) }, worker));
  if (deadlineMs) {
    let t; const timer = new Promise((r) => { t = setTimeout(() => { stopped = true; partial = true; r(); }, deadlineMs); if (t.unref) t.unref(); });
    await Promise.race([pool, timer]); clearTimeout(t);
  } else await pool;

  // build rows in token order (then sort) so output is identical regardless of fetch interleaving
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], bt = bts[i];
    if (!bt || !Array.isArray(bt.pnl)) continue;
    scanned++;
    const p = bt.pnl.find((x) => x.a === address);
    if (!p) continue;                                   // this wallet never traded this token on the pool
    const curPrice = bt.curPrice != null ? bt.curPrice : null;
    const mcap = t.mcapUsd || (curPrice && bt.supply ? curPrice * bt.supply : 0);
    rows.push({
      address: t.address,
      sym: bt.sym || t.sym || t.address.slice(0, 6),
      invested: p.invested, realized: p.realized, unrealized: p.unrealized, proceeds: p.proceeds,
      pnl: p.pnl, roi: p.roi, qty: p.qty, avgCost: p.avgCost, curPrice,
      nBuys: p.nBuys, nSells: p.nSells, holding: !!p.holding, up: !!p.up,
      untrackedSold: p.untrackedSold || 0,
      mcapUsd: Math.round(mcap) || 0, graduated: !!t.graduated,
    });
  }
  // biggest swings first (winners AND losers — an honest page shows both)
  rows.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  const sum = (k) => +rows.reduce((s, r) => s + (r[k] || 0), 0).toFixed(2);
  const realized = sum("realized"), unrealized = sum("unrealized"), invested = sum("invested");
  const pnl = +(realized + unrealized).toFixed(2);
  const totals = {
    realized, unrealized, pnl, invested,
    roi: invested > 0 ? +((realized + unrealized) / invested).toFixed(3) : null,
    tokensTraded: rows.length,
    tokensWon: rows.filter((r) => r.realized >= minRealized).length,
    tokensLost: rows.filter((r) => r.pnl < 0).length,
    tokensHeld: rows.filter((r) => r.holding).length,
    tokensRiding: rows.filter((r) => r.holding && r.unrealized > 0).length,
    // how much of the total is cash-in-hand vs still-on-the-table (paper) — an honesty split, not a ranking
    realizedShare: pnl !== 0 ? +(realized / (Math.abs(realized) + Math.abs(unrealized) || 1)).toFixed(2) : null,
  };
  return {
    address, found: rows.length > 0, scanned, tokensRequested: tokens.length, partial, rough: true,
    tokens: rows, totals,
  };
}
