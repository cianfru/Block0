// Historical BACKTEST of a token: replay its whole transfer history and snapshot the forensic SCORE at
// even time intervals, alongside a swap-implied PRICE sampled across the timeline. Answers "what did this
// winner look like BEFORE it exploded" — did concentration fall, did snipers bleed out, when did it read clean.
//
// The score reconstruction is exact and free (pure transfer replay, same computeRisk the live board uses).
// Price has no Pons API, so we reconstruct it from swaps: one representative swap per time bucket, its receipt
// gives token-out vs WETH/USDG-in → price. Sampled to `points` buckets so it's ~points receipt calls, one-time.
// Alchemy-only (uses the enhanced getAssetTransfers to keep tx hashes for the receipt lookups).
import { detectPool, ROUTERS } from "./engine.mjs";
import { computeRisk } from "./intel.mjs";
import { rpc, hx } from "./rpc.mjs";

const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const AMM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // RH singleton AMM
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73", USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const big = (h) => BigInt(h && h !== "0x" ? h : "0x0"); // guard empty "0x" data fields

// full transfer history WITH tx hashes (needed for receipt-based price). Alchemy enhanced API, paged.
async function pullWithHash(addr) {
  const ev = []; let pageKey, guard = 0;
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
  } while (pageKey && ++guard < 400);
  return ev;
}

// price of one swap tx = quote paid (WETH×ethUsd or USDG) ÷ token received/sent, from its receipt logs
async function swapPrice(hash, addr, ethUsd) {
  const rc = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
  let tok = 0, quote = 0;
  for (const l of rc?.logs || []) {
    if ((l.topics?.[0] || "") !== TRANSFER) continue;
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
  const ev = await pullWithHash(addr);
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
    series.push({ t: Math.round(T), risk: r.risk, label: r.label, top10: pct(top10), sniperHeld: pct(sniperHeld), holders: bags.length, bundles: nBundles, topFactor: r.topFactor, price: null });
  };
  let bi = 0;
  for (const e of sorted) {
    while (bi < bounds.length && e.ts > bounds[bi]) snap(bounds[bi++]);
    if (!isInfra(e.from)) { bal.set(e.from, (bal.get(e.from) || 0) - e.amt); recent.push({ ts: e.ts, w: e.from, amt: e.amt }); }
    if (!isInfra(e.to)) bal.set(e.to, (bal.get(e.to) || 0) + e.amt);
  }
  while (bi < bounds.length) snap(bounds[bi++]);

  // PRICE: one representative (median-size) swap per bucket → receipt → price; forward/back fill gaps
  const buckets = Array.from({ length: bounds.length }, () => []);
  for (const e of sorted) if ((isBuy(e) || isSell(e)) && e.amt > 0 && e.hash) { const k = Math.min(bounds.length - 1, Math.max(0, Math.floor((e.ts - t0) / step))); buckets[k].push(e); }
  const prices = new Array(bounds.length).fill(null);
  for (let k = 0; k < buckets.length; k++) {
    const arr = buckets[k]; if (!arr.length) continue;
    arr.sort((a, b) => a.amt - b.amt);
    const p = await swapPrice(arr[Math.floor(arr.length / 2)].hash, addr, ethUsd);
    if (p) prices[k] = p;
  }
  let last = null; for (let k = 0; k < prices.length; k++) { if (prices[k] != null) last = prices[k]; else prices[k] = last; }
  let next = null; for (let k = prices.length - 1; k >= 0; k--) { if (prices[k] != null) next = prices[k]; else prices[k] = next; }
  for (let k = 0; k < series.length; k++) series[k].price = prices[k];

  return {
    addr, sym: opts.sym, graduated: grad, points: series.length, ethUsd,
    firstPoolBlock: firstPool, snipers: snipers.size, bundles: nBundles,
    t0, t1, transfers: sorted.length, series,
  };
}
