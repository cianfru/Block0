// Smart-money radar — pure core, shared by the browser page (public/radar.html) and Node (tests, tools/radar-log.mjs).
// No I/O here: callers fetch logs from the FREE native node and hand them in. Everything is plain data in, plain
// data out, so the exact logic the page runs is the logic the tests pin.
//
// Model: one eth_getLogs with topic2 = [every smart wallet] returns every token they RECEIVED; topic1 = the same list
// returns every token they SENT. A buy needs evidence of a trade (a known venue, or a contract plus payment in the same
// tx); a sell is tokens sent into a venue; wallet↔wallet moves and contract deposits are not decisions. QUOTE tokens
// (WETH, stables, the stocks Pons pairs against) are the other leg of a swap: never a position, but they are the
// payment evidence. The radar sees only its window — it reports what happened since a buy, never a balance.

export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const topicOf = (a) => "0x" + String(a).toLowerCase().slice(2).padStart(64, "0");
export const addrOf = (topic) => "0x" + String(topic).slice(-40).toLowerCase();

// What an address IS, from its eth_getCode. EIP-7702 delegated EOAs carry a 23-byte 0xef0100<target> pointer as
// code — they are people with a smart-account upgrade, not routers or bots.
export function walletKind(code) {
  const c = String(code || "0x").toLowerCase();
  if (c === "0x" || c === "0x0") return "eoa";
  if (c.startsWith("0xef0100") && c.length === 48) return "delegated";
  return "contract";
}

// raw eth_getLogs entries → transfers. Amount assumes 18 decimals (every Pons launch); it is shown as approximate.
export function decodeTransfers(logs) {
  const out = [];
  for (const l of logs || []) {
    if (!l?.topics || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    let raw = 0n; try { raw = BigInt(l.data && l.data !== "0x" ? l.data.slice(0, 66) : "0x0"); } catch { continue; }
    out.push({ token: String(l.address).toLowerCase(), from: addrOf(l.topics[1]), to: addrOf(l.topics[2]), amt: Number(raw / 10n ** 12n) / 1e6,
      block: parseInt(l.blockNumber, 16), tx: l.transactionHash, i: parseInt(l.logIndex, 16) });
  }
  return out;
}

// Buy candidates whose tx sender (and value) is still unknown (resolve with eth_getTransactionByHash, cache forever).
// An entry cached before `value` was recorded is fetched again: the value is what proves a native-ETH purchase.
export function unverifiedBuys(transfers, { smart, venues, quotes, kinds = {}, senders = {} }) {
  const s = new Set();
  for (const t of transfers) if (smart.has(t.to) && !quotes.has(t.token) && t.from !== ZERO && (venues.has(t.from) || kinds[t.from] === "contract")
    && (!senders[t.tx] || senders[t.tx].value === undefined)) s.add(t.tx);
  return [...s];
}

// Counterparties still to classify: the non-smart side of every transfer that touches a smart wallet.
export function unknownCounterparties(transfers, { smart, venues, kinds }) {
  const s = new Set();
  for (const t of transfers) {
    const cp = smart.has(t.to) ? t.from : smart.has(t.from) ? t.to : null;
    if (cp && cp !== ZERO && !venues.has(cp) && !smart.has(cp) && kinds[cp] == null) s.add(cp);
  }
  return [...s];
}

// transfers → moves {w, token, side, dir, amt, block, tx}. One move per (tx, wallet, token, side).
//   side: buy · sell · pushed (sent INTO the wallet by someone else — airdrop spam) · pending (sender not yet known)
//         · received (from a contract, nothing paid — a claim, unstake, vesting payout) · transfer (wallet↔wallet,
//         dir in|out) · deposit (into a contract that is not a known venue — staking, a vault, a bridge)
// A BUY needs evidence of a trade (audit F04), not just a contract on the other side:
//   • from a KNOWN venue (the singleton AMM, a router — smart-wallets.json `venues`), or
//   • from any other contract AND the wallet PAID in the same tx: it sent a quote token (WETH, USDG, a stock token…)
//     or the tx it sent carried native ETH value (how Pons bonding curves are paid).
//   …and the wallet sent the tx itself (or is its target — an EIP-7702 sponsored call). Unresolved → "pending".
// A contract that delivered a paid buy is treated as a venue for the window, so selling back into it is a SELL even
// when the proceeds come back as native ETH (no log). Sending tokens to any other contract is a deposit, not a sale.
export function classify(transfers, { smart, venues, quotes, kinds = {}, senders = null }) {
  const isContract = (a) => kinds[a] === "contract";
  const paidQuote = new Set(), gotQuote = new Set();
  for (const t of transfers) if (quotes.has(t.token)) { if (smart.has(t.from)) paidQuote.add(t.tx + t.from); if (smart.has(t.to)) gotQuote.add(t.tx + t.to); }
  const selfSent = (t) => { if (!senders) return true; const s = senders[t.tx]; return !s ? null : s.from === t.to || s.to === t.to; };
  const paid = (t) => paidQuote.has(t.tx + t.to) || (!!senders?.[t.tx] && senders[t.tx].from === t.to && BigInt(senders[t.tx].value || "0x0") > 0n);
  const venue = new Set(venues);
  for (const t of transfers) if (!quotes.has(t.token) && smart.has(t.to) && isContract(t.from) && paid(t) && selfSent(t)) venue.add(t.from);

  const m = new Map();
  for (const t of transfers) {
    if (quotes.has(t.token) || t.from === ZERO || t.to === ZERO) continue;
    const add = (w, side, dir) => {
      const k = t.tx + w + t.token + side + dir;
      const cur = m.get(k);
      if (cur) cur.amt += t.amt; else m.set(k, { w, token: t.token, side, dir, amt: t.amt, block: t.block, tx: t.tx });
    };
    if (smart.has(t.to)) {
      let side = "transfer";
      if (venues.has(t.from) || isContract(t.from)) {
        const self = selfSent(t);                     // null = the tx (sender, value) is not resolved yet
        side = self === null ? "pending" : !self ? "pushed" : venues.has(t.from) || paid(t) ? "buy" : "received";
      }
      add(t.to, side, "in");
    }
    if (smart.has(t.from)) add(t.from, venue.has(t.to) || gotQuote.has(t.tx + t.from) ? "sell" : isContract(t.to) ? "deposit" : "transfer", "out");
  }
  return [...m.values()].sort((a, b) => a.block - b.block);
}

// moves → one row per token, over what the window shows (audit F03). The radar does NOT know a wallet's balance from
// before the window, so it never says "holds": it says what happened since the wallet's buy.
//   status: buying (bought; nothing has left the wallet since) · trimmed (sold or moved out under 90 % of the buy) ·
//   exited (sold ≥90 %) · moved (sent ≥90 % to another wallet or contract — not a sale) · selling (sold with no buy in
//   the window — an older position, size unknown)
export function positions(moves, walletMeta, { sinceBlock = 0 } = {}) {
  const tok = new Map();
  for (const mv of moves) {
    const out = mv.dir === "out" && (mv.side === "transfer" || mv.side === "deposit");
    if (mv.block < sinceBlock || (mv.side !== "buy" && mv.side !== "sell" && !out)) continue;
    const t = tok.get(mv.token) || tok.set(mv.token, { token: mv.token, wallets: new Map(), firstBlock: mv.block, lastBlock: mv.block, lastBuyBlock: null }).get(mv.token);
    const w = t.wallets.get(mv.w) || t.wallets.set(mv.w, { a: mv.w, bought: 0, sold: 0, movedOut: 0, buys: 0, sells: 0, firstBlock: mv.block, lastBlock: mv.block }).get(mv.w);
    if (mv.side === "buy") { w.bought += mv.amt; w.buys++; t.lastBuyBlock = Math.max(t.lastBuyBlock ?? 0, mv.block); }
    else if (mv.side === "sell") { w.sold += mv.amt; w.sells++; }
    else w.movedOut += mv.amt;
    w.lastBlock = Math.max(w.lastBlock, mv.block); t.lastBlock = Math.max(t.lastBlock, mv.block); t.firstBlock = Math.min(t.firstBlock, mv.block);
  }
  const rows = [];
  for (const t of tok.values()) {
    const ws = [...t.wallets.values()].filter((w) => w.buys || w.sells).map((w) => {
      const meta = walletMeta.get(w.a) || {}, left = w.sold + w.movedOut;
      const status = !w.buys ? "selling" : !left ? "buying" : left >= w.bought * 0.9 ? (w.sold >= w.movedOut ? "exited" : "moved") : "trimmed";
      return { ...w, status, tier: meta.tier || "proven", tokensWon: meta.tokensWon ?? null, winRate: meta.winRate ?? null };
    }).sort((a, b) => b.lastBlock - a.lastBlock);
    if (!ws.length) continue;
    // Convergence promises no observed outflow, not an estimated remaining balance.
    // Even a partial sale/deposit breaks that promise; a later rebuy does not erase it.
    const holding = ws.filter((w) => w.status === "buying");
    const sellers = ws.filter((w) => w.status !== "buying");
    rows.push({ token: t.token, wallets: ws, nSellers: sellers.length, nHolding: holding.length,
      nSharp: holding.filter((w) => w.tier === "sharp").length, firstBlock: t.firstBlock, lastBlock: t.lastBlock, lastBuyBlock: t.lastBuyBlock,
      signal: holding.length >= 2 ? "converging" : sellers.length >= 2 && holding.length === 0 ? "exiting" : "activity" });
  }
  const rank = { converging: 0, exiting: 1, activity: 2 };
  return rows.sort((a, b) => rank[a.signal] - rank[b.signal] || b.nSharp - a.nSharp || b.nHolding - a.nHolding || b.lastBlock - a.lastBlock);
}

// The one-line read. Facts only — counts, tiers, timing, price — and never a buy/sell instruction. Only what the window
// shows: "bought and has not sold or moved it since", never "holds" (balances before the window are not tracked).
//   minutesAgo: since the last BUY for a converging row, since the last move otherwise
export function verdict(row, { minutesAgo = null, mcapUsd = null } = {}) {
  const $ = (x) => (x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x));
  const who = (n, sharp) => `${n} proven wallet${n === 1 ? "" : "s"}${sharp ? ` (${sharp} sharp)` : ""}`;
  const when = minutesAgo == null ? "" : minutesAgo < 1 ? " just now" : ` ${Math.round(minutesAgo)} min ago`;
  const at = mcapUsd ? ` · now ${$(mcapUsd)}` : "";
  if (row.signal === "converging") return `${who(row.nHolding, row.nSharp)} bought and ${row.nHolding === 1 ? "has" : "have"} not sold or moved it since${row.nSellers ? ` · ${row.nSellers} sold or moved out` : ""} · last buy${when}${at}`;
  if (row.signal === "exiting") return `${row.nSellers} proven wallets sold or moved out · ${row.wallets.some((w) => w.buys) ? "no buyers without an observed outflow" : "none bought in this window"}${when ? " · last" + when : ""}${at}`;
  const w = row.wallets[0];
  return `${who(1, w?.tier === "sharp" ? 1 : 0)} ${w?.status === "buying" || w?.status === "trimmed" ? "bought" : w?.status === "moved" ? "moved it out" : "sold"}${when}${at}`;
}

// Block → unix seconds from two calibration points (the native node returns blockTimestamp 0x0 on logs, so log
// times must be derived — see CLAUDE.md "never trust a log's blockTimestamp without > 0").
export const blockClock = (b0, t0, b1, t1) => { const r = (t1 - t0) / Math.max(1, b1 - b0); return (b) => t1 + (b - b1) * r; };
