// Historical BACKTEST of a token: replay its whole transfer history and snapshot the forensic SCORE at
// even time intervals, alongside a swap-implied PRICE sampled across the timeline. Answers "what did this
// winner look like BEFORE it exploded" — did concentration fall, did snipers bleed out, when did it read clean.
//
// The score reconstruction is exact and free (pure transfer replay, same computeRisk the live board uses).
// Price has no Pons API, so we reconstruct it from swaps: one representative swap per time bucket, its receipt
// gives token-out vs WETH/USDG-in → price. Sampled to `points` buckets so it's ~points receipt calls, one-time.
// Alchemy-only (uses the enhanced getAssetTransfers to keep tx hashes for the receipt lookups).
import { detectPool, ROUTERS } from "./engine.mjs";
import { computeRisk, blueprintMatch } from "./intel.mjs";
import { rpc, hx, toNum, PROVIDER, getTransferLogs, latestBlock, findDeployBlock } from "./rpc.mjs";
import { estimateBlockAt, chainCalibration, parseTs } from "./store.mjs";
import { liveTrajectory, corridorBins } from "./model.mjs";
import { walletPnl, tradesFromTransfers } from "./pnl.mjs";

const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const AMM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // RH singleton AMM
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73", USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const big = (h) => BigInt(h && h !== "0x" ? h : "0x0"); // guard empty "0x" data fields

// transfer history from launch WITH tx hashes (needed for receipt-based price). Provider-aware:
//  • Alchemy → the enhanced getAssetTransfers (range-uncapped, paged, carries hash + blockTimestamp).
//  • any other RPC (incl. the native RH node) → eth_getLogs from the launch block, keeping transactionHash;
//    the RH node's logs carry no usable blockTimestamp (absent, or "0x0"), so each transfer's time is derived from its block via a
//    one-time linear chain calibration. `launchedAt` (Pons) bounds the pull to since-launch so it's not a
//    genesis-deep scan. `cap` bounds the Alchemy paging for fast cohort profiling.
async function pullWithHash(addr, cap = 400000, opts = {}) {
  if (PROVIDER === "alchemy") {
    const ev = []; let pageKey, guard = 0;
    const maxPages = Math.ceil(cap / 1000);
    do {
      const p = { fromBlock: "0x0", toBlock: "latest", contractAddresses: [addr], category: ["erc20"], order: "asc", withMetadata: true, excludeZeroValue: false, maxCount: "0x3e8" };
      if (pageKey) p.pageKey = pageKey;
      const r = await rpc("alchemy_getAssetTransfers", [p]);
      for (const t of r?.transfers || []) ev.push({
        from: (t.from || "").toLowerCase(), to: (t.to || "").toLowerCase(),
        amt: t.rawContract?.value ? Number(big(t.rawContract.value)) / 1e18 : Number(t.value || 0),
        ts: t.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : null,
        block: Number(big(t.blockNum || "0x0")), hash: t.hash,
      });
      pageKey = r?.pageKey;
    } while (pageKey && ++guard < maxPages && ev.length < cap);
    return ev;
  }
  // generic path: eth_getLogs from the launch block, with block→time calibration for the missing timestamps
  const latest = await latestBlock();
  const ts0 = parseTs(opts.launchedAt);
  const from = ts0 != null ? await estimateBlockAt(ts0, latest) : await findDeployBlock(addr, latest);
  const cal = await chainCalibration(latest);
  const tsAt = (b) => Math.round(cal.headTs - (cal.headBlock - b) * cal.spb);
  const logs = await getTransferLogs(addr, from, latest);
  const ev = [];
  for (const l of logs) {
    if (!l.topics || l.topics.length !== 3) continue; // ERC-20 Transfer has 3 topics
    const block = toNum(l.blockNumber);
    ev.push({
      from: "0x" + l.topics[1].slice(26).toLowerCase(), to: "0x" + l.topics[2].slice(26).toLowerCase(),
      amt: Number(big(l.data || "0x0")) / 1e18,
      ts: (l.blockTimestamp && toNum(l.blockTimestamp) > 0) ? toNum(l.blockTimestamp) : tsAt(block), // the RH node returns "0x0" here — treat as absent
      block, hash: l.transactionHash,
    });
  }
  ev.sort((a, b) => a.block - b.block);
  return ev;
}

// price of one swap tx = quote paid (WETH×ethUsd or USDG) ÷ token moved, from its receipt logs. Only legs that
// TOUCH THE POOL count — otherwise an aggregator/multi-swap tx's unrelated WETH leg over a tiny token amount
// produces a phantom 100× price spike. The quote and token legs must both be the swap's own pool legs.
async function swapPrice(hash, addr, ethUsd, venues) {
  const rc = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
  let tok = 0, quote = 0;
  for (const l of rc?.logs || []) {
    if ((l.topics?.[0] || "") !== TRANSFER || (l.topics || []).length !== 3) continue;
    const from = "0x" + l.topics[1].slice(26).toLowerCase(), to = "0x" + l.topics[2].slice(26).toLowerCase();
    if (!venues.has(from) && !venues.has(to)) continue; // not a pool leg → ignore
    const a = l.address.toLowerCase(), v = Number(big(l.data));
    if (a === addr) tok = Math.max(tok, v / 1e18);
    else if (a === USDG) quote = Math.max(quote, v / 1e6);
    else if (a === WETH) quote = Math.max(quote, (v / 1e18) * ethUsd);
  }
  return tok > 0 && quote > 0 ? quote / tok : null;
}

export async function backtest(addr, opts = {}) {
  addr = addr.toLowerCase();
  const points = opts.points || 90, ethUsd = opts.ethUsd || 3000, grad = !!opts.graduated;
  // The score/wallet/trajectory series is a balance replay: it needs the FULL history but NO tx hashes. So we
  // reuse the incremental store's already-cached transfers (opts.ev) instead of re-pulling hundreds of Alchemy
  // pages every time — that re-pull was the ~40s that left charts blank. Only PRICE needs hashes (resolved
  // per-block, sampled, below). Fall back to a self-pull when no store ev is passed (e.g. the cohort builder).
  const ev = (opts.ev && opts.ev.length) ? opts.ev : await pullWithHash(addr, opts.cap || 400000, { launchedAt: opts.launchedAt });
  const sorted = ev.filter((e) => e.ts).sort((a, b) => a.ts - b.ts || a.block - b.block);
  if (sorted.length < 8) return { addr, sym: opts.sym, error: "too few timestamped transfers", n: sorted.length };

  const detected = detectPool(sorted);
  const venues = new Set([(opts.pool || "").toLowerCase(), detected, AMM].filter(Boolean));
  const isBuy = (e) => venues.has(e.from) || ROUTERS.has(e.from);
  const isSell = (e) => venues.has(e.to) || ROUTERS.has(e.to);
  const isInfra = (a) => a === ZERO || a === DEAD || venues.has(a) || ROUTERS.has(a);

  // fixed historical facts: first pool trade, snipers (≤firstPool+3 & bought), bundles (same-block ≥2), creator
  let firstPool = null, creator = null;
  const first = new Map();
  for (const e of sorted) {
    if (isBuy(e) && firstPool == null) firstPool = e.block;
    if (!isInfra(e.to)) { let f = first.get(e.to); if (!f) first.set(e.to, f = { firstBlk: e.block, bought: 0 }); if (isBuy(e)) f.bought += e.amt; }
    if (e.from === ZERO && creator == null && !isInfra(e.to)) creator = e.to;
  }
  const snipers = new Set([...first].filter(([, f]) => firstPool != null && f.firstBlk <= firstPool + 3 && f.bought > 0).map(([a]) => a));
  const byBlk = new Map();
  for (const a of snipers) { const b = first.get(a).firstBlk; if (!byBlk.has(b)) byBlk.set(b, []); byBlk.get(b).push(a); }
  const bundleWallets = new Set(); let nBundles = 0;
  for (const [, l] of byBlk) if (l.length >= 2) { nBundles++; l.forEach((a) => bundleWallets.add(a)); }
  const insiderSet = new Set([...snipers, ...bundleWallets]);

  const t0 = sorted[0].ts, t1 = sorted[sorted.length - 1].ts;
  const step = Math.max(1, (t1 - t0) / points);
  const bounds = []; for (let i = 1; i <= points; i++) bounds.push(t0 + step * i);

  // single-pass replay; snapshot forensic metrics at each time bound
  const bal = new Map();
  const recent = []; let rs0 = 0; // rolling 30-min send window for live-dumping, front-trimmed by pointer
  const series = [];
  const buyers = new Set(); let volAccum = 0; // cumulative UNIQUE buyer wallets + per-bucket buy volume (tokens)
  const snap = (T) => {
    while (rs0 < recent.length && recent[rs0].ts < T - 1800) rs0++;
    let held = 0, sniperHeld = 0, bundleHeld = 0, creatorBal = 0; const bags = [];
    for (const [a, v] of bal) { if (v > 1e-9 && !isInfra(a)) { held += v; bags.push(v); if (snipers.has(a)) sniperHeld += v; if (bundleWallets.has(a)) bundleHeld += v; if (a === creator) creatorBal = v; } }
    held = held || 1; bags.sort((x, y) => y - x);
    const top10 = bags.slice(0, 10).reduce((s, v) => s + v, 0);
    let dump = 0; const sellers = new Set();
    for (let i = rs0; i < recent.length; i++) { const r = recent[i]; if (r.ts <= T && insiderSet.has(r.w)) { dump += r.amt; sellers.add(r.w); } }
    const pct = (x) => +(x / held * 100).toFixed(2);
    const r = computeRisk({ f_snipe: pct(sniperHeld), f_bundle: pct(bundleHeld), f_top10: pct(top10), f_creator: pct(creatorBal), f_dumpNow: +(dump / held * 100).toFixed(2), nBundles, nSnipers: snipers.size, nSellers: sellers.size, grad });
    // winner-corridor placement at this historical moment: the same blueprint + trajectory the live board uses,
    // so the token's path can be drawn THROUGH the study's healthy cone (is it tracking the winner band by age?).
    const ageH = Math.max(0, (T - t0) / 3600);
    const bp = blueprintMatch({ bundles: nBundles, top10Pct: pct(top10), holders: bags.length, risk: r.risk });
    const traj = liveTrajectory({ blueprint: bp, holders: bags.length, ageH });
    series.push({ t: Math.round(T), risk: r.risk, label: r.label, top10: pct(top10), sniperHeld: pct(sniperHeld), holders: bags.length, wallets: buyers.size, bundles: nBundles, topFactor: r.topFactor, volTok: +volAccum.toFixed(2), price: null, ageH: +ageH.toFixed(2), blueprint: bp, traj });
    volAccum = 0;
  };
  let bi = 0;
  for (const e of sorted) {
    while (bi < bounds.length && e.ts > bounds[bi]) snap(bounds[bi++]);
    if (!isInfra(e.from)) { bal.set(e.from, (bal.get(e.from) || 0) - e.amt); recent.push({ ts: e.ts, w: e.from, amt: e.amt }); }
    if (!isInfra(e.to)) bal.set(e.to, (bal.get(e.to) || 0) + e.amt);
    if (isBuy(e) && !isInfra(e.to)) { buyers.add(e.to); volAccum += e.amt; } // a real buy from the pool → unique wallet + volume
  }
  while (bi < bounds.length) snap(bounds[bi++]);

  // PRICE: one representative (median-size) swap per bucket → receipt → price; forward/back fill gaps.
  // Skipped in profile mode (noPrice) — the cohort blueprint only needs the score/distribution trajectory.
  if (opts.noPrice) return { addr, sym: opts.sym, graduated: grad, points: series.length, firstPoolBlock: firstPool, snipers: snipers.size, bundles: nBundles, t0, t1, transfers: sorted.length, capped: sorted.length >= (opts.cap || 400000), corridor: corridorBins(), series };
  const buckets = Array.from({ length: bounds.length }, () => []);
  for (const e of sorted) if ((isBuy(e) || isSell(e)) && e.amt > 0) { const k = Math.min(bounds.length - 1, Math.max(0, Math.floor((e.ts - t0) / step))); buckets[k].push(e); }
  const prices = new Array(bounds.length).fill(null);
  // store transfers carry no tx hash, so resolve one per representative swap via a single-block eth_getLogs
  // (cheap; matches by amount). Sampled to ~45 buckets across the whole timeline to keep it fast; gaps are
  // forward/back-filled + smoothed below. Cached so a busy block isn't refetched.
  const hashCache = new Map();
  const hashFor = async (rep) => {
    if (rep.hash) return rep.hash;
    try {
      let logs = hashCache.get(rep.block);
      if (!logs) { logs = await rpc("eth_getLogs", [{ address: addr, topics: [TRANSFER], fromBlock: hx(rep.block), toBlock: hx(rep.block) }], 2); hashCache.set(rep.block, logs || []); }
      let best = null, bd = Infinity;
      for (const l of logs || []) { const v = Number(big(l.data)) / 1e18, d = Math.abs(v - rep.amt); if (d < bd) { bd = d; best = l.transactionHash; } }
      return best;
    } catch { return null; }
  };
  const STEP = Math.max(1, Math.round(bounds.length / 45)); // cap price samples to ~45 across the full timeline
  for (let k = 0; k < buckets.length; k += STEP) {
    const arr = buckets[k]; if (!arr.length) continue;
    arr.sort((a, b) => a.amt - b.amt);
    const rep = arr[Math.floor(arr.length / 2)];
    const hash = await hashFor(rep); if (!hash) continue;
    const p = await swapPrice(hash, addr, ethUsd, venues);
    if (p) prices[k] = p;
  }
  // local-outlier guard: a real price trends across buckets; a >6× jump vs the local median of sampled prices is
  // a bad receipt (multi-token tx), so drop it before filling.
  const sampled = prices.map((p, i) => ({ p, i })).filter((x) => x.p != null);
  for (const x of sampled) {
    const win = sampled.filter((y) => y !== x && Math.abs(y.i - x.i) <= 4).map((y) => y.p).sort((a, b) => a - b);
    if (win.length >= 3) { const med = win[Math.floor(win.length / 2)]; if (x.p > med * 6 || x.p < med / 6) prices[x.i] = null; }
  }
  let last = null; for (let k = 0; k < prices.length; k++) { if (prices[k] != null) last = prices[k]; else prices[k] = last; }
  let next = null; for (let k = prices.length - 1; k >= 0; k--) { if (prices[k] != null) next = prices[k]; else prices[k] = next; }
  // rolling-median smooth (w=5): the swap-implied price is a reconstruction; a transient pump/retrace or a lone
  // residual bad sample shouldn't set a stage valuation, so report the local typical price.
  const sm = prices.slice();
  for (let k = 0; k < prices.length; k++) { const w = []; for (let j = Math.max(0, k - 2); j <= Math.min(prices.length - 1, k + 2); j++) if (prices[j] != null) w.push(prices[j]); w.sort((a, b) => a - b); if (w.length) sm[k] = w[Math.floor(w.length / 2)]; }
  for (let k = 0; k < prices.length; k++) prices[k] = sm[k];
  // total supply (once) → market cap = price × supply; USD volume = token volume × price
  let supply = 0; try { supply = Number(big(await rpc("eth_call", [{ to: addr, data: "0x18160ddd" }, "latest"]).catch(() => "0x0"))) / 1e18; } catch { /* */ }
  for (let k = 0; k < series.length; k++) {
    series[k].price = prices[k];
    series[k].mcap = prices[k] != null && supply ? Math.round(prices[k] * supply) : null;
    series[k].volUsd = prices[k] != null ? Math.round(series[k].volTok * prices[k]) : null;
  }

  // PER-WALLET PnL: with the price series in hand, replay pool trades through the avg-cost engine so every trader
  // gets realized (on coins sold) + unrealized (on coins still held) profit. This is what lets the token page show
  // whether the wallets buying/selling are up or down — and it's the base layer for the follow-worthy list.
  const priceAt = (ts) => { if (ts == null) return null; const k = Math.min(prices.length - 1, Math.max(0, Math.floor((ts - t0) / step))); return prices[k]; };
  const curPrice = prices.length ? prices[prices.length - 1] : null;
  const trades = tradesFromTransfers(sorted, { isBuy, isSell, priceAt });
  const pnlMap = walletPnl(trades, curPrice);
  const pnl = [...pnlMap.entries()].map(([a, e]) => ({ a, ...e }))
    .filter((e) => e.invested > 0 || e.realized !== 0) // real traders only
    .sort((x, y) => Math.abs(y.pnl) - Math.abs(x.pnl))
    .slice(0, 100);
  const traders = pnl.length;
  const winners = pnl.filter((e) => e.up).length;

  // OPTIONAL per-wallet trade points for the "where it bought & sold" chart on the wallet page. Only built when
  // asked (opts.walletTrades = an address) so it never bloats the shared/cached generic backtest. Each point is a
  // POOL buy/sell at its swap-implied price — the same events the PnL engine accounts, so the orbs and the $ figure
  // are one reconstruction.
  let walletTrades = null;
  if (opts.walletTrades) {
    const wa = String(opts.walletTrades).toLowerCase();
    walletTrades = [];
    for (const e of sorted) {
      if (!(e.amt > 0)) continue;
      const buy = isBuy(e) && e.to === wa, sell = isSell(e) && e.from === wa;
      if (!buy && !sell) continue;
      const p = priceAt(e.ts); if (!(p > 0)) continue;
      walletTrades.push({ ts: e.ts, side: buy ? "buy" : "sell", price: +p.toFixed(8), qty: +e.amt.toFixed(2) });
    }
    walletTrades.sort((a, b) => a.ts - b.ts);
  }

  return {
    addr, sym: opts.sym, graduated: grad, points: series.length, ethUsd, supply,
    firstPoolBlock: firstPool, snipers: snipers.size, bundles: nBundles,
    t0, t1, transfers: sorted.length, corridor: corridorBins(), series,
    curPrice, pnl, pnlStats: { traders, winners, winnerPct: traders ? Math.round((winners / traders) * 100) : null },
    ...(walletTrades ? { walletTrades } : {}),
  };
}
