// Cross-token WALLET INTELLIGENCE — the "follow the smart money" engine. Given any wallet, reconstruct its activity
// across EVERY token (not just one), so we can answer: what has it traded, what does it still hold vs exit, and is it
// a proven winner? Powers the insider-selling reveal, the deployer's other launches, and a follow-worthy-wallets list.
//
// Mechanism: Alchemy's getAssetTransfers filters by fromAddress / toAddress, so one paged pull each direction gives
// the wallet's whole ERC-20 history across all tokens. We group by token → bought/sold/net + held-vs-exited. Infra/
// quote tokens (WETH/USDG/…) are stripped so "tokens traded" means real launches. PnL in $ is a follow-up (needs
// per-token price reconstruction); v1 gives positions + a realized-cash proxy from paired buy/sell quantities.
import { rpc } from "./rpc.mjs";
import { tokenMeta, INFRA } from "./dex.mjs";

const CAP = Number(process.env.WALLET_TX_CAP || 6000); // bound the pull per direction for a very active wallet

async function pullTransfers(params) {
  const ev = []; let pageKey, guard = 0;
  do {
    const p = { ...params }; if (pageKey) p.pageKey = pageKey;
    const r = await rpc("alchemy_getAssetTransfers", [p]);
    for (const t of r?.transfers || []) ev.push(t);
    pageKey = r?.pageKey;
  } while (pageKey && ev.length < CAP && ++guard < 20);
  return ev;
}

export async function walletIntel(addr, { topN = 30 } = {}) {
  addr = addr.toLowerCase();
  const base = { fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: true, maxCount: "0x3e8", order: "asc", excludeZeroValue: true };
  const [sent, recv] = await Promise.all([
    pullTransfers({ ...base, fromAddress: addr }),
    pullTransfers({ ...base, toAddress: addr }),
  ]);
  const tok = new Map();
  const g = (a) => { let e = tok.get(a); if (!e) tok.set(a, e = { token: a, bought: 0, sold: 0, nBuys: 0, nSells: 0, first: null, last: null }); return e; };
  const stamp = (e, t) => { const ts = t.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : null; if (ts) { if (!e.first || ts < e.first) e.first = ts; if (!e.last || ts > e.last) e.last = ts; } };
  for (const t of recv) { const a = (t.rawContract?.address || "").toLowerCase(); if (!a || INFRA.has(a)) continue; const e = g(a); e.bought += Number(t.value || 0); e.nBuys++; stamp(e, t); }
  for (const t of sent) { const a = (t.rawContract?.address || "").toLowerCase(); if (!a || INFRA.has(a)) continue; const e = g(a); e.sold += Number(t.value || 0); e.nSells++; stamp(e, t); }

  let arr = [...tok.values()].map((e) => {
    const net = e.bought - e.sold, held = net > e.bought * 0.02; // still holding if >2% of what it ever bought remains
    return { token: e.token, bought: +e.bought.toFixed(2), sold: +e.sold.toFixed(2), net: +net.toFixed(2),
      nBuys: e.nBuys, nSells: e.nSells, first: e.first, last: e.last, held, exited: !held && e.sold > 0 };
  });
  // rank by trading activity (a "follow" candidate is one that trades a lot and exits — realized, not paper)
  arr.sort((a, b) => (b.nBuys + b.nSells) - (a.nBuys + a.nSells));
  const top = arr.slice(0, topN);
  // enrich the top tokens with a symbol (native contract read)
  for (const e of top) { try { const m = await tokenMeta(e.token); e.sym = m.symbol || null; } catch { /* */ } }

  const heldN = arr.filter((e) => e.held).length;
  return {
    address: addr, tokensTraded: arr.length, held: heldN, exited: arr.length - heldN,
    // a rough "flipper vs holder" read: many exits = an active trader whose realized results are worth checking
    style: arr.length >= 8 && (arr.length - heldN) / arr.length > 0.6 ? "active-trader" : heldN > arr.length * 0.6 ? "holder" : "mixed",
    tokens: top,
  };
}
