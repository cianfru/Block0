// The per-token DOSSIER — everything the /token page shows at first glance, in ONE provider-agnostic call.
// It reuses the exact same on-chain layer the board runs (computeIntel), so a token's verdict on its own page
// matches its board card, then adds the winner-study placements (blueprint fit, valuation ladder, corridor).
//
// This is deliberately separate from /api/backtest (the historical score/price replay, which is heavier and
// Alchemy-preferred): the dossier always resolves fast from the incremental store, so the page shows the full
// forensic read — snipers, bundles, concentration, who's buying/selling — even if the history chart is still loading.
import { computeIntel, blueprintMatch, blueprintLabel } from "./intel.mjs";
import { pathPosition, precedentValuation, liveTrajectory, corridorStatus } from "./model.mjs";
import { fetchActive, fetchGraduated } from "./pons.mjs";

let _metaCache = { at: 0, items: [] };
async function ponsMetaAll() {
  if (Date.now() - _metaCache.at < 60000 && _metaCache.items.length) return _metaCache.items;
  const [a, g] = await Promise.all([
    fetchActive({ pageSize: 400 }).catch(() => ({ items: [] })),
    fetchGraduated().catch(() => ({ items: [] })),
  ]);
  _metaCache = { at: Date.now(), items: [...(a.items || []), ...(g.items || [])] };
  return _metaCache.items;
}

// Deployer track record — RPC-free, from Pons's own `deployer` field: every other launch by the same wallet.
// This is the "is this a serial rugger or a proven builder" read, and it's always current (no accumulation needed).
function deployerReputation(all, meta) {
  const dep = (meta?.deployer || "").toLowerCase();
  if (!dep || /^0x0+$/.test(dep)) return null;
  const mine = all.filter((t) => (t.deployer || "").toLowerCase() === dep);
  const others = mine.filter((t) => (t.address || "").toLowerCase() !== (meta.address || "").toLowerCase());
  const graduated = mine.filter((t) => t.graduated).length;
  const launched = mine.length;
  // classification: a prior graduation is a genuine positive; many launches with none is a caution.
  const rep = graduated >= 1 ? "proven" : launched >= 3 ? "serial" : launched >= 2 ? "repeat" : "first";
  return {
    address: dep, launched, graduated,
    reputation: rep,
    others: others.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, 8)
      .map((t) => ({ sym: t.sym, address: t.address, mcapUsd: Math.round(t.mcapUsd || 0), graduated: !!t.graduated })),
  };
}

export async function tokenDossier(address) {
  address = address.toLowerCase();
  const all = await ponsMetaAll();
  const meta = all.find((t) => (t.address || "").toLowerCase() === address) || null;
  // full on-chain read incl. the whale/holder table (who's buying, who's selling now)
  const r = await computeIntel(address, meta?.sym || "?", {
    pool: meta?.pool, mcapUsd: meta?.mcapUsd, graduated: meta?.graduated, launchedAt: meta?.launchedAt, whales: true,
  });
  r.name = meta?.name || null; r.logo = meta?.logo || null; r.progress = meta?.progress ?? null;
  r.graduated = !!meta?.graduated; r.launchedAt = meta?.launchedAt || null;
  if (meta?.mcapUsd != null) r.mcapUsd = Math.round(meta.mcapUsd);

  // winner-study placements — identical math to the board
  r.blueprint = blueprintMatch({ bundles: r.flags.bundles, top10Pct: r.flags.top10Pct, holders: r.flags.holders, risk: r.risk });
  r.blueprintLabel = blueprintLabel(r.blueprint);
  r.wallets = r.flags.wallets || r.flags.holders;
  r.path = pathPosition(r.wallets, r.mcapUsd);
  r.precedent = precedentValuation(r.wallets);
  const ageH = r.launchedAt ? (Date.now() - Date.parse(r.launchedAt)) / 3.6e6 : (r.ageH || 0);
  r.ageH = +ageH.toFixed(1);
  r.trajectory = liveTrajectory({ blueprint: r.blueprint, holders: r.flags.holders, ageH });
  r.corridor = corridorStatus(ageH, r.trajectory);

  // split the holder table into who's adding vs shedding right now (net flow over the live 30-min window),
  // and surface the biggest bags so a graduated token with no recent flow still shows its distribution.
  const whales = r.whales || [];
  r.buyers = whales.filter((w) => w.net > 0).sort((a, b) => b.net - a.net).slice(0, 12);
  r.sellers = whales.filter((w) => w.net < 0).sort((a, b) => a.net - b.net).slice(0, 12);
  r.topHolders = whales.slice().sort((a, b) => b.bal - a.bal).slice(0, 12);
  r.deployer = deployerReputation(all, meta); // deployer track record (other launches by the same wallet)
  return r;
}
