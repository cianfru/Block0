// The per-token DOSSIER — everything the /token page shows at first glance, in ONE provider-agnostic call.
// It reuses the exact same on-chain layer the board runs (computeIntel), so a token's verdict on its own page
// matches its board card, then adds the winner-study placements (blueprint fit, valuation ladder, corridor).
//
// This is deliberately separate from /api/backtest (the historical score/price replay, which is heavier and
// Alchemy-preferred): the dossier always resolves fast from the incremental store, so the page shows the full
// forensic read — snipers, bundles, concentration, who's buying/selling — even if the history chart is still loading.
import { computeIntel, blueprintMatch, blueprintLabel } from "./intel.mjs";
import { getCurrentSmartMoney } from "./smart-money.mjs";
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
export async function tokenDossier(address) {
  address = address.toLowerCase();
  const all = await ponsMetaAll();
  const meta = all.find((t) => (t.address || "").toLowerCase() === address) || null;
  // full on-chain read incl. the whale/holder table (who's buying, who's selling now) + smart-money positioning
  const SMART = getCurrentSmartMoney();
  const r = await computeIntel(address, meta?.sym || "?", {
    pool: meta?.pool, mcapUsd: meta?.mcapUsd, graduated: meta?.graduated, launchedAt: meta?.launchedAt, whales: true,
    smartSet: SMART.set, smartMeta: SMART.meta,
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
  r.corridor = corridorStatus(ageH, r.trajectory, { wallets: r.flags.wallets ?? r.flags.holders, mcap: r.mcapUsd });

  // split the holder table into who's adding vs shedding right now (net flow over the live 30-min window),
  // and surface the biggest bags so a graduated token with no recent flow still shows its distribution.
  const whales = r.whales || [];
  r.buyers = whales.filter((w) => w.net > 0).sort((a, b) => b.net - a.net).slice(0, 12);
  r.sellers = whales.filter((w) => w.net < 0).sort((a, b) => a.net - b.net).slice(0, 12);
  r.topHolders = whales.slice().sort((a, b) => b.bal - a.bal).slice(0, 12);
  r.deployer = deployerReputation(all, meta); // deployer track record (other launches by the same wallet)
  r.explorer = (process.env.EXPLORER_URL || "").replace(/\/$/, "") || null; // when set, wallet/contract links activate
  // Wallet identity links for the front-end cards. We deliberately DON'T link a third-party portfolio service:
  // Zerion (and the other aggregators) don't index the Robinhood Chain, so every wallet returned "unsupported
  // address". The PnL we show is our own engine's reconstruction; a wallet links to the chain's own block
  // explorer when EXPLORER_URL is configured, otherwise the address is click-to-copy in the UI.
  r.links = { explorer: r.explorer };
  return r;
}
