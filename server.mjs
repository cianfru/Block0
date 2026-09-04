// Launch-scanner HTTP service. Dependency-free (Node ≥18 built-ins only) so it deploys to Railway with just
// `node server.mjs` and no install step. Serves the frontend, a /api/scan endpoint (full pull + all scores),
// and a /api/stream SSE endpoint that TAILS new blocks and pushes each new buy/sell to the live bubble chart.
//
// The POC tails by polling recent blocks every few seconds — robust everywhere. Production upgrade: swap the
// poll loop for an `eth_subscribe` websocket (one line of intent, noted below) for true push latency.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, pullTransfers, detectPool, ROUTERS } from "./engine.mjs";
import { latestBlock } from "./rpc.mjs";
import { watchLogs, WS_ENABLED } from "./ws.mjs";
import { refreshBoard, refreshDex, getBoard, ensureFresh, setSmartMoney } from "./board.mjs";
import { smartMoneyFrom, convergence } from "./smart-money.mjs";
import { coverageReport } from "./coverage.mjs";
import { tick as trackTick, trackRecord } from "./track-record.mjs";
import { backtest } from "./backtest.mjs";
import { tokenDossier } from "./dossier.mjs";
import { startAlerts, runAlertScan, getCalls, ALERTS_ON } from "./alerts.mjs";
import { KV_BACKEND, getJSON, setJSON, kvPing } from "./store/kv.mjs";
import { getTransfers } from "./store.mjs";
import { fetchActive, fetchGraduated } from "./pons.mjs";
import { PROVIDER } from "./rpc.mjs";
import { traceEvents, discoverDex, recentDexTokens, DEX_CONFIG } from "./dex.mjs";
import { walletIntel, walletTokenSet } from "./wallet.mjs";
import { buildLeaderboard } from "./leaderboard.mjs";
import { walletPnlReport } from "./wallet-pnl.mjs";
import { buildCards } from "./cards.mjs";
import { emptyState, applySocial, cadence } from "./social.mjs";
import { buildGraph } from "./graph.mjs";
import { resolveFunders, funderLinks } from "./funders.mjs";
import { rpc, isContract } from "./rpc.mjs";
import { track, readIntel } from "./analytics.mjs";
import { buildPicks } from "./picks.mjs";
import { chat as llmChat, hasKey as llmHasKey } from "./llm.mjs";

const readBody = (req, cap = 8192) => new Promise((resolve) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > cap) req.destroy(); }); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); req.on("error", () => resolve({})); });
const CONTROL_PW = process.env.CONTROL_PASSWORD || "";
const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// chain head cache — one eth_blockNumber every ~10s, shared to every visitor's block-clock (cheap by design).
let _head = { block: 0, at: 0 };

// find a token's Pons metadata (pool / graduated / launchedAt / symbol) by address, for the backtest
const _btCache = new Map();
async function ponsMeta(token) {
  const [a, g] = await Promise.all([fetchActive({ pageSize: 400 }).catch(() => ({ items: [] })), fetchGraduated().catch(() => ({ items: [] }))]);
  return [...(a.items || []), ...(g.items || [])].find((t) => t.address === token) || null;
}

// Price-safety: the history's mcap/price is a swap-implied RECONSTRUCTION; Pons gives the authoritative CURRENT
// market cap. Anchor the reconstruction so its latest point matches Pons — this folds out any absolute-level error
// (wrong decimals / supply — the class of bug that once showed a $367M phantom) while keeping the honest RELATIVE
// trajectory. If the pre-anchor level was wildly off (>20×), the shape is suspect too → flag priceRough so the UI
// can caption it. Never invent: with no Pons mcap or no reconstructed level, we leave the series untouched.
function anchorToPons(r, ponsMcap) {
  if (!r || !Array.isArray(r.series) || !ponsMcap || ponsMcap <= 0) return r;
  let lastMcap = null;
  for (let i = r.series.length - 1; i >= 0; i--) { const m = r.series[i].mcap; if (m != null && isFinite(m) && m > 0) { lastMcap = m; break; } }
  if (!lastMcap) return r;
  // Only pin to Pons's CURRENT mcap when the reconstruction actually reaches ~now. If the pull was capped (a
  // mega-token whose history we couldn't fully fetch), the last point is an OLD value — scaling the whole early
  // curve up to today's mcap would grossly inflate it. In that case leave the (correct-for-its-window) values and
  // just flag it rough.
  const reachesNow = r.t1 && (Date.now() / 1000 - r.t1) < 6 * 3600;
  const ratio = ponsMcap / lastMcap;
  if (!reachesNow) { r.priceRough = true; return r; }
  if (!isFinite(ratio) || ratio <= 0) return r;
  r.priceAnchor = +ratio.toFixed(4);
  r.priceRough = ratio > 20 || ratio < 0.05; // reconstruction level was far off Pons — treat the shape as rough
  for (const s of r.series) {
    if (s.mcap != null) s.mcap = Math.round(s.mcap * ratio);
    if (s.price != null) s.price = s.price * ratio;
    if (s.volUsd != null) s.volUsd = Math.round(s.volUsd * ratio);
  }
  return r;
}

// Compute (or serve a durable-cached) backtest. The board's incremental store caps transfers at ~25k for
// memory, so it holds the FULL history only for smaller tokens — for those we reuse it and the series is instant
// and exact. For a high-volume token the store is incomplete, so we self-pull the full history (slower, but
// correct); the result is cached in KV keyed by token so that expensive pull happens once, not on every redeploy.
// serve a cached backtest for 45 min — deliberately LONGER than the 30-min leaderboard refresh, so steady-state LB
// rebuilds hit the cache (only the cold start pays the full 100-backtest cost, not every cycle).
const BT_TTL = Number(process.env.BT_TTL_MS || 45 * 60 * 1000);
const STORE_CAP = 25000;
// In-process hot cache for backtests. The leaderboard warms every winner token through the SAME genericBt keys
// every refresh, so a per-wallet PnL report (which reuses those keys) reads them straight from memory — no ~100
// Redis round-trips, no recompute. Bounded so it can't grow without limit. Redis stays the cross-instance/restart
// cache underneath.
const _btMem = new Map();                       // kvKey -> { at, data }
const _btMemGet = (k) => { const e = _btMem.get(k); if (e && Date.now() - e.at < BT_TTL) return e.data; if (e) _btMem.delete(k); return null; };
const _btMemSet = (k, data) => { _btMem.set(k, { at: Date.now(), data }); if (_btMem.size > 400) _btMem.delete(_btMem.keys().next().value); };
async function computeBacktest(token, key, { points, ethUsd, noPrice, cap, sym, walletTrades }) {
  const kvKey = `bt:${key}`;
  const mem = _btMemGet(kvKey);
  if (mem) return mem;                           // instant: served from this process's memory
  const cached = await getJSON(kvKey).catch(() => null);
  if (cached && cached.data && Date.now() - cached.at < BT_TTL) { _btMemSet(kvKey, cached.data); return cached.data; }
  const meta = await ponsMeta(token);
  const st = await getTransfers(token, 18, { pool: meta?.pool, launchedAt: meta?.launchedAt }).catch(() => ({ ev: null }));
  const complete = st.ev && st.ev.length > 0 && st.ev.length < STORE_CAP - 1000; // store holds the whole history
  const r = anchorToPons({
    ...(await backtest(token, { sym: meta?.sym || sym || "?", pool: meta?.pool, graduated: !!meta?.graduated, launchedAt: meta?.launchedAt, points, ethUsd, noPrice, cap, walletTrades, ev: complete ? st.ev : null })),
    name: meta?.name, logo: meta?.logo, mcapUsd: meta?.mcapUsd, priceUsd: meta?.priceUsd,
  }, meta?.mcapUsd);
  _btMemSet(kvKey, r);
  setJSON(kvKey, { at: Date.now(), data: r }).catch(() => {});
  return r;
}

// background discover-board: scan every live launch, verdict + market-cap-bucket, keep a ranked cache
const BOARD_REFRESH_MS = Number(process.env.BOARD_REFRESH_MS || 180000);
// after each board refresh, feed the FORWARD track record: freeze a young call per token, resolve matured outcomes.
async function boardCycle() {
  await refreshBoard({ n: Number(process.env.BOARD_TOKENS || 18) }).catch(() => {});
  try { const b = getBoard(); await trackTick([...(b.cooking || []), ...(b.dex || []), ...(b.graduated || [])]); } catch { /* tracker never blocks the board */ }
}
boardCycle();
setInterval(boardCycle, BOARD_REFRESH_MS);

// launch alert push (Telegram) — dormant unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set
startAlerts();

// DEX discovery on its own interval (decoupled from the Pons board; first run staggered ~45s after boot)
const DEX_REFRESH_MS = Number(process.env.DEX_REFRESH_MS || 300000);
if (Number(process.env.BOARD_DEX ?? 10) > 0) {
  setTimeout(() => { refreshDex().catch(() => {}); setInterval(() => refreshDex().catch(() => {}), DEX_REFRESH_MS); }, 45000);
}

// PROVEN-PnL LEADERBOARD refresh — aggregates per-token wallet PnL across the graduated + DEX winners into the
// "follow the smart money" board. Heavy but reuses cached backtests, so it runs infrequently and off-cycle. The
// result is cached in KV so a restart (or a second instance) serves instantly while the first rebuild runs.
const LB_REFRESH_MS = Number(process.env.LEADERBOARD_REFRESH_MS || 30 * 60 * 1000);
const LB_TOKENS = Number(process.env.LEADERBOARD_TOKENS || 100); // how many winners to aggregate over (wider = catches mid-tier runners)
let _leaderboard = null, _lbRunning = false;
let _lbHealth = { updated: 0, wallets: 0, tokensRequested: 0, tokensScanned: 0, buildMs: 0, ok: false };
export function leaderboardHealth() { return _lbHealth; }

// The chain's WINNER SET — graduated launchpad tokens + DEX-listed tokens, biggest first, deduped, capped.
// One source of truth so the leaderboard and a single wallet's PnL report scan the exact same tokens (and thus
// reconcile to the cent). Reads the live board cache; empty until the first board cycle lands.
function winnerTokens() {
  const b = getBoard();
  const seen = new Set();
  return [...(b.graduated || []), ...(b.dex || [])]
    .filter((t) => t.address && !seen.has(t.address.toLowerCase()) && seen.add(t.address.toLowerCase()))
    .sort((x, y) => (y.mcapUsd || 0) - (x.mcapUsd || 0))
    .slice(0, LB_TOKENS)
    .map((t) => ({ address: t.address.toLowerCase(), sym: t.sym, mcapUsd: t.mcapUsd || 0, graduated: !!t.graduated }));
}
// The generic (wallet-agnostic) backtest a wallet report reuses — same key the leaderboard warms, so it's a cache hit.
const genericBt = (addr) => computeBacktest(addr, `${addr}:90:3000:false:${Number(process.env.BT_CAP || 100000)}`, { points: 90, ethUsd: 3000 });
async function refreshLeaderboard() {
  if (_lbRunning) return; _lbRunning = true;
  const t0 = Date.now();
  _lbHealth = { ..._lbHealth, building: true, startedAt: t0 };   // legible cold-build state (else zeros look like "failed")
  try {
    const tokens = winnerTokens();
    if (!tokens.length) return;
    // time-budgeted so a slow/rate-limited cold start yields PARTIAL smart money rather than running past the next cycle
    const budgetMs = Number(process.env.LEADERBOARD_BUDGET_MS || Math.min(LB_REFRESH_MS * 0.8, 12 * 60 * 1000));
    const lb = await buildLeaderboard(tokens, genericBt, { budgetMs, isContract });
    _leaderboard = lb;
    setSmartMoney(smartMoneyFrom(lb));   // feed proven wallets to the board so every verdict flags smart-money holders
    setJSON("leaderboard", lb).catch(() => {});
    _lbHealth = { updated: Date.now(), wallets: lb.wallets || 0, proven: lb.proven || 0, riding: lb.riding || 0,
      tokensRequested: tokens.length, tokensScanned: lb.tokensScanned || 0, partial: !!lb.partial, buildMs: Date.now() - t0, ok: (lb.wallets || 0) > 0 };
  } catch (e) { _lbHealth = { ..._lbHealth, updated: Date.now(), buildMs: Date.now() - t0, ok: false, error: String(e && e.message || e).slice(0, 120) }; }
  finally { _lbRunning = false; _lbHealth = { ..._lbHealth, building: false }; }
}
if (Number(process.env.LEADERBOARD_ON ?? 1) > 0) {
  getJSON("leaderboard").then((v) => { if (v) _leaderboard = v; }).catch(() => {});
  setTimeout(() => { refreshLeaderboard(); setInterval(refreshLeaderboard, LB_REFRESH_MS); }, 90000);
}

// MOST-PROMISING-BY-PRICE-BRACKET — an LLM read over the board, refreshed on a slow timer and cached (memory + KV).
// The LLM only RANKS + EXPLAINS candidates we already computed on-chain (see picks.mjs). No key → deterministic
// picks, so the feature always works; with a free OpenRouter key it upgrades to model-written reasons. One LLM call
// per bracket per refresh (≤5, every 15 min) keeps it inside free-model limits.
const PICKS_REFRESH_MS = Number(process.env.PICKS_REFRESH_MS || 15 * 60 * 1000);
let _picks = null, _picksRunning = false;
function boardTokens() { const b = getBoard(); return [...(b.graduated || []), ...(b.dex || []), ...(b.cooking || [])]; }
async function refreshPicks() {
  if (_picksRunning) return; _picksRunning = true;
  try {
    const tokens = boardTokens();
    if (!tokens.length) return;
    const p = await buildPicks(tokens, llmHasKey() ? llmChat : null);   // no key → deterministic ranking
    _picks = p; setJSON("picks", p).catch(() => {});
  } catch { /* keep last good picks */ }
  finally { _picksRunning = false; }
}
if (Number(process.env.PICKS_ON ?? 1) > 0) {
  getJSON("picks").then((v) => { if (v) _picks = v; }).catch(() => {});
  setTimeout(() => { refreshPicks(); setInterval(refreshPicks, PICKS_REFRESH_MS); }, 120000);
}

const __dir = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 8080;
const POLL_MS = Number(process.env.POLL_MS || 6000);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

// ---- live tail: one subscription (ws) or poller (fallback) per watched token, fanned to its SSE clients ----
const watch = new Map(); // address -> { clients:Set<res>, lastBlock, pool, decimals, unsub }
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const emit = (st, e) => { // classify one transfer and push it to every viewer of this token
  const isBuy = e.from === st.pool || ROUTERS.has(e.from);
  const isSell = e.to === st.pool || ROUTERS.has(e.to);
  if (isBuy) for (const c of st.clients) sse(c, "tx", { ts: e.ts, w: e.to, amt: e.amt, side: "buy", block: e.block });
  else if (isSell) for (const c of st.clients) sse(c, "tx", { ts: e.ts, w: e.from, amt: e.amt, side: "sell", block: e.block });
};
// decode a raw eth_subscribe("logs") Transfer log → {from,to,amt,ts,block}; ts = now (the event just happened)
const decodeLog = (log, decimals) => (!log.topics || log.topics.length !== 3) ? null : {
  from: "0x" + log.topics[1].slice(26).toLowerCase(), to: "0x" + log.topics[2].slice(26).toLowerCase(),
  amt: Number(BigInt(log.data || "0x0")) / 10 ** decimals, ts: Math.floor(Date.now() / 1000), block: parseInt(log.blockNumber, 16),
};

// polling fallback — only runs when no websocket is configured
async function poll() {
  if (WS_ENABLED) return;
  for (const [addr, st] of watch) {
    if (!st.clients.size) { st.unsub?.(); watch.delete(addr); continue; }
    try {
      const latest = await latestBlock();
      if (latest <= st.lastBlock) continue;
      const ev = await pullTransfers(addr, st.lastBlock + 1, latest, st.decimals);
      st.lastBlock = latest;
      for (const e of ev) emit(st, e);
      for (const c of st.clients) sse(c, "head", { block: latest, n: ev.length });
    } catch (e) { /* transient RPC hiccup — next tick retries */ }
  }
}
if (!WS_ENABLED) setInterval(poll, POLL_MS);

async function serveStatic(res, urlPath) {
  const route = urlPath === "/" ? "landing.html"
    : (urlPath === "/board" || urlPath === "/board.html") ? "board.html"
    : (urlPath === "/leaderboard" || urlPath === "/leaderboard.html") ? "leaderboard.html"
    : (urlPath === "/token" || urlPath === "/token.html") ? "index.html"
    : (urlPath === "/wallet" || urlPath === "/wallet.html") ? "wallet.html"
    : (urlPath === "/methodology" || urlPath === "/methodology.html") ? "methodology.html"
    : (urlPath === "/control" || urlPath === "/control.html") ? "control.html"
    : (urlPath === "/desk" || urlPath === "/desk.html") ? "desk.html"
    : (urlPath === "/post" || urlPath === "/post.html") ? "post.html"
    : (urlPath === "/terms" || urlPath === "/terms.html") ? "terms.html" : null;
  const file = route || urlPath.replace(/^\//, "");
  try {
    const buf = await readFile(join(__dir, "public", file));
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
}

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  // The read-only JSON API is public and consumed cross-origin by the Lovable-designed front end (its own domain),
  // so every response carries permissive CORS. A preflight (OPTIONS) is answered immediately, before any routing.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "86400");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    if (u.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }

    if (u.pathname === "/api/head") { // chain head for the live block-clock — cached ~10s, so N visitors ≠ N RPC calls
      const now = Date.now();
      if (now - _head.at > 10000) { try { _head = { block: await latestBlock(), at: now }; } catch { _head.at = now; } }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ block: _head.block || 0, ts: Date.now() }));
    }

    if (u.pathname === "/api/track" && req.method === "POST") { // first-party analytics beacon (fire-and-forget)
      const body = await readBody(req);
      track(body, req).catch(() => {});
      res.writeHead(204); return res.end();
    }

    if (u.pathname === "/api/intel") { // forensic dashboard data — password-gated (CONTROL_PASSWORD)
      const body = req.method === "POST" ? await readBody(req) : {};
      const pw = body.pw || u.searchParams.get("pw") || "";
      res.writeHead(CONTROL_PW && pw === CONTROL_PW ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
      if (!CONTROL_PW) return res.end(JSON.stringify({ error: "CONTROL_PASSWORD not set on the server" }));
      if (pw !== CONTROL_PW) return res.end(JSON.stringify({ error: "unauthorized" }));
      const b = getBoard();
      const out = await readIntel({ boardAge: b.updated ? Date.now() - b.updated : null, provider: PROVIDER, kvBackend: KV_BACKEND });
      return res.end(JSON.stringify(out));
    }

    if (u.pathname === "/api/cards") { // POST DESK — daily postable cards (summary + ready X text + viz), CONTROL_PW-gated
      const body = req.method === "POST" ? await readBody(req) : {};
      const pw = body.pw || u.searchParams.get("pw") || "";
      res.writeHead(CONTROL_PW && pw === CONTROL_PW ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
      if (!CONTROL_PW) return res.end(JSON.stringify({ error: "CONTROL_PASSWORD not set on the server" }));
      if (pw !== CONTROL_PW) return res.end(JSON.stringify({ error: "unauthorized" }));
      const b = getBoard();
      let validation = null; try { validation = JSON.parse(await readFile(join(__dir, "study", "validation.json"), "utf8")); } catch { /* study optional */ }
      let track = null; try { track = await trackRecord(); } catch { /* tracker optional */ }
      const smartMoney = { tokens: convergence({ cooking: b.cooking, dex: b.dex, graduated: b.graduated }, { minCount: 2 }) };
      const leaderboard = _leaderboard || await getJSON("leaderboard").catch(() => null);
      return res.end(JSON.stringify(buildCards({ board: b, validation, track, smartMoney, leaderboard })));
    }

    if (u.pathname === "/api/social") { // POST desk workspace: persistent queue + posted log (CONTROL_PASSWORD-gated)
      const body = req.method === "POST" ? await readBody(req) : {};
      const pw = body.pw || u.searchParams.get("pw") || "";
      res.writeHead(CONTROL_PW && pw === CONTROL_PW ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" });
      if (!CONTROL_PW) return res.end(JSON.stringify({ error: "CONTROL_PASSWORD not set on the server" }));
      if (pw !== CONTROL_PW) return res.end(JSON.stringify({ error: "unauthorized" }));
      let state = (await getJSON("social").catch(() => null)) || emptyState();
      const action = body.action || null;
      if (action && action.type) {
        // the server mints ids for NEW items (queue, or an ad-hoc "posted" straight from Today) — keeps the reducer pure
        if ((action.type === "queue" || (action.type === "posted" && !action.uid)) && action.item) {
          action.item = { ...action.item, uid: action.item.uid || newUid(), createdAt: action.item.createdAt || Date.now() };
        }
        action.now = Date.now();
        state = applySocial(state, action);
        await setJSON("social", state).catch(() => {});
      }
      return res.end(JSON.stringify({ ok: true, queue: state.queue, log: state.log, cadence: cadence(state) }));
    }

    if (u.pathname === "/api/gate") { // token-gated access: config + a read-only balance check (no signing, no custody)
      const token = (process.env.GATE_TOKEN || "").toLowerCase();
      const enabled = /^0x[0-9a-f]{40}$/.test(token);
      const decimals = Number(process.env.GATE_DECIMALS || 18);
      const threshold = Number(process.env.GATE_THRESHOLD || 1000000); // in whole tokens
      const chainRpc = process.env.GATE_CHAIN_RPC || process.env.DEX_RPC || "https://rpc.mainnet.chain.robinhood.com";
      const cfg = { enabled, token: enabled ? token : null, symbol: process.env.GATE_SYMBOL || "BLOCK0",
        threshold, decimals, chain: process.env.GATE_CHAIN_NAME || "Robinhood Chain", buyUrl: process.env.GATE_BUY_URL || null };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      const address = (u.searchParams.get("address") || "").toLowerCase();
      if (!address) return res.end(JSON.stringify(cfg)); // just the config
      if (!/^0x[0-9a-f]{40}$/.test(address)) return res.end(JSON.stringify({ ...cfg, error: "bad address" }));
      if (!enabled) return res.end(JSON.stringify({ ...cfg, ok: true, open: true, address })); // no token set yet → open
      try {
        const data = "0x70a08231" + address.replace(/^0x/, "").padStart(64, "0"); // balanceOf(address)
        const r = await fetch(chainRpc, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }) }).then((x) => x.json());
        const raw = BigInt(r?.result && r.result !== "0x" ? r.result : "0x0");
        const bal = Number(raw / (10n ** BigInt(Math.max(0, decimals - 6)))) / 1e6; // whole tokens, ~6dp precision
        return res.end(JSON.stringify({ ...cfg, ok: bal >= threshold, balance: bal, address }));
      } catch (e) { return res.end(JSON.stringify({ ...cfg, error: "balance read failed", address })); }
    }

    if (u.pathname === "/api/status") { // system health/monitoring — board freshness, alert + store state, RPC provider
      const b = getBoard();
      const ageMs = b.updated ? Date.now() - b.updated : null;
      const healthy = !!b.updated && ageMs < BOARD_REFRESH_MS * 3;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      const lh = leaderboardHealth();
      const store = await kvPing().catch(() => ({ backend: KV_BACKEND, ok: false }));
      return res.end(JSON.stringify({
        ok: healthy, uptimeS: Math.round(process.uptime()),
        board: { updated: b.updated || null, ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000), scanning: !!b.scanning,
          cooking: (b.cooking || []).length, graduated: (b.graduated || []).length, dex: (b.dex || []).length, store: b.stats?.store || null },
        leaderboard: { updated: lh.updated || null, ageSeconds: lh.updated ? Math.round((Date.now() - lh.updated) / 1000) : null,
          building: !!lh.building, buildingSeconds: lh.building && lh.startedAt ? Math.round((Date.now() - lh.startedAt) / 1000) : null,
          wallets: lh.wallets || 0, proven: lh.proven || 0, riding: lh.riding || 0, tokensScanned: lh.tokensScanned || 0,
          tokensRequested: lh.tokensRequested || 0, partial: !!lh.partial, buildSeconds: lh.buildMs ? Math.round(lh.buildMs / 1000) : null,
          ok: !!lh.ok, error: lh.error || null },
        rpc: { provider: PROVIDER }, alerts: { on: ALERTS_ON },
        storage: { backend: store.backend || KV_BACKEND, mode: store.mode || null, connected: !!store.ok, error: store.error || null },
      }));
    }

    if (u.pathname === "/api/track-record") { // forward, out-of-sample hit-rate — accrues live as launches mature
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(await trackRecord()));
    }

    if (u.pathname === "/api/alerts/calls") { // the durable track record of past alerts
      const calls = await getCalls(Number(u.searchParams.get("n") || 100));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ calls }));
    }

    if (u.pathname === "/api/leaderboard") { // proven-PnL wallets to follow — aggregated across graduated + DEX winners
      const lb = _leaderboard || await getJSON("leaderboard").catch(() => null);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      const links = { explorer: (process.env.EXPLORER_URL || "").replace(/\/$/, "") || null };
      if (!lb) return res.end(JSON.stringify({ computing: true, rows: [], links })); // first build not finished yet
      const n = Math.max(1, Math.min(200, Number(u.searchParams.get("n") || 100)));
      return res.end(JSON.stringify({ ...lb, links, rows: (lb.rows || []).slice(0, n) }));
    }

    if (u.pathname === "/api/backtest") {
      const token = (u.searchParams.get("token") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?token=0x…"}'); }
      const points = Number(u.searchParams.get("points") || 90), ethUsd = Number(u.searchParams.get("eth") || 3000);
      const noPrice = u.searchParams.get("price") === "0", cap = Number(u.searchParams.get("cap") || process.env.BT_CAP || 100000);
      const key = `${token}:${points}:${ethUsd}:${noPrice}:${cap}`;
      if (!_btCache.has(key)) {
        _btCache.set(key, computeBacktest(token, key, { points, ethUsd, noPrice, cap, sym: u.searchParams.get("sym") })
          .catch((e) => { _btCache.delete(key); throw e; }));
      }
      const out = await _btCache.get(key);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(out));
    }

    if (u.pathname === "/api/dex/trace") { // report what pool-creation events actually fire on the AMM (identify sigs)
      const blocks = Number(u.searchParams.get("blocks") || 40000);
      const address = (u.searchParams.get("address") || DEX_CONFIG.amm).toLowerCase();
      const out = await traceEvents({ blocks, address });
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(out));
    }
    if (u.pathname === "/api/dex/candidates") { // recent DEX-listed tokens with on-chain metadata (native RPC)
      const blocks = Number(u.searchParams.get("blocks") || 60000), limit = Number(u.searchParams.get("limit") || 30);
      const out = await recentDexTokens({ blocks, limit });
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(out));
    }
    if (u.pathname === "/api/dex/discover") { // list tokens listed on the DEX over the last N blocks
      const blocks = Number(u.searchParams.get("blocks") || 200000);
      const initTopics = (u.searchParams.get("initTopics") || "").split(",").filter(Boolean);
      const out = await discoverDex({ blocks, initTopics });
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(out));
    }

    if (u.pathname === "/api/alerts/status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ on: ALERTS_ON }));
    }
    if (u.pathname === "/api/alerts/scan") { // manual trigger to test the pipeline after setting the bot token
      const r = await runAlertScan();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(r));
    }

    if (u.pathname === "/api/validation") {
      try { const buf = await readFile(join(__dir, "study", "validation.json"));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=3600" }); return res.end(buf);
      } catch { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":"no validation data"}'); }
    }

    if (u.pathname === "/api/wallet") { // cross-token wallet intelligence — what it traded, holds vs exited
      const address = (u.searchParams.get("address") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?address=0x…"}'); }
      const key = `wallet:${address}`;
      const cached = await getJSON(key).catch(() => null);
      let out = cached && Date.now() - cached.at < 15 * 60 * 1000 ? cached.data : null;
      if (!out) { out = await walletIntel(address); setJSON(key, { at: Date.now(), data: out }).catch(() => {}); }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(out));
    }

    if (u.pathname === "/api/picks") { // most-promising launches by market-cap bracket (LLM-ranked over our on-chain facts)
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (_picks) return res.end(JSON.stringify(_picks));
      // cold (before the first background refresh): build the DETERMINISTIC ranking on demand so the first hit isn't
      // empty — instant, no LLM in the request path; the timer upgrades it with model-written reasons shortly after.
      const tokens = boardTokens();
      if (!tokens.length) return res.end(JSON.stringify({ updated: Date.now(), brackets: [], computing: true }));
      const p = await buildPicks(tokens, null);
      _picks = _picks || p;
      return res.end(JSON.stringify(p));
    }

    if (u.pathname === "/api/wallet-pnl") { // ONE wallet's reconstructed PnL across the winner set — our own engine, no third party
      const a = (u.searchParams.get("a") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?a=0x…"}'); }
      const links = { explorer: (process.env.EXPLORER_URL || "").replace(/\/$/, "") || null };
      const tokens = winnerTokens();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (!tokens.length) return res.end(JSON.stringify({ address: a, computing: true, links, tokens: [], totals: null }));
      // reuse the leaderboard's warmed backtests; a wallet-scoped cache keeps repeat opens instant
      const key = `walletpnl:${a}`;
      const cached = await getJSON(key).catch(() => null);
      let rep = cached && Date.now() - cached.at < 15 * 60 * 1000 ? cached.data : null;
      if (!rep) {
        const budgetMs = Number(process.env.WALLET_PNL_BUDGET_MS || 25000);
        // PRE-FILTER: only backtest the winner tokens this wallet actually TOUCHED (one cheap getAssetTransfers pair),
        // instead of reconstructing all ~100. A wallet trades a handful, so this collapses a cold report from ~100
        // backtests to a few. Falls back to the full set if the token-set lookup fails, so results can't shrink.
        let scanTokens = tokens;
        try { const traded = await walletTokenSet(a); if (traded && traded.size) scanTokens = tokens.filter((t) => traded.has(t.address)); }
        catch { /* keep the full set on any failure */ }
        rep = await walletPnlReport(a, scanTokens, genericBt, { budgetMs });
        rep.tokensRequested = tokens.length;   // report against the whole winner universe, not just the scanned subset
        let contract = false; try { contract = await isContract(a); } catch { /* fail open */ }
        rep = { ...rep, contract };
        // on the leaderboard? attach how it earned the board so the page can badge proven/riding
        const lb = _leaderboard || await getJSON("leaderboard").catch(() => null);
        const row = lb && (lb.rows || []).find((r) => r.a === a);
        if (row) rep.board = { rank: (lb.rows.findIndex((r) => r.a === a) + 1) || null, proven: !!row.proven, riding: !!row.riding, kind: row.kind };
        setJSON(key, { at: Date.now(), data: rep }).catch(() => {});
      }
      return res.end(JSON.stringify({ ...rep, links }));
    }

    if (u.pathname === "/api/wallet-trades") { // "where it bought & sold" points for ONE wallet on ONE token (lazy drill)
      const a = (u.searchParams.get("a") || "").toLowerCase();
      const token = (u.searchParams.get("token") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a) || !/^0x[0-9a-f]{40}$/.test(token)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?a=0x…&token=0x…"}'); }
      const key = `${token}:90:3000:false:${Number(process.env.BT_CAP || 100000)}:w:${a}`;
      let bt = null; try { bt = await computeBacktest(token, key, { points: 90, ethUsd: 3000, walletTrades: a }); } catch (e) { bt = { error: String(e && e.message || e).slice(0, 120) }; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (!bt || bt.error) return res.end(JSON.stringify({ address: a, token, error: bt?.error || "no data", trades: [], price: [] }));
      const pos = (bt.pnl || []).find((x) => x.a === a) || null;
      // downsample the price line to keep the payload small; the orbs carry their own exact price
      const series = (bt.series || []).filter((s) => s.price != null).map((s) => ({ t: s.t, price: s.price }));
      return res.end(JSON.stringify({ address: a, token, sym: bt.sym || null, curPrice: bt.curPrice || null,
        avgCost: pos ? pos.avgCost : null, position: pos, trades: bt.walletTrades || [], price: series }));
    }

    if (u.pathname === "/api/graph") { // wallet-relationship bubble map for one token: nodes/edges/clusters (bundles)
      const address = (u.searchParams.get("address") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?address=0x…"}'); }
      const topN = Math.max(10, Math.min(300, Number(u.searchParams.get("n") || 80)));
      const meta = await ponsMeta(address).catch(() => null);
      const st = await getTransfers(address, 18, { pool: meta?.pool, launchedAt: meta?.launchedAt }).catch(() => ({ ev: null, pool: null }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (!st.ev || !st.ev.length) return res.end(JSON.stringify({ address, sym: meta?.sym || null, nodes: [], edges: [], clusters: [], stats: { nodes: 0, edges: 0, clusters: 0 }, note: "no transfer history yet" }));
      const gopts = { pool: st.pool || meta?.pool, topN };
      let g = buildGraph(st.ev, gopts), funderMeta = null;
      // opt-in common-funder pass (?funders=1): the ONLY Alchemy cost on the bubble map — top 40, cached forever
      if (u.searchParams.get("funders") === "1" && PROVIDER === "alchemy") {
        const top = g.nodes.slice().sort((a, b) => b.pct - a.pct).map((n) => n.a);
        const { funders, calls } = await resolveFunders(top, { rpc, kvGet: getJSON, kvSet: setJSON });
        const nodeSet = new Set(g.nodes.map((n) => n.a));
        const { edges: fedges, groups } = funderLinks(funders, nodeSet);
        g = buildGraph(st.ev, { ...gopts, extraEdges: fedges }); // re-cluster with the funder links
        funderMeta = { resolved: funders.size, calls, funderGroups: groups.length };
      }
      const links = { explorer: (process.env.EXPLORER_URL || "").replace(/\/$/, "") || null };
      return res.end(JSON.stringify({ address, sym: meta?.sym || null, name: meta?.name || null, transfers: st.ev.length, links, funders: funderMeta, ...g }));
    }

    if (u.pathname === "/api/token") {
      const address = (u.searchParams.get("address") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?address=0x…"}'); }
      const r = await tokenDossier(address);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(r));
    }

    if (u.pathname === "/api/board") {
      const b = ensureFresh(BOARD_REFRESH_MS);
      // Tag each verdict with an EXPLICIT section + venue so a front end can bind without inferring from which
      // array it arrived in. Additive only — every existing field (label, corridor.status, …) is untouched.
      // venue now comes from discovery (uniswap-v2/v3/v4 or a factory label); factory/venues pass through via ...t.
      const tag = (arr, section) => (arr || []).map((t) => ({ ...t, section, venue: t.venue || (section === "dex" ? "dex" : "pons") }));
      const cooking = tag(b.cooking, "cooking"), graduated = tag(b.graduated, "graduated"), dex = tag(b.dex, "dex");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ updated: b.updated, scanning: b.scanning,
        cooking, graduated, dex, stats: b.stats || {},
        convergence: convergence({ cooking, dex, graduated }, { minCount: 2 }) }));
    }
    if (u.pathname === "/api/coverage") { // the launch surface: every factory producing tokens, new ones flagged
      const blocks = Math.min(600000, Math.max(20000, Number(u.searchParams.get("blocks") || 250000)));
      const rep = await coverageReport({ blocks, force: u.searchParams.get("force") === "1" });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(rep));
    }
    if (u.pathname === "/api/smart-money") { // tokens where proven wallets have converged, ranked
      const b = ensureFresh(BOARD_REFRESH_MS);
      const minCount = Math.max(1, Number(u.searchParams.get("min") || 2));
      const rows = convergence({ cooking: b.cooking, dex: b.dex, graduated: b.graduated }, { minCount });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ updated: b.updated, minCount, count: rows.length, tokens: rows }));
    }

    if (u.pathname === "/api/scan") {
      const address = u.searchParams.get("address");
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?address=0x…"}'); }
      const decimals = Number(u.searchParams.get("decimals") || 18);
      const windowBlocks = Number(u.searchParams.get("window") || 1500);
      const result = await scan(address, { decimals, windowBlocks });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(result));
    }

    if (u.pathname === "/api/stream") {
      const address = (u.searchParams.get("address") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) { res.writeHead(400); return res.end("bad address"); }
      const decimals = Number(u.searchParams.get("decimals") || 18);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      // seed the tail: detect the pool from a cheap recent pull, then open the live subscription (ws) once per token
      let st = watch.get(address);
      if (!st) {
        const latest = await latestBlock();
        const seed = await pullTransfers(address, latest - 400, latest, decimals);
        st = { clients: new Set(), lastBlock: latest, pool: detectPool(seed), decimals, unsub: null };
        watch.set(address, st);
        if (WS_ENABLED) st.unsub = watchLogs(address, (log) => { const e = decodeLog(log, st.decimals); if (e) { emit(st, e); for (const c of st.clients) sse(c, "head", { block: e.block, n: 1 }); } });
      }
      st.clients.add(res);
      sse(res, "ready", { pool: st.pool, head: st.lastBlock, live: WS_ENABLED ? "ws" : "poll" });
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); st.clients.delete(res); if (!st.clients.size) { st.unsub?.(); watch.delete(address); } });
      return;
    }

    return serveStatic(res, u.pathname);
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => console.log(`block0 on :${PORT} (RPC ${process.env.RPC_URL ? "custom" : "public drpc"}, live tail: ${WS_ENABLED ? "websocket (eth_subscribe)" : "poll " + POLL_MS + "ms"})`));
