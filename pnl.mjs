// PER-WALLET REALIZED + UNREALIZED PnL — the "is this wallet up or down on this token" engine.
//
// Pure and deterministic: given a token's priced trades (a buy/sell stream where each event carries the
// swap-implied price at its moment) it reconstructs each wallet's average cost, realized profit on the coins it
// has sold, and unrealized profit on the coins it still holds. This is what turns "N insiders selling now" into
// "this wallet is down 40%, dumping into a loss" vs "up 3× and taking profit", and it's the base layer for the
// cross-token "proven positive-PnL wallets to follow" leaderboard.
//
// Accounting rules (deliberately conservative — we never invent profit):
//  • Only POOL trades carry a price: a pool BUY adds coins at cost = qty × price and counts as real money in
//    ("invested"); a pool SELL realizes profit against the running average cost.
//  • A sell larger than the wallet's tracked (bought-on-pool) quantity realizes only on the tracked part — coins
//    that arrived by wallet-to-wallet transfer have unknown cost, so we credit ZERO profit on them rather than
//    treat them as free (which would inflate PnL). Their proceeds are excluded, not counted as gain.
//  • Wallet-to-wallet transfers move balance but are not P&L events (not a purchase, not a sale).
//  • Unrealized = still-held qty × (current price − average cost). Total PnL = realized + unrealized.
//
// So a wallet's number is honest-low: if anything, it understates gains (untracked-cost coins), never overstates.

const EPS = 1e-9;

// trades: [{ w, side: "buy"|"sell", qty, price }] in time order (only priced POOL trades). currentPrice: last
// swap-implied price (for marking still-held coins). Returns a Map wallet → position.
export function walletPnl(trades, currentPrice) {
  const pos = new Map();
  const get = (w) => {
    let e = pos.get(w);
    if (!e) pos.set(w, e = { qty: 0, cost: 0, invested: 0, realized: 0, proceeds: 0, nBuys: 0, nSells: 0, untrackedSold: 0 });
    return e;
  };
  for (const t of trades) {
    if (!t.w || !(t.qty > 0) || !(t.price > 0)) continue;
    const e = get(t.w);
    if (t.side === "buy") {
      e.qty += t.qty; e.cost += t.qty * t.price; e.invested += t.qty * t.price; e.nBuys++;
    } else if (t.side === "sell") {
      e.nSells++;
      const matched = Math.min(t.qty, e.qty);
      if (matched > EPS) {
        const avg = e.cost / e.qty;
        e.realized += matched * (t.price - avg);
        e.proceeds += matched * t.price;
        e.cost -= matched * avg;
        e.qty -= matched;
      }
      const excess = t.qty - matched;
      if (excess > EPS) e.untrackedSold += excess; // sold coins we never saw bought on-pool → no profit credited
    }
  }
  const cp = currentPrice > 0 ? currentPrice : 0;
  for (const e of pos.values()) {
    // average cost of coins STILL held (only used to mark unrealized; 0 when nothing is held)
    e.avgCost = e.qty > EPS ? e.cost / e.qty : 0;
    e.unrealized = cp > 0 && e.qty > EPS ? e.qty * (cp - e.avgCost) : 0;
    e.pnl = e.realized + e.unrealized;
    e.pnlPct = e.invested > EPS ? (e.pnl / e.invested) * 100 : 0;
    e.roi = e.invested > EPS ? e.pnl / e.invested : 0;
    e.up = e.pnl > 0;
    e.holding = e.qty > EPS;
    // round for transport
    e.qty = +e.qty.toFixed(2); e.cost = +e.cost.toFixed(2); e.invested = +e.invested.toFixed(2);
    e.realized = +e.realized.toFixed(2); e.unrealized = +e.unrealized.toFixed(2); e.proceeds = +e.proceeds.toFixed(2);
    e.avgCost = +e.avgCost.toFixed(8); e.pnl = +e.pnl.toFixed(2); e.pnlPct = +e.pnlPct.toFixed(1); e.roi = +e.roi.toFixed(3);
    e.untrackedSold = +e.untrackedSold.toFixed(2);
  }
  return pos;
}

// Build the priced-trade stream from a backtest's sorted transfers + its per-bucket price series. `isBuy`/`isSell`
// classify pool interactions; `priceAt(ts)` returns the swap-implied price at a moment (nearest filled bucket).
// Only pool trades are emitted, so wallet-to-wallet noise never enters the accounting.
export function tradesFromTransfers(sorted, { isBuy, isSell, priceAt }) {
  const trades = [];
  for (const e of sorted) {
    if (!(e.amt > 0)) continue;
    const p = priceAt(e.ts);
    if (!(p > 0)) continue;
    if (isBuy(e)) trades.push({ w: e.to, side: "buy", qty: e.amt, price: p });
    else if (isSell(e)) trades.push({ w: e.from, side: "sell", qty: e.amt, price: p });
  }
  return trades;
}
