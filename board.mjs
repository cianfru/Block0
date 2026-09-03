// The DISCOVER BOARD: the Robinhood-Chain / Pons launch universe, verdicted. Discovery, market caps, logos,
// graduation status and progress all come from the Pons API (source of truth); the FORENSIC verdict
// (snipers / bundles / concentration / live dumping) is our on-chain layer computed per token on top.
//
// Two universes, matching how the launchpad actually works:
//   • cooking   — active pre-graduation tokens, ranked by how close they are to graduating (bonding-curve %).
//                 The "get in before it graduates" zone. (Active tokens cap ~$40k and graduate at 4.2 ETH.)
//   • graduated — the ~510 tokens that completed the curve: the investable universe, ranked by market cap.
// The ~4.2M dead-dust launches never appear — we only verdict what the launchpad surfaces as live/graduated.
import { computeIntel, blueprintMatch, blueprintLabel } from "./intel.mjs";
import { fetchActive, fetchGraduated } from "./pons.mjs";
import { recentDexTokens } from "./dex.mjs";
import { keep, storeStats } from "./store.mjs";
import { pathPosition, liveTrajectory, corridorStatus } from "./model.mjs";

export const PONS_FACTORIES = ["0x0c37a24f5d23a486fa692d1500881d698b1f77a4", "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb"];
const N_ACTIVE = Number(process.env.BOARD_ACTIVE || 16); // pre-graduation tokens to verdict per refresh
const N_GRAD = Number(process.env.BOARD_GRAD || 24);     // graduated (higher-MC) tokens to verdict per refresh
const N_DEX = Number(process.env.BOARD_DEX || 10);       // non-Pons DEX-listed tokens to verdict per refresh
const DEX_MIN_HOLDERS = Number(process.env.DEX_MIN_HOLDERS || 5); // spam floor for a discovered DEX token
const NEW_MS = 150000;

let CACHE = { updated: 0, scanning: false, cooking: [], graduated: [], stats: {} };
const FIRST_SEEN = new Map(); let BOOTED = false;

const apeScore = (r) => Math.round((100 - r.risk) + Math.max(-30, Math.min(30, r.momentum)) - (r.flags.insiderSellersNow || 0) * 6);

async function verdict(meta) {
  const r = await computeIntel(meta.address, meta.sym, { pool: meta.pool, mcapUsd: meta.mcapUsd, graduated: meta.graduated, launchedAt: meta.launchedAt, whales: false });
  r.name = meta.name; r.logo = meta.logo; r.progress = meta.progress; r.graduated = meta.graduated;
  r.launchedAt = meta.launchedAt; r.mcapUsd = Math.round(meta.mcapUsd || r.mcapUsd || 0);
  r.ape = apeScore(r);
  r.blueprint = blueprintMatch({ bundles: r.flags.bundles, top10Pct: r.flags.top10Pct, holders: r.flags.holders, risk: r.risk });
  r.blueprintLabel = blueprintLabel(r.blueprint);
  // live placement on the winner valuation ladder: this token's unique wallets → precedent mcap, and where its
  // current mcap sits vs the winner band at that stage
  r.wallets = r.flags.wallets || r.flags.holders;
  r.path = pathPosition(r.wallets, r.mcapUsd);
  // age-based trajectory corridor: this token's live score vs the winner healthy-zone at its age
  const ageH = meta.launchedAt ? (Date.now() - Date.parse(meta.launchedAt)) / 3.6e6 : (r.ageH || 0);
  r.ageH = +ageH.toFixed(1);
  r.trajectory = liveTrajectory({ blueprint: r.blueprint, holders: r.flags.holders, ageH });
  r.corridor = corridorStatus(ageH, r.trajectory);
  const known = FIRST_SEEN.has(r.address); if (!known) FIRST_SEEN.set(r.address, Date.now());
  r.firstSeenAt = FIRST_SEEN.get(r.address); r.isNew = BOOTED && !known;
  return r;
}

export async function refreshBoard() {
  if (CACHE.scanning) return CACHE;
  CACHE = { ...CACHE, scanning: true };
  try {
    const [active, grad] = await Promise.all([fetchActive({ sort: "marketCap", pageSize: N_ACTIVE * 2 }), fetchGraduated()]);
    const activePick = active.items.filter((t) => t.address && t.mcapUsd > 0).slice(0, N_ACTIVE);
    const gradPick = grad.items.filter((t) => t.address).sort((a, b) => b.mcapUsd - a.mcapUsd).slice(0, N_GRAD);
    const cooking = [], graduated = [];
    for (const m of activePick) { try { cooking.push(await verdict(m)); } catch { /* skip */ } }
    for (const m of gradPick) { try { graduated.push(await verdict(m)); } catch { /* skip */ } }
    cooking.sort((a, b) => (b.progress || 0) - (a.progress || 0) || a.risk - b.risk);
    graduated.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0));
    keep([...cooking, ...graduated, ...(CACHE.dex || [])].map((r) => r.address)); // bound store memory to the live board
    PONS_ADDRS = new Set([...(active.items || []), ...(grad.items || [])].map((t) => (t.address || "").toLowerCase()));
    BOOTED = true;
    CACHE = { updated: Date.now(), scanning: false, cooking, graduated, dex: CACHE.dex || [],
      stats: { launchTotal: active.launchTotal, activeTotal: active.total, graduatedTotal: grad.total, dexTotal: (CACHE.dex || []).length, store: storeStats() } };
  } finally { CACHE = { ...CACHE, scanning: false }; }
  return CACHE;
}

// DEX discovery runs on its OWN interval, decoupled from the Pons board so its (slower) Alchemy verdicts never delay
// the core board. Discovers recent non-Pons v4 listings, dedupes against the Pons universe, verdicts a bounded set,
// keeps ones above the spam floor, and merges into CACHE.dex.
let DEX_SCANNING = false, PONS_ADDRS = new Set();
export async function refreshDex() {
  if (DEX_SCANNING || N_DEX <= 0) return CACHE;
  DEX_SCANNING = true;
  try {
    const cand = await recentDexTokens({ blocks: Number(process.env.DEX_BLOCKS || 80000), limit: N_DEX * 3 });
    const picks = (cand.tokens || []).filter((m) => !PONS_ADDRS.has(m.address)).slice(0, N_DEX);
    const dnew = [];
    for (const m of picks) {
      try {
        const v = await verdict({ address: m.address, sym: m.symbol, name: m.name || null, pool: null, graduated: false, launchedAt: null });
        if ((v.flags?.holders || 0) >= DEX_MIN_HOLDERS) { v.venue = m.venue; v.dexBlock = m.block; dnew.push(v); }
      } catch { /* skip */ }
    }
    if (dnew.length) { dnew.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)); CACHE = { ...CACHE, dex: dnew }; }
  } catch { /* keep last DEX set */ } finally { DEX_SCANNING = false; }
  return CACHE;
}

export function getBoard() { return CACHE; }
export function ensureFresh(maxAgeMs = 90000) { if (!CACHE.scanning && Date.now() - CACHE.updated > maxAgeMs) refreshBoard().catch(() => {}); return CACHE; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = await refreshBoard();
  const $ = (x) => x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
  console.log(`\nBOARD · ${b.stats.launchTotal?.toLocaleString()} total launches · ${b.stats.activeTotal} active · ${b.stats.graduatedTotal} graduated\n`);
  console.log("── COOKING (about to graduate) ──");
  for (const r of b.cooking) console.log(`  ${(r.sym || "?").slice(0, 12).padEnd(13)} ${String(r.progress).padStart(3)}%  MC ${$(r.mcapUsd).padStart(6)}  RISK ${String(r.risk).padStart(3)} ${r.label.padEnd(13)} snipers ${r.flags.snipers} bundles ${r.flags.bundles} dump ${r.flags.insiderSellersNow || 0}`);
  console.log("\n── GRADUATED (the ~510 that made it) ──");
  for (const r of b.graduated) console.log(`  ${(r.sym || "?").slice(0, 12).padEnd(13)} MC ${$(r.mcapUsd).padStart(7)}  RISK ${String(r.risk).padStart(3)} ${r.label.padEnd(13)} top10 ${r.flags.top10Pct}% holders ${r.flags.holders}`);
}
