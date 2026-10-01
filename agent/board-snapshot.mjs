// The static site's live board. The agent already reads every live launch on the free node each cycle; this keeps the
// latest read per token and writes the slim subset the landing page and token cards render (public/block0-cards.js),
// in the /api/board shape: { cooking, graduated, dex, stats }. Pure.
import { KINDS } from "../alert-events.mjs";
import { AGENT_KINDS } from "./agent-events.mjs";

const FLAGS = ["snipers", "sniperHeldPct", "bundles", "bundleWallets", "bundleHeldPct", "top10Pct", "holders", "wallets", "insiderSellersNow", "insiderDumpNowPct"];

export function mergeReads(prev, tokens, { now = Date.now(), maxAgeH = 72 } = {}) {
  const next = { ...(prev || {}) };
  for (const t of tokens || []) {
    // untraded tokens are left off: Orbio lists every agent still on its bonding curve at the curve's starting value
    // (~$10k), so they clear the mcap floor with zero holders — a "risk 0, looks clean" card about nothing
    if (!t?.address || t.risk == null || (t.flags?.holders ?? 0) < 5) { if (t?.address) delete next[t.address]; continue; }
    const flags = {}; for (const k of FLAGS) if (t.flags?.[k] != null) flags[k] = t.flags[k];
    next[t.address] = { address: t.address, sym: t.sym, mcapUsd: t.mcapUsd ?? null, launchedAgeH: t.ageH ?? null, readAt: now,
      risk: t.risk, label: t.label ?? null, momentum: t.momentum ?? null, graduated: !!t.graduated, progress: t.progress ?? null, venue: t.venue ?? "pons", flags,
      parts: t.parts ?? null,                                     // the risk breakdown the card's sub-score bars draw
      deployerRep: t.deployer ? { launched: t.deployer.launched, graduated: t.deployer.graduated, faded: t.deployer.faded } : null };
  }
  for (const [a, t] of Object.entries(next)) if ((t.launchedAgeH ?? 0) + (now - t.readAt) / 3.6e6 > maxAgeH || (t.flags?.holders ?? 0) < 5) delete next[a];
  return next;
}

export function boardSnapshot(reads, stats, { now = Date.now(), limit = 60 } = {}) {
  const rows = Object.values(reads || {}).map(({ launchedAgeH, readAt, ...t }) => ({ ...t, ageH: launchedAgeH == null ? null : +(launchedAgeH + (now - readAt) / 3.6e6).toFixed(1),
    section: t.graduated ? "graduated" : "cooking" }))
    .sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, limit);
  return { updated: now, source: "block0 agent (free node) — refreshed every ~15 min", stats: { ...(stats || {}) },
    cooking: rows.filter((r) => !r.graduated), graduated: rows.filter((r) => r.graduated), dex: [] };
}

// The static site's alert strip (agent-data/alerts.json, served at /api/alerts/feed): every event the agent DETECTED,
// newest first, whether or not it was posted — the board shows facts as they happen; posting is rationed separately.
// Unvalidated kinds carry validated:false so the page can say so. Pure.
export function alertsFeed(prev, events, { limit = 30 } = {}) {
  const meta = (k) => KINDS[k] || AGENT_KINDS[k] || {};
  const fresh = (events || []).map((e) => ({ ...e, sev: meta(e.kind).sev || "info", label: meta(e.kind).label || e.kind }));
  return { updated: Date.now(), telegram: null, events: [...fresh, ...((prev && prev.events) || [])].slice(0, limit) };
}

// The static site's per-token DOSSIER (agent-data/tokens/<address>.json, served at /api/dossier/<address>): the same
// fields /api/token gives the dossier page (public/index.html), from the read the agent just made. computeIntel's
// holder table comes from the same transfer replay as the verdict, so this costs no extra chain reads. Bounded:
// top 40 holders, 12 movers each way, 6 bundles. Pure.
export function dossierOf(t, { now = Date.now() } = {}) {
  if (!t?.address || t.risk == null) return null;
  const whales = (t.whales || []).slice(0, 40);
  return {
    address: t.address, sym: t.sym ?? null, name: t.name || null, logo: t.logo || null, pool: t.pool || null,
    readAt: now, source: "block0 agent · free Robinhood Chain node", static: true,
    mcapUsd: t.mcapUsd ?? null, ageH: t.ageH == null ? null : +t.ageH.toFixed(1), venue: t.venue || "pons", graduated: !!t.graduated, progress: t.progress ?? null,
    risk: t.risk, label: t.label ?? null, topFactor: t.topFactor ?? null, parts: t.parts ?? null, flags: t.flags || {},
    bundles: (t.bundles || []).slice(0, 6).map((b) => ({ blk: b.blk, n: b.n, wallets: (b.wallets || []).slice(0, 12), held: b.held })),
    whales,
    buyers: whales.filter((w) => w.net > 0).sort((a, b) => b.net - a.net).slice(0, 12),
    sellers: whales.filter((w) => w.net < 0).sort((a, b) => a.net - b.net).slice(0, 12),
    topHolders: whales.slice().sort((a, b) => b.bal - a.bal).slice(0, 12),
    deployer: t.deployer ?? null,
  };
}
