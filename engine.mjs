// The launch-scanner engine. Pure, deterministic, no AI. Reconstructs a token's recent (or full, for a new
// token) transfer activity from RPC logs and computes the short-term "who's holding / who's dumping NOW" reads:
//   • auto-detected pool           • buy/sell pressure this window       • concentration (top-10 held)
//   • sniper / block-0 buyers      • same-block bundles (coordinated)    • new wallets arriving
//   • per-wallet net flow + bag    • bubble-chart events (each buy/sell) • who's selling, last window
//
// A token launched today has a tiny history, so scan() pulls it ALL and every number is exact. Older tokens
// fall back to a trailing window (labelled), which is still the right lens for a real-time desk.
import { latestBlock, findDeployBlock, getTransferLogs, getAssetTransfers, PROVIDER, toNum } from "./rpc.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const addrOf = (topic) => "0x" + topic.slice(26).toLowerCase();
// canonical DEX routers/aggregators — a transfer to one of these is also a sell (routed swap), not just to the pool
export const ROUTERS = new Set([
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", // Uniswap V2 router
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // Uniswap V3 router 2
  "0xe592427a0aece92de3edee1f18e0157c05861564", // Uniswap V3 router
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af", // Uniswap universal router
  "0x111111125421ca6dc452d289314280a0f8842a65", // 1inch v6
  "0x1111111254eeb25477b68fb85ed929f73a960582", // 1inch v5
  "0x9008d19f58aabd9ed0d60971565aa8510560ab41", // CoW settlement
  "0x6a000f20005980200259b80c5102003040001068", // paraswap
]);

// decode raw logs → transfers, and derive the market (pool) as the highest-degree counterparty
export function decode(logs, decimals) {
  const d = 10 ** decimals;
  const ev = [];
  for (const l of logs) {
    if (!l.topics || l.topics.length !== 3) continue; // ERC-20 Transfer has 3 topics; skip NFT/other
    ev.push({
      from: addrOf(l.topics[1]), to: addrOf(l.topics[2]),
      amt: Number(BigInt(l.data || "0x0")) / d,
      ts: l.blockTimestamp ? toNum(l.blockTimestamp) : null,
      block: toNum(l.blockNumber), li: toNum(l.logIndex || "0x0"),
    });
  }
  ev.sort((a, b) => a.block - b.block || a.li - b.li);
  return ev;
}

// Provider-aware transfer pull → unified {from,to,amt,ts,block,li}[]. Alchemy uses the range-uncapped
// getAssetTransfers (paged); any other RPC uses eth_getLogs + decode.
export async function pullTransfers(address, from, to, decimals, cap = 25000) {
  if (PROVIDER === "alchemy") {
    const d = 10 ** decimals; const ev = []; let pageKey; ev.capped = false;
    do {
      const r = await getAssetTransfers(address, from, to, pageKey);
      for (const t of r?.transfers || []) {
        const amt = t.rawContract?.value ? Number(BigInt(t.rawContract.value)) / d : Number(t.value || 0);
        ev.push({ from: (t.from || "").toLowerCase(), to: (t.to || "").toLowerCase(), amt,
          ts: t.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : null,
          block: toNum(t.blockNum), li: 0 });
      }
      pageKey = r?.pageKey;
      if (ev.length >= cap) { ev.capped = true; break; } // huge/old token — stop paging, treat as windowed
    } while (pageKey);
    ev.sort((a, b) => a.block - b.block);
    return ev;
  }
  return decode(await getTransferLogs(address, from, to), decimals);
}

export function detectPool(ev) {
  const deg = new Map();
  for (const e of ev) { if (e.from !== ZERO) deg.set(e.from, (deg.get(e.from) || 0) + 1); if (e.to !== ZERO) deg.set(e.to, (deg.get(e.to) || 0) + 1); }
  let best = null, bd = -1;
  for (const [a, n] of deg) if (n > bd) { bd = n; best = a; }
  return best;
}

// the core reduction: given decoded transfers + the pool, compute every launch read in one pass
export function analyze(ev, pool, opts = {}) {
  const snipeBlocks = opts.snipeBlocks ?? 3;      // "sniper" = bought within N blocks of the first pool trade
  const isSell = (e) => e.to === pool || ROUTERS.has(e.to);
  const isBuy = (e) => e.from === pool || ROUTERS.has(e.from);

  const W = new Map(); // wallet -> state
  const get = (a) => { let w = W.get(a); if (!w) W.set(a, w = { a, bal: 0, in: 0, out: 0, bought: 0, sold: 0, first: null, firstBlock: null, sniper: false }); return w; };
  const isInfra = (a) => a === ZERO || a === DEAD || a === pool || ROUTERS.has(a);

  let firstPoolBlock = null;
  const events = []; // bubble-chart events (buys/sells), non-infra side
  let buys = 0, sells = 0, buyVol = 0, sellVol = 0;

  for (const e of ev) {
    if (isBuy(e) && firstPoolBlock == null) firstPoolBlock = e.block;
    // balances (exact in full mode)
    if (!isInfra(e.from)) { const w = get(e.from); w.bal -= e.amt; w.out += e.amt; if (isSell(e)) w.sold += e.amt; }
    if (!isInfra(e.to)) {
      const w = get(e.to); w.bal += e.amt; w.in += e.amt;
      if (w.first == null) { w.first = e.ts; w.firstBlock = e.block; }
      if (isBuy(e)) w.bought += e.amt;
    }
    if (isBuy(e)) { buys++; buyVol += e.amt; const w = get(e.to); events.push({ ts: e.ts, block: e.block, w: e.to, amt: e.amt, side: "buy", firstBlock: w.firstBlock }); }
    else if (isSell(e)) { sells++; sellVol += e.amt; events.push({ ts: e.ts, block: e.block, w: e.from, amt: e.amt, side: "sell" }); }
  }

  // sniper flag: first buy within N blocks of the pool going live
  if (firstPoolBlock != null) for (const w of W.values()) if (w.firstBlock != null && w.firstBlock <= firstPoolBlock + snipeBlocks && w.bought > 0) w.sniper = true;

  // same-block bundles: ≥2 fresh wallets first-buying in the same block = coordinated snipe
  const byBlock = new Map();
  for (const w of W.values()) if (w.sniper) { const b = w.firstBlock; if (!byBlock.has(b)) byBlock.set(b, []); byBlock.get(b).push(w.a); }
  const bundles = [...byBlock.entries()].filter(([, l]) => l.length >= 2).map(([b, l]) => ({ block: b, wallets: l }));

  // holdings / concentration (exact only in full mode; a windowed scan sees partial balances)
  const holders = [...W.values()].filter((w) => w.bal > 1e-9);
  const held = holders.reduce((s, w) => s + w.bal, 0) || 1;
  const byBag = holders.slice().sort((a, b) => b.bal - a.bal);
  const top10 = byBag.slice(0, 10).reduce((s, w) => s + w.bal, 0);
  const sniperBag = holders.filter((w) => w.sniper).reduce((s, w) => s + w.bal, 0);

  const net = (w) => w.in - w.out;
  const sellers = [...W.values()].sort((a, b) => net(a) - net(b)).slice(0, 8).filter((w) => net(w) < 0)
    .map((w) => ({ a: w.a, net: +net(w).toFixed(2), sold: +w.sold.toFixed(2), bal: +w.bal.toFixed(2), sniper: w.sniper }));
  const buyers = [...W.values()].sort((a, b) => net(b) - net(a)).slice(0, 8).filter((w) => net(w) > 0)
    .map((w) => ({ a: w.a, net: +net(w).toFixed(2), bought: +w.bought.toFixed(2), bal: +w.bal.toFixed(2), sniper: w.sniper, firstBlock: w.firstBlock }));

  const tsMin = ev.find((e) => e.ts)?.ts || null, tsMax = [...ev].reverse().find((e) => e.ts)?.ts || null;
  return {
    pool, firstPoolBlock,
    scores: {
      transfers: ev.length, activeWallets: W.size, holders: holders.length,
      buys, sells, buyVol: +buyVol.toFixed(2), sellVol: +sellVol.toFixed(2),
      netVol: +(buyVol - sellVol).toFixed(2), pressure: sellVol > buyVol ? "sell" : "buy",
      top10Share: +(top10 / held * 100).toFixed(1),
      snipers: [...W.values()].filter((w) => w.sniper).length,
      sniperHeldShare: +(sniperBag / held * 100).toFixed(1),
      bundles: bundles.length,
      spanHours: tsMin && tsMax ? +((tsMax - tsMin) / 3600).toFixed(1) : null,
    },
    events, sellers, buyers, bundles,
  };
}

// orchestrator: figure out the block range, pull, decode, analyze
export async function scan(address, { decimals = 18, windowBlocks = 1500, full = "auto", maxFullChunks = 160 } = {}) {
  address = address.toLowerCase();
  const t0 = Date.now();
  const latest = await latestBlock();
  let from, mode = "windowed";
  if (full === true || full === "auto") {
    const deploy = await findDeployBlock(address, latest);
    if (PROVIDER === "alchemy") { from = deploy; mode = "full"; }         // getAssetTransfers pages by count, not block-span
    else {
      const chunks = Math.ceil((latest - deploy) / 500);                  // eth_getLogs: block-span bounded → guard by chunk count
      if (chunks <= maxFullChunks) { from = deploy; mode = "full"; }
      else from = Math.max(deploy, latest - windowBlocks);
    }
  } else from = Math.max(0, latest - windowBlocks);
  const ev = await pullTransfers(address, from, latest, decimals);
  if (ev.capped) { mode = "windowed"; from = ev.length ? ev[0].block : from; } // hit the transfer cap → not exact, relabel
  const pool = detectPool(ev);
  const res = analyze(ev, pool, {});
  return { address, decimals, chain: process.env.CHAIN || "ethereum", mode,
    fromBlock: from, latestBlock: latest, pullMs: Date.now() - t0, updated: Date.now(), ...res };
}
