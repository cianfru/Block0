// Smart-money radar — pure core, shared by the browser page (public/radar.html) and Node (tests, tools/radar-log.mjs).
// No I/O here: callers fetch logs from the FREE native node and hand them in. Everything is plain data in, plain
// data out, so the exact logic the page runs is the logic the tests pin.
//
// Model: one eth_getLogs with topic2 = [every smart wallet] returns every token they RECEIVED; topic1 = the same list
// returns every token they SENT. A token received from a VENUE (AMM / router / pool contract) is a buy; sent to one is
// a sell; wallet↔wallet moves are transfers, not decisions. QUOTE tokens (WETH, stables, the stocks Pons pairs
// against) are the other leg of a swap and are ignored, or every sell would read as a buy of WETH.

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

// Buy candidates whose tx sender is still unknown (resolve with eth_getTransactionByHash, cache forever).
export function unverifiedBuys(transfers, { smart, venues, quotes, kinds = {}, senders = {} }) {
  const s = new Set();
  for (const t of transfers) if (smart.has(t.to) && !quotes.has(t.token) && t.from !== ZERO && (venues.has(t.from) || kinds[t.from] === "contract") && !senders[t.tx]) s.add(t.tx);
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

// transfers → moves {w, token, side: buy|sell|transfer, amt, block, tx}. One move per (tx, wallet, token, side):
// a routed swap can emit several legs for the same trade.
//   senders: tx hash → the address that SENT the transaction (eth_getTransactionByHash). A buy counts only if the
//   wallet sent it itself (or it is the tx target — an EIP-7702 sponsored call). Tokens PUSHED into a known trader's
//   wallet by someone else (airdrop spam aimed at wallet trackers, "free" allocations) arrive from a contract too,
//   and without this check they read as dozens of smart buys. Unresolved senders → "pending", never counted.
//   Sells need no check: tokens cannot leave a wallet without its owner's approval.
export function classify(transfers, { smart, venues, quotes, kinds = {}, senders = null }) {
  const isVenue = (a) => venues.has(a) || kinds[a] === "contract";
  const m = new Map();
  for (const t of transfers) {
    if (quotes.has(t.token) || t.from === ZERO || t.to === ZERO) continue;
    const add = (w, side) => {
      const k = t.tx + w + t.token + side;
      const cur = m.get(k);
      if (cur) cur.amt += t.amt; else m.set(k, { w, token: t.token, side, amt: t.amt, block: t.block, tx: t.tx });
    };
    if (smart.has(t.to)) {
      let side = isVenue(t.from) ? "buy" : "transfer";
      if (side === "buy" && senders) { const s = senders[t.tx]; side = !s ? "pending" : s.from === t.to || s.to === t.to ? "buy" : "pushed"; }
      add(t.to, side);
    }
    if (smart.has(t.from)) add(t.from, isVenue(t.to) ? "sell" : "transfer");
  }
  return [...m.values()].sort((a, b) => a.block - b.block);
}

// moves → one row per token: who is buying, who is selling, and where each wallet stands (net) inside the window.
//   status: buying (bought, no sells) · trimmed (bought, then sold under 90 % of it) · exited (bought, then sold
//   ≥90 %) · selling (sold with no buy inside the window — an older bag being distributed)
export function positions(moves, walletMeta, { sinceBlock = 0 } = {}) {
  const tok = new Map();
  for (const mv of moves) {
    if (mv.block < sinceBlock || (mv.side !== "buy" && mv.side !== "sell")) continue;
    const t = tok.get(mv.token) || tok.set(mv.token, { token: mv.token, wallets: new Map(), firstBlock: mv.block, lastBlock: mv.block }).get(mv.token);
    t.lastBlock = Math.max(t.lastBlock, mv.block); t.firstBlock = Math.min(t.firstBlock, mv.block);
    const w = t.wallets.get(mv.w) || t.wallets.set(mv.w, { a: mv.w, bought: 0, sold: 0, buys: 0, sells: 0, firstBlock: mv.block, lastBlock: mv.block }).get(mv.w);
    if (mv.side === "buy") { w.bought += mv.amt; w.buys++; } else { w.sold += mv.amt; w.sells++; }
    w.lastBlock = Math.max(w.lastBlock, mv.block);
  }
  const rows = [];
  for (const t of tok.values()) {
    const ws = [...t.wallets.values()].map((w) => {
      const meta = walletMeta.get(w.a) || {};
      const status = !w.sells ? "buying" : !w.buys ? "selling" : w.sold >= w.bought * 0.9 ? "exited" : "trimmed";
      return { ...w, status, tier: meta.tier || "proven", tokensWon: meta.tokensWon ?? null, winRate: meta.winRate ?? null };
    }).sort((a, b) => b.lastBlock - a.lastBlock);
    const holding = ws.filter((w) => w.status === "buying" || w.status === "trimmed");
    const sellers = ws.filter((w) => w.status !== "buying");
    rows.push({ token: t.token, wallets: ws, nSellers: sellers.length, nHolding: holding.length,
      nSharp: holding.filter((w) => w.tier === "sharp").length, firstBlock: t.firstBlock, lastBlock: t.lastBlock,
      signal: holding.length >= 2 ? "converging" : sellers.length >= 2 && holding.length === 0 ? "exiting" : "activity" });
  }
  const rank = { converging: 0, exiting: 1, activity: 2 };
  return rows.sort((a, b) => rank[a.signal] - rank[b.signal] || b.nSharp - a.nSharp || b.nHolding - a.nHolding || b.lastBlock - a.lastBlock);
}

// The one-line read. Facts only — counts, tiers, timing, price — and never a buy/sell instruction.
export function verdict(row, { minutesAgo = null, mcapUsd = null } = {}) {
  const $ = (x) => (x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x));
  const who = (n, sharp) => `${n} proven wallet${n === 1 ? "" : "s"}${sharp ? ` (${sharp} sharp)` : ""}`;
  const when = minutesAgo == null ? "" : minutesAgo < 1 ? " just now" : ` ${Math.round(minutesAgo)} min ago`;
  const at = mcapUsd ? ` · now ${$(mcapUsd)}` : "";
  if (row.signal === "converging") return `${who(row.nHolding, row.nSharp)} bought and still hold${row.nSellers ? ` · ${row.nSellers} selling` : " · none selling"} · last buy${when}${at}`;
  if (row.signal === "exiting") return `${row.nSellers} proven wallets sold out · none buying${when ? " · last sell" + when : ""}${at}`;
  const w = row.wallets[0];
  return `${who(1, w?.tier === "sharp" ? 1 : 0)} ${w?.status === "buying" || w?.status === "trimmed" ? "bought" : "sold"}${when}${at}`;
}

// Block → unix seconds from two calibration points (the native node returns blockTimestamp 0x0 on logs, so log
// times must be derived — see CLAUDE.md "never trust a log's blockTimestamp without > 0").
export const blockClock = (b0, t0, b1, t1) => { const r = (t1 - t0) / Math.max(1, b1 - b0); return (b) => t1 + (b - b1) * r; };
