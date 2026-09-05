// build-cohort — profile the launch universe and label every token by OUTCOME. Step 1 of the model pipeline
// (tools/README.md). Needs an RPC (one backtest per token), so it runs offline / in the rebuild workflow.
//
// ONE RULE FOR EVERY TOKEN (outcome.mjs): graduation is not a criterion. Winners are tokens that reached a real
// valuation and HELD it (runner: ≥$1M for 7 days · major: ≥$5M held-peak, ≥$1M for 14 days); the primary control
// is "faded" (reached the same stages, then collapsed); pending/mid are undecided and excluded from both sides.
//
// INCREMENTAL + BUDGETED, so the cohort COMPOUNDS instead of being re-bought every run:
//   • every backtest is cached as a slim profile under study/profiles/<address>.json (committed);
//   • a cached token is RE-LABELLED with the launchpad's live market cap for free — it's only re-backtested when the
//     label is still open (pending/mid), it's printing new highs, or it's a young winner whose corridor path is
//     still growing;
//   • --budgetMin stops starting new backtests once the wall-clock budget is spent and commits what it has — the
//     next weekly run picks up the queue where this one left off (highest-value tokens first).
//
// Usage (from the scanner root):
//   node tools/build-cohort.mjs [--budgetMin=120] [--max=500] [--controls=300] [--dex] [--dexBlocks=2500000] [--dexCap=300] [--points=90] [--dry]
// Then: node tools/corridor.mjs && node tools/projection.mjs && node tools/gen-model.mjs && node tools/validate.mjs
import { fetchActive, fetchGraduated } from "../pons.mjs";
import { backtest } from "../backtest.mjs";
import { discoverDex, tokenMeta, INFRA } from "../dex.mjs";
import { isTokenizedStock } from "../intel.mjs";
import { EXCLUDE_TOKENS, isWinner, isSettled, RULES } from "../outcome.mjs";
import { loadProfiles, slimProfile, writeProfile, classifyProfile, indexEntry, writeIndex, loadSkips, saveSkips, STUDY_DIR } from "./cohort-lib.mjs";

const arg = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const BUDGET_MIN = Number(arg.budgetMin || 120), MAX = Number(arg.max || 500), N_CONTROLS = Number(arg.controls || 300);
const POINTS = Number(arg.points || 90), DRY = !!arg.dry;
const ONLY = arg.only ? new Set(String(arg.only).toLowerCase().split(",")) : null;   // --only=0x…,0x… → profile just these (smoke / repair)
const DEX_BLOCKS = Number(arg.dexBlocks || 2_500_000), DEX_CAP = Number(arg.dexCap || 300);
const BT_TIMEOUT_MS = Number(arg.btTimeoutMin || 8) * 60e3;   // one runaway token can't eat the whole budget
const REFRESH_OPEN_H = 12, REFRESH_GROWING_H = 48, GROWING_AGE_H = 30 * 24, SKIP_RETRY_H = 7 * 24;
const $ = (x) => x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
const now = () => Date.now() / 1000;
const ageH = (m) => m.launchedAt ? (Date.now() - Date.parse(m.launchedAt)) / 3.6e6 : null;

// ─── 1. the universe: every Pons launch (graduated + active) and, with --dex, direct DEX listings ───────────────
console.log("fetching the launch universe from Pons…");
const [grad, active] = await Promise.all([fetchGraduated(), fetchActive({ sort: "marketCap", pageSize: 400 })]);
const universe = new Map();
for (const t of [...grad.items, ...active.items]) if (t.address && !universe.has(t.address)) universe.set(t.address, { ...t, source: "pons" });
console.log(`  pons: ${grad.items.length} graduated · ${active.items.length} active`);
if (arg.dex) {
  console.log(`  dex: scanning ${DEX_BLOCKS.toLocaleString()} blocks for listings…`);
  try {
    const { tokens } = await discoverDex({ blocks: DEX_BLOCKS });
    const cand = tokens.filter((t) => !universe.has(t.address)).sort((a, b) => b.block - a.block).slice(0, DEX_CAP);
    for (const t of cand) universe.set(t.address, { address: t.address, sym: null, name: null, mcapUsd: 0, pool: null, graduated: false, launchedAt: null, source: "dex", venue: t.dex, dexBlock: t.block });
    console.log(`  dex: ${tokens.length} discovered · ${cand.length} new candidates queued (newest first)`);
  } catch (e) { console.log("  dex discovery failed:", e.message); }
}
for (const a of [...EXCLUDE_TOKENS, ...INFRA]) universe.delete(a);

// ─── 2. cached profiles: re-label with live facts, decide what needs a fresh backtest ───────────────────────────
const profiles = new Map(loadProfiles().map((p) => [p.addr, p]));
const skips = loadSkips();
const entries = new Map();   // addr → index entry (from cache now; refreshed ones overwrite below)
const queue = [];            // {addr, meta, prio, why}
const hAgo = (iso) => (Date.now() - Date.parse(iso || 0)) / 3.6e6;
for (const [addr, p] of profiles) {
  const live = universe.get(addr) || null;
  const o = classifyProfile(p, live);
  entries.set(addr, indexEntry(p, o));
  const cacheAge = hAgo(p.cachedAt), tokAgeAtCache = (Date.parse(p.cachedAt) / 1000 - p.t0) / 3600;
  const meta = live || { address: addr, sym: p.sym, name: p.name, pool: p.pool, graduated: p.graduated, launchedAt: p.launchedAt, mcapUsd: o.curMcap, source: p.source, venue: p.venue };
  if (!isSettled(o.label) && cacheAge >= REFRESH_OPEN_H) queue.push({ addr, meta, prio: 2, why: `${o.label} · re-read` });
  else if (live && live.mcapUsd > 0 && live.mcapUsd > (o.peakMcap || 0) * 0.9 && cacheAge >= REFRESH_OPEN_H && !isWinner(o.label)) queue.push({ addr, meta, prio: 3, why: "new highs" });
  else if (isWinner(o.label) && tokAgeAtCache < GROWING_AGE_H && cacheAge >= REFRESH_GROWING_H) queue.push({ addr, meta, prio: 4, why: "winner path still growing" });
}
// never-profiled tokens: the likely winners/faded first (they carry the most information per backtest), then a
// bounded set of small/aged launches as stalled/dead controls, then DEX discoveries.
let nControls = 0;
const stockCache = new Map();
for (const [addr, m] of universe) {
  if (profiles.has(addr)) continue;
  const sk = skips[addr]; if (sk && hAgo(sk.at) < SKIP_RETRY_H && !ONLY) continue;
  const mc = m.mcapUsd || 0, age = ageH(m);
  if (m.source === "dex") { queue.push({ addr, meta: m, prio: 6, why: "dex listing" }); continue; }
  if (mc >= RULES.fadeReach) queue.push({ addr, meta: m, prio: 1, why: `live ${$(mc)}` });
  else if (m.graduated && mc >= 5e4) queue.push({ addr, meta: m, prio: 1.5, why: `graduated ${$(mc)}` });
  else if (age != null && age >= RULES.minAgeH && nControls < N_CONTROLS) { nControls++; queue.push({ addr, meta: m, prio: 5, why: `control (${m.graduated ? "graduated" : "active"} ${$(mc)}, ${Math.round(age / 24)}d)` }); }
}
if (ONLY) { queue.length = 0; for (const a of ONLY) { const m = universe.get(a) || (profiles.get(a) ? { address: a, sym: profiles.get(a).sym, pool: profiles.get(a).pool, graduated: profiles.get(a).graduated, launchedAt: profiles.get(a).launchedAt, mcapUsd: 0, source: profiles.get(a).source } : null); if (m) queue.push({ addr: a, meta: m, prio: 0, why: "--only" }); else console.log("  --only: not in the universe:", a); } }
queue.sort((a, b) => a.prio - b.prio || (b.meta.mcapUsd || 0) - (a.meta.mcapUsd || 0));
console.log(`\ncached profiles: ${profiles.size} · queue: ${queue.length} backtests (budget ${BUDGET_MIN} min, max ${MAX})`);
for (const p of [1, 1.5, 2, 3, 4, 5, 6]) { const n = queue.filter((q) => q.prio === p).length; if (n) console.log(`  prio ${p}: ${n}`); }
if (DRY) { console.log(queue.slice(0, 40).map((q) => `  ${(q.meta.sym || q.addr.slice(0, 10)).padEnd(14)} ${q.why}`).join("\n")); process.exit(0); }

// ─── 3. run the queue inside the budget; every profile is written the moment it lands ─────────────────────────
const t_start = Date.now();
const spent = () => (Date.now() - t_start) / 60e3;
let done = 0, failed = 0, left = 0, streak = 0;   // streak = consecutive failures → the RPC is down/throttled, stop burning the queue
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("backtest timeout")), ms))]);
for (const q of queue) {
  if (spent() >= BUDGET_MIN || done >= MAX || streak >= 8) { left++; continue; }
  const m = q.meta;
  try {
    if (m.source === "dex") {
      const tm = await tokenMeta(q.addr); if (!tm.symbol || !(tm.supply > 0)) { skips[q.addr] = { at: new Date().toISOString(), reason: "no symbol/supply" }; continue; }
      m.sym = tm.symbol; m.name = tm.name || tm.symbol;
      let stock = stockCache.get(q.addr); if (stock == null) { try { stock = await isTokenizedStock(q.addr); } catch { stock = false; } stockCache.set(q.addr, stock); }
      if (stock) { skips[q.addr] = { at: new Date().toISOString(), reason: "tokenized stock" }; continue; }
    }
    const r = await withTimeout(backtest(q.addr, { sym: m.sym, pool: m.pool, graduated: !!m.graduated, launchedAt: m.launchedAt, points: POINTS }), BT_TIMEOUT_MS);
    if (r.error || !r.series?.length) { skips[q.addr] = { at: new Date().toISOString(), reason: r.error || "no series" }; failed++; streak++; console.log(`  ✗ ${(m.sym || q.addr.slice(0, 10)).padEnd(14)} ${r.error || "no series"}`); continue; }
    const p = slimProfile(r, { ...m, address: q.addr, source: m.source });
    if (m.source === "dex" && !p.sym) p.sym = q.addr.slice(0, 8);
    writeProfile(p); profiles.set(q.addr, p); delete skips[q.addr];
    const o = classifyProfile(p, universe.get(q.addr) || null);
    entries.set(q.addr, indexEntry(p, o));
    done++; streak = 0;
    console.log(`  ✓ ${(p.sym || "?").padEnd(14)} ${o.label.padEnd(8)} held-peak ${$(o.heldPeak).padStart(7)} · now ${$(o.curMcap).padStart(7)} · ${r.series.length} pts · ${q.why}   [${spent().toFixed(1)} min]`);
  } catch (e) {
    failed++; streak++; skips[q.addr] = { at: new Date().toISOString(), reason: e.message };
    console.log(`  ✗ ${(m.sym || q.addr.slice(0, 10)).padEnd(14)} ${e.message}`);
  }
}
saveSkips(skips);

// ─── 4. the cohort index — every profiled token with its label; the builders read this, not the dirs ─────────
const idx = writeIndex([...entries.values()], { run: { backtested: done, failed, queuedLeft: left, cached: profiles.size, elapsedMin: +spent().toFixed(1), budgetMin: BUDGET_MIN } });
console.log(`\n${STUDY_DIR}/cohort.json · ${idx.tokens.length} tokens labelled · winners ${idx.winners} · controls ${idx.controls}`);
console.log("  " + Object.entries(idx.counts).map(([k, v]) => `${k} ${v}`).join(" · "));
console.log(`  backtested ${done} · failed ${failed} · still queued ${left} (next run continues) · ${spent().toFixed(1)} min${streak >= 8 ? " · STOPPED: 8 consecutive failures (RPC down or throttled)" : ""}`);
console.log("next: node tools/corridor.mjs && node tools/projection.mjs && node tools/gen-model.mjs && node tools/validate.mjs");
