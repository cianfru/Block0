// Shared cohort plumbing for the model pipeline: the committed profile cache (one slim backtest per token under
// study/profiles/), the cohort index (study/cohort.json — every profiled token with its OUTCOME label), and the
// loaders the downstream builders (corridor / projection / blueprint / validate) read from. One place, so the
// winner/control split can never differ between builders.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyOutcome, isWinner, isControl, RULES, definitions, TIERS } from "../outcome.mjs";

export const STUDY_DIR = process.env.STUDY_DIR || "study";
export const PROFILES_DIR = join(STUDY_DIR, "profiles");
export const INDEX_PATH = join(STUDY_DIR, "cohort.json");
export const SKIPS_PATH = join(STUDY_DIR, "skips.json");

// the series fields the builders read — everything else a backtest returns (per-wallet PnL, corridor echo…) is dropped
const SERIES_FIELDS = ["t", "risk", "top10", "sniperHeld", "holders", "wallets", "bundles", "mcap", "price", "volUsd", "ageH", "blueprint", "traj"];
export function slimProfile(r, meta = {}) {
  return {
    addr: (r.addr || meta.address || "").toLowerCase(), sym: meta.sym || r.sym || "?", name: meta.name || r.name || null,
    source: meta.source || "pons", graduated: !!(meta.graduated ?? r.graduated), launchedAt: meta.launchedAt || null, deployer: meta.deployer || null,
    pool: meta.pool || null, venue: meta.venue || null,
    t0: r.t0, t1: r.t1, supply: r.supply || null, ethUsd: r.ethUsd || null, transfers: r.transfers, capped: !!r.capped,
    bundles: r.bundles, snipers: r.snipers, firstPoolBlock: r.firstPoolBlock ?? null,
    cachedAt: new Date().toISOString(), cacheMcap: meta.mcapUsd ?? null,
    series: (r.series || []).map((p) => { const o = {}; for (const k of SERIES_FIELDS) if (p[k] != null) o[k] = p[k]; return o; }),
  };
}

export const profilePath = (addr) => join(PROFILES_DIR, addr.toLowerCase() + ".json");
export function writeProfile(p) { mkdirSync(PROFILES_DIR, { recursive: true }); writeFileSync(profilePath(p.addr), JSON.stringify(p)); }
export function loadProfiles() {
  if (!existsSync(PROFILES_DIR)) return [];
  const out = [];
  for (const f of readdirSync(PROFILES_DIR)) {
    if (!f.endsWith(".json")) continue;
    try { const p = JSON.parse(readFileSync(join(PROFILES_DIR, f), "utf8")); if (p && p.addr && p.series?.length) out.push(p); } catch { /* corrupt → skip */ }
  }
  return out;
}
export function loadSkips() { try { return JSON.parse(readFileSync(SKIPS_PATH, "utf8")); } catch { return {}; } }
export function saveSkips(s) { mkdirSync(STUDY_DIR, { recursive: true }); writeFileSync(SKIPS_PATH, JSON.stringify(s)); }

// classify a profile with the freshest facts we have: the launchpad's live market cap when known (free, current),
// else the last reconstructed point. Zero RPC — this is why a cached profile can be re-labelled every run.
export function classifyProfile(p, live = null, now = Date.now() / 1000) {
  const last = p.series[p.series.length - 1] || {};
  const curMcap = live && live.mcapUsd > 0 ? live.mcapUsd : (last.mcap ?? null);
  const t0 = p.launchedAt ? Date.parse(p.launchedAt) / 1000 : p.t0;
  return classifyOutcome(p.series, { now, t0: Math.min(t0 || p.t0, p.t0), curMcap, curHolders: last.holders ?? null });
}

export function indexEntry(p, o) {
  return { addr: p.addr, sym: p.sym, name: p.name, source: p.source, graduated: p.graduated, launchedAt: p.launchedAt || new Date(p.t0 * 1000).toISOString(),
    label: o.label, why: o.why, wasRunner: !!o.wasRunner, heldPeak: o.heldPeak, peakMcap: o.peakMcap, peakAtH: o.peakAtH, curMcap: o.curMcap,
    sustainedH: o.sustainedH, ageH: o.ageH, holders: o.curHolders, peakHolders: o.peakHolders, retention: o.retention,
    transfers: p.transfers, capped: p.capped, cachedAt: p.cachedAt };
}

export function tierCounts(entries) { const c = {}; for (const t of TIERS) c[t] = 0; for (const e of entries) c[e.label] = (c[e.label] || 0) + 1; return c; }

export function writeIndex(entries, extra = {}) {
  mkdirSync(STUDY_DIR, { recursive: true });
  entries.sort((a, b) => (b.heldPeak || 0) - (a.heldPeak || 0));
  const out = { generatedAt: new Date().toISOString().slice(0, 10), rules: RULES, definitions: definitions(), counts: tierCounts(entries),
    winners: entries.filter((e) => isWinner(e.label)).length, controls: entries.filter((e) => isControl(e.label)).length, ...extra, tokens: entries };
  writeFileSync(INDEX_PATH, JSON.stringify(out));
  return out;
}
export function loadIndex() { try { return JSON.parse(readFileSync(INDEX_PATH, "utf8")); } catch { return null; } }

// What every downstream builder consumes: profiles joined to their index label. Winners = major+runner (sorted by
// held-peak), controls = faded/stalled/dead (each carries `kind`), plus the undecided for the record.
export function loadCohort() {
  const idx = loadIndex();
  if (!idx) throw new Error(`no cohort index at ${INDEX_PATH} — run tools/build-cohort.mjs first`);
  const byAddr = new Map(idx.tokens.map((e) => [e.addr, e]));
  const profiles = loadProfiles().map((p) => ({ ...p, meta: byAddr.get(p.addr) || null })).filter((p) => p.meta);
  const winners = profiles.filter((p) => isWinner(p.meta.label)).sort((a, b) => (b.meta.heldPeak || 0) - (a.meta.heldPeak || 0));
  const controls = profiles.filter((p) => isControl(p.meta.label)).map((p) => ({ ...p, kind: p.meta.label }));
  const undecided = profiles.filter((p) => !isWinner(p.meta.label) && !isControl(p.meta.label));
  return { index: idx, profiles, winners, controls, undecided };
}
