// The DISCOVER BOARD engine: scan every live Robinhood-chain / Pons launch, verdict + market-cap-bucket each,
// and keep a ranked, cached board. Fresh sub-$500k launches are the flagship (hot); bigger caps decay to
// warm/cool; past ~$10M they're on-demand only. A background refresh keeps the cache current for /api/board.
//
// Discovery today = chain-wide active-token scan. Completeness upgrade (found): eth_subscribe to the Pons
// factory contracts for a launch event the instant a token is created — see PONS_FACTORIES below.
import { computeIntel, discoverTokens, bucketOf, isTokenizedStock } from "./intel.mjs";

// Pons launchpad factory contracts on Robinhood mainnet (chainId 4663) — watch these for every new launch.
export const PONS_FACTORIES = ["0x0c37a24f5d23a486fa692d1500881d698b1f77a4", "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb"];

let CACHE = { updated: 0, scanning: false, tokens: [], buckets: {} };
const BUCKET_ORDER = ["fresh", "graduating", "traction", "established", "graduated"];
const FIRST_SEEN = new Map(); // token addr -> ms first seen on the board (drives the "new launch" vibration)
let BOOTED = false;           // don't mark everything "new" on the very first scan
const NEW_MS = 150000;        // a card counts as newly-launched (vibrates) for this long after first sighting
// QUALITY FLOOR — the launchpad has millions of dead $0–4k dust tokens; a board of those is worthless. Keep
// only tokens that clear a real bar: enough market cap OR a real holder base. Everything below is invisible
// (still scannable on-demand by pasting the contract). Tune via env.
const MIN_MCAP = Number(process.env.MIN_MCAP || 20000);   // $20k market-cap floor
const MIN_HOLDERS = Number(process.env.MIN_HOLDERS || 40); // …or a genuine holder base
const worthShowing = (r) => (r.mcapUsd || 0) >= MIN_MCAP || (r.flags?.holders || 0) >= MIN_HOLDERS;

// an "ape score" for ranking within a bucket: cleaner + heating + not-dumping rises. Higher = more interesting.
const apeScore = (r) => (100 - r.risk) + Math.max(-30, Math.min(30, r.momentum)) - (r.flags.insiderSellersNow || 0) * 6;

export async function refreshBoard({ n = 16, whales = false } = {}) {
  if (CACHE.scanning) return CACHE;
  CACHE.scanning = true;
  try {
    const disc = await discoverTokens(n);
    // drop tokenized stocks (Robinhood equity issuer) — not Pons memecoins; keep the board to launches
    const toks = [];
    for (const t of disc) { try { if (!(await isTokenizedStock(t.a))) toks.push(t); } catch { toks.push(t); } }
    const out = [];
    for (const t of toks) {
      try {
        const r = await computeIntel(t.a, t.sym, { whales, mcap: true });
        r.ape = Math.round(apeScore(r));
        const known = FIRST_SEEN.has(r.address); if (!known) FIRST_SEEN.set(r.address, Date.now());
        r.firstSeenAt = FIRST_SEEN.get(r.address);
        r.isNew = BOOTED && !known;                 // truly new since the last scan
        if (worthShowing(r)) out.push(r);           // prune dead dust below the quality floor

      } catch { /* skip a token that fails to scan this pass */ }
    }
    BOOTED = true;
    // group by bucket, rank cleanest/most-interesting first inside each
    const buckets = {};
    for (const key of BUCKET_ORDER) buckets[key] = [];
    for (const r of out) (buckets[r.bucket?.key || "fresh"] ||= []).push(r);
    for (const key of Object.keys(buckets)) buckets[key].sort((a, b) => a.risk - b.risk || b.ape - a.ape);
    out.sort((a, b) => (a.bucket?.tier ?? 0) - (b.bucket?.tier ?? 0) || a.risk - b.risk || b.ape - a.ape);
    CACHE = { updated: Date.now(), scanning: false, tokens: out, buckets, order: BUCKET_ORDER };
  } finally { CACHE.scanning = false; }
  return CACHE;
}

export function getBoard() { return CACHE; }

// kick a refresh if the cache is older than `maxAgeMs`; returns the (possibly stale) cache immediately
export function ensureFresh(maxAgeMs = 90000) {
  if (!CACHE.scanning && Date.now() - CACHE.updated > maxAgeMs) refreshBoard().catch(() => {});
  return CACHE;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = await refreshBoard({ n: 12 });
  const $ = (x) => x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
  console.log(`\nBOARD — ${b.tokens.length} tokens · ${new Date(b.updated).toISOString()}\n`);
  for (const key of b.order) { const g = b.buckets[key] || []; if (!g.length) continue;
    console.log(`── ${bucketOf(key==="fresh"?0:key==="graduating"?6e5:key==="traction"?2e6:key==="established"?7e6:2e7).label}  (${g.length}) ──`);
    for (const r of g) console.log(`   ${(r.sym||"?").slice(0,12).padEnd(13)} MC ${$(r.mcapUsd).padStart(7)}  RISK ${String(r.risk).padStart(3)} ${r.label.padEnd(13)} · ${r.flags.holders} holders · snipers ${r.flags.snipers} · dump ${r.flags.insiderSellersNow||0}`);
  }
}
