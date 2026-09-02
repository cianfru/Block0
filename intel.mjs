// Actionable launch intel for a token — the verdict engine + whale-entry map data. Exported so the
// discover-board worker can call it per token; also runnable as a CLI (node intel.mjs --addr=0x… --sym=X).
import { rpc } from "./rpc.mjs";
import { detectPool, ROUTERS } from "./engine.mjs";
import { getTransfers } from "./store.mjs";

const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Robinhood-chain quote assets for pricing (USDG ~ $1, WETH). Extend per chain.
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168", WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const big = (h) => BigInt(h || "0x0");

// Robinhood's tokenized-STOCK issuer — every tokenized equity/ETF (NVDA, PLTR, META, RDDT, SPY, SPCX…) is
// deployed by this one address. They're not Pons memecoins and their 99% concentration is structural, not a
// rug — so we exclude this deployer from the launch board. Extend if more issuers surface.
export const STOCK_ISSUERS = new Set(["0x2b94105fff37630f98e1f24811dad588fc5c3a87"]);
const _deployer = new Map(); // addr -> deployer EOA (immutable, cached)
export async function deployerOf(addr) {
  addr = addr.toLowerCase(); if (_deployer.has(addr)) return _deployer.get(addr);
  let dep = null;
  try {
    const at = await rpc("alchemy_getAssetTransfers", [{ fromBlock: "0x0", toBlock: "latest", contractAddresses: [addr], category: ["erc20"], order: "asc", maxCount: "0xa", withMetadata: true }]);
    const mint = (at?.transfers || []).find((x) => (x.from || "").toLowerCase() === ZERO) || at?.transfers?.[0];
    if (mint?.hash) { const tx = await rpc("eth_getTransactionByHash", [mint.hash]); dep = (tx?.from || "").toLowerCase() || null; }
  } catch { /* */ }
  _deployer.set(addr, dep); return dep;
}
export async function isTokenizedStock(addr) { return STOCK_ISSUERS.has(await deployerOf(addr)); }

// The risk model, extracted so the live board AND the historical backtest score identically. Inputs are held
// SUPPLY shares (of the real distributed float) + counts; graduation flips the weights. Two disqualifying floors
// (near-total concentration, or insiders selling now) sit on top of the weighted mean. Returns {parts,risk,label,topFactor}.
export function computeRisk({ f_snipe = 0, f_bundle = 0, f_top10 = 0, f_creator = 0, f_dumpNow = 0, nBundles = 0, nSnipers = 0, nSellers = 0, grad = false }) {
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const parts = {
    bundles: Math.round(clamp(f_bundle * 3 + nBundles * 12)),
    snipers: Math.round(clamp(f_snipe * 0.9 + Math.max(0, nSnipers - 3) * 8)),
    concentration: Math.round(clamp((f_top10 - (grad ? 15 : 25)) * 1.5)),
    dumping: Math.round(clamp(f_dumpNow * 4 + nSellers * 10)),
    deployer: Math.round(clamp(f_creator * 3)),
  };
  const w = grad
    ? { concentration: 0.42, dumping: 0.28, bundles: 0.10, snipers: 0.12, deployer: 0.08 }
    : { concentration: 0.30, bundles: 0.24, dumping: 0.22, snipers: 0.16, deployer: 0.08 };
  const weighted = parts.bundles * w.bundles + parts.snipers * w.snipers + parts.concentration * w.concentration
    + parts.dumping * w.dumping + parts.deployer * w.deployer;
  const concFloor = f_top10 >= 92 ? 72 : f_top10 >= 82 ? 55 : f_top10 >= 72 ? 40 : 0;
  const dumpFloor = nSellers >= 2 ? 58 : f_dumpNow >= 20 ? 50 : 0;
  const floor = Math.max(concFloor, dumpFloor);
  const risk = Math.round(clamp(Math.max(weighted, floor)));
  const label = risk >= 66 ? "HIGH RISK" : risk >= 45 ? "CAUTION" : risk >= 25 ? "MIXED" : "LOOKS CLEANER";
  const contrib = Object.fromEntries(Object.keys(parts).map((k) => [k, parts[k] * w[k]]));
  if (floor > weighted) contrib[concFloor >= dumpFloor ? "concentration" : "dumping"] = floor;
  const driver = Object.entries(contrib).sort((a, b) => b[1] - a[1])[0];
  return { parts, risk, label, topFactor: driver && driver[1] > 3 ? driver[0] : null };
}

// market cap = supply × price, where price = median USD paid per token across recent swaps (from tx receipts).
// The AMM here is a singleton, so per-pair reserves aren't readable — the honest price is what swaps actually paid.
export async function computeMcap(addr, wethUsd = 3000) {
  try {
    const supHex = (await rpc("eth_call", [{ to: addr, data: "0x18160ddd" }, "latest"]));
    const supply = Number(big(supHex)) / 1e18;
    const at = await rpc("alchemy_getAssetTransfers", [{ fromBlock: "0x0", toBlock: "latest", contractAddresses: [addr], category: ["erc20"], order: "desc", maxCount: "0x14", withMetadata: true }]);
    const prices = [];
    for (const t of (at?.transfers || []).slice(0, 12)) {
      const rc = await rpc("eth_getTransactionReceipt", [t.hash]); const logs = rc?.logs || [];
      let tok = 0, usd = 0;
      for (const l of logs) { if ((l.topics?.[0] || "") !== TRANSFER) continue; const a = l.address.toLowerCase(); const v = Number(big(l.data));
        if (a === addr) tok = Math.max(tok, v / 1e18);
        else if (a === USDG) usd = Math.max(usd, v / 1e6);
        else if (a === WETH) usd = Math.max(usd, (v / 1e18) * wethUsd); }
      if (tok > 0 && usd > 0) prices.push(usd / tok);
    }
    prices.sort((a, b) => a - b);
    const price = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
    return { price, mcap: price * supply, supply, samples: prices.length };
  } catch { return { price: 0, mcap: 0, supply: 0, samples: 0 }; }
}

// MC buckets + how hot to monitor them (the owner's decay model): fresh sub-$500k is the ape zone (full risk
// verdict, hot refresh); as MC grows the early-rug question fades and distribution/traction matters more; past
// ~$10M the move has happened → cold / on-demand only.
export function bucketOf(mcap) {
  if (!mcap || mcap <= 0) return { key: "fresh", label: "Fresh · <$500k", monitor: "hot", tier: 0 };
  if (mcap < 5e5) return { key: "fresh", label: "Fresh · <$500k", monitor: "hot", tier: 0 };
  if (mcap < 1e6) return { key: "graduating", label: "$500k–$1M", monitor: "hot", tier: 1 };
  if (mcap < 5e6) return { key: "traction", label: "$1M–$5M", monitor: "warm", tier: 2 };
  if (mcap < 1e7) return { key: "established", label: "$5M–$10M", monitor: "cool", tier: 3 };
  return { key: "graduated", label: ">$10M · graduated", monitor: "ondemand", tier: 4 };
}

// "Blueprint match" 0–100 — how well a token fits the winner fingerprint extracted from the top graduated
// cohort (see the Success Blueprint study). Validated discriminators, in order of weight: NO bundles (the veto),
// a float that isn't stuck in a few hands, a clean/settled risk, and real holder adoption. Deliberately does NOT
// reward low sniper-held — the cohort showed heavy early snipers were survivable; bundles are what kill.
export function blueprintMatch({ bundles = 0, top10Pct = 100, holders = 0, risk = 100 }) {
  let s = 0;
  s += bundles === 0 ? 40 : bundles === 1 ? 12 : 0;                                   // bundles = the hard veto
  s += top10Pct <= 40 ? 25 : top10Pct <= 60 ? 16 : top10Pct <= 80 ? 7 : 0;            // float opened up
  s += risk < 25 ? 20 : risk < 45 ? 10 : 0;                                           // score settled clean
  s += holders >= 200 ? 15 : holders >= 80 ? 10 : holders >= 30 ? 5 : 0;              // real adoption
  return Math.round(Math.max(0, Math.min(100, s)));
}
export const blueprintLabel = (m) => m >= 75 ? "STRONG FIT" : m >= 55 ? "PARTIAL FIT" : m >= 35 ? "WEAK FIT" : "OFF-BLUEPRINT";

export async function computeIntel(addr, sym = "?", opts = {}) {
  addr = addr.toLowerCase();
  const t0ms = Date.now();
  // Incremental store: pulls only the delta since last call and caches the deploy block (free on Alchemy).
  const { ev, pool: poolStore, latest } = await getTransfers(addr, 18, { pool: opts.pool, launchedAt: opts.launchedAt });
  const ponsPool = (opts.pool || "").toLowerCase();
  const detected = detectPool(ev); // highest-degree address = the bonding curve / trading contract
  const pool = ponsPool || poolStore || detected; // the venue we report
  // The bonding curve holds all UNDISTRIBUTED supply and touches every pre-graduation trade, so it is the
  // highest-degree address. Pre-graduation it is a DIFFERENT address from the Pons graduation-AMM pool, so we
  // must treat BOTH as venues/infra — otherwise the curve's reserve reads as one giant "sniper" holding ~half
  // the supply and inflates every concentration number. (Post-graduation the curve has emptied → no-op there.)
  const AMM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Robinhood singleton AMM
  const venues = new Set([ponsPool, poolStore, detected, AMM].filter(Boolean));
  const isBuy = (e) => venues.has(e.from) || ROUTERS.has(e.from), isSell = (e) => venues.has(e.to) || ROUTERS.has(e.to);
  const isInfra = (a) => a === ZERO || a === DEAD || venues.has(a) || ROUTERS.has(a);
  const tsMax = Math.max(...ev.map((e) => e.ts || 0)), tsMin = Math.min(...ev.map((e) => e.ts || 1e18));
  const RECENT = tsMax - 1800; // last 30 min = "now"

  const W = new Map(); const g = (a) => { let w = W.get(a); if (!w) W.set(a, w = { a, bal: 0, bought: 0, sold: 0, first: null, firstBlk: null, recvRecent: 0, sentRecent: 0 }); return w; };
  let firstPool = null, creator = null, buys = 0, sells = 0, buyR = 0, sellR = 0;
  for (const e of ev) {
    if (isBuy(e) && firstPool == null) firstPool = e.block;
    if (!isInfra(e.from)) { const w = g(e.from); w.bal -= e.amt; if (isSell(e)) { w.sold += e.amt; sells++; } if (e.ts > RECENT) { w.sentRecent += e.amt; if (isSell(e)) sellR += e.amt; } }
    if (!isInfra(e.to)) { const w = g(e.to); w.bal += e.amt; if (isBuy(e)) { w.bought += e.amt; buys++; } if (w.first == null) { w.first = e.ts; w.firstBlk = e.block; } if (e.ts > RECENT) { w.recvRecent += e.amt; if (isBuy(e)) buyR += e.amt; } }
    if (e.from === ZERO && creator == null && !isInfra(e.to)) creator = e.to;
  }
  const holders = [...W.values()].filter((w) => w.bal > 1e-9);
  const held = holders.reduce((s, w) => s + w.bal, 0) || 1;
  for (const w of W.values()) w.sniper = w.firstBlk != null && firstPool != null && w.firstBlk <= firstPool + 3 && w.bought > 0;
  const byBlk = new Map(); for (const w of W.values()) if (w.sniper) { if (!byBlk.has(w.firstBlk)) byBlk.set(w.firstBlk, []); byBlk.get(w.firstBlk).push(w); }
  const bundles = [...byBlk.entries()].filter(([, l]) => l.length >= 2).map(([blk, l]) => ({ blk, n: l.length, wallets: l.map((w) => w.a), held: l.reduce((s, w) => s + Math.max(0, w.bal), 0) }));
  const sniperW = [...W.values()].filter((w) => w.sniper);
  const sniperHeld = sniperW.reduce((s, w) => s + Math.max(0, w.bal), 0);
  const bundleHeld = bundles.reduce((s, b) => s + b.held, 0);
  const top10 = holders.slice().sort((a, b) => b.bal - a.bal).slice(0, 10).reduce((s, w) => s + w.bal, 0);
  const creatorBal = creator ? Math.max(0, (W.get(creator)?.bal || 0)) : 0;
  const bundleSet = new Set(bundles.flatMap((b) => b.wallets));
  const insiderSet = new Set([...sniperW.map((w) => w.a), ...bundleSet]);
  let insiderDumpNow = 0, insiderSellers = 0;
  for (const a of insiderSet) { const w = W.get(a); if (!w) continue; const net = w.recvRecent - w.sentRecent; if (net < 0) { insiderDumpNow += -net; insiderSellers++; } }
  const pct = (x) => +(x / held * 100).toFixed(1);
  const f_snipe = pct(sniperHeld), f_bundle = pct(bundleHeld), f_top10 = pct(top10), f_creator = pct(creatorBal);
  const f_dumpNow = +(insiderDumpNow / held * 100).toFixed(2);
  // Risk = five interpretable sub-scores + two disqualifying floors — see computeRisk (shared with the backtest).
  const grad = !!opts.graduated;
  const { parts, risk, label, topFactor } = computeRisk({ f_snipe, f_bundle, f_top10, f_creator, f_dumpNow,
    nBundles: bundles.length, nSnipers: sniperW.length, nSellers: insiderSellers, grad });
  // momentum: recent buy vs sell + holder base + freshness (for ranking "what's heating up")
  const spanH = +((tsMax - tsMin) / 3600).toFixed(1);
  const netR = buyR - sellR;
  const momentum = Math.round(Math.max(-100, Math.min(100, (netR / held * 100) * 6 + (holders.length > 50 ? 10 : 0))));

  const out = { sym, address: addr, pool, updated: Date.now(), latestBlock: latest, ageH: spanH, ms: Date.now() - t0ms,
    risk, label, momentum, parts, topFactor, graduated: grad,
    flags: { snipers: sniperW.length, sniperHeldPct: f_snipe, bundles: bundles.length, bundleWallets: bundleSet.size, bundleHeldPct: f_bundle,
      top10Pct: f_top10, holders: holders.length, creatorPct: f_creator, insiderDumpNowPct: f_dumpNow, insiderSellersNow: insiderSellers,
      buysRecent: buys, sellsRecent: sells } };
  if (opts.mcapUsd != null) { out.mcapUsd = Math.round(opts.mcapUsd); out.bucket = bucketOf(opts.mcapUsd); } // from Pons API — accurate, no receipts
  else if (opts.mcap !== false) { const m = await computeMcap(addr); out.priceUsd = m.price; out.mcapUsd = Math.round(m.mcap); out.mcapSamples = m.samples; out.bucket = bucketOf(m.mcap); }
  if (opts.whales !== false) {
    out.bundles = bundles.slice(0, 10);
    out.whales = holders.slice().sort((a, b) => b.bal - a.bal).slice(0, 60).map((w) => ({ a: w.a, bal: +w.bal.toFixed(0), first: w.first, bought: +w.bought.toFixed(0), sold: +w.sold.toFixed(0), net: +(w.recvRecent - w.sentRecent).toFixed(0), sniper: w.sniper }));
    out.tsMin = tsMin; out.tsMax = tsMax;
  }
  return out;
}

// discover the most-active non-infra tokens right now (chain-wide recent ERC-20 transfers)
export async function discoverTokens(n = 14) {
  const at = await rpc("alchemy_getAssetTransfers", [{ fromBlock: "0x0", toBlock: "latest", category: ["erc20"], order: "desc", maxCount: "0x3e8", withMetadata: true }]);
  const tok = new Map();
  for (const t of at?.transfers || []) { const a = (t.rawContract?.address || "").toLowerCase(); if (!a) continue; let e = tok.get(a); if (!e) tok.set(a, e = { a, sym: t.asset || "?", n: 0, newest: t.metadata?.blockTimestamp }); e.n++; }
  const infra = new Set(["usdg", "weth", "usdc", "usdt", "wbtc", "dai"]);
  return [...tok.values()].filter((e) => !infra.has((e.sym || "").toLowerCase())).sort((a, b) => b.n - a.n).slice(0, n);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
  const { writeFile } = await import("node:fs/promises");
  const r = await computeIntel(args.addr, args.sym || "?");
  await writeFile("intel.json", JSON.stringify(r));
  console.log(`${r.sym} ${r.address} — RISK ${r.risk}/100 ${r.label} | holders ${r.flags.holders} | snipers ${r.flags.snipers} (${r.flags.sniperHeldPct}%) | bundles ${r.flags.bundles} | top10 ${r.flags.top10Pct}% | dumping ${r.flags.insiderSellersNow}`);
}
