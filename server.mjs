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
import { refreshBoard, refreshDex, getBoard, ensureFresh } from "./board.mjs";
import { backtest } from "./backtest.mjs";
import { tokenDossier } from "./dossier.mjs";
import { startAlerts, runAlertScan, getCalls, ALERTS_ON } from "./alerts.mjs";
import { KV_BACKEND, getJSON, setJSON } from "./store/kv.mjs";
import { getTransfers } from "./store.mjs";
import { fetchActive, fetchGraduated } from "./pons.mjs";
import { PROVIDER } from "./rpc.mjs";
import { traceEvents, discoverDex, recentDexTokens, DEX_CONFIG } from "./dex.mjs";
import { walletIntel } from "./wallet.mjs";
import { buildLeaderboard } from "./leaderboard.mjs";
import { buildGraph } from "./graph.mjs";

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
const BT_TTL = Number(process.env.BT_TTL_MS || 30 * 60 * 1000); // serve a cached backtest for 30 min before recomputing
const STORE_CAP = 25000;
async function computeBacktest(token, key, { points, ethUsd, noPrice, cap, sym }) {
  const kvKey = `bt:${key}`;
  const cached = await getJSON(kvKey).catch(() => null);
  if (cached && cached.data && Date.now() - cached.at < BT_TTL) return cached.data;
  const meta = await ponsMeta(token);
  const st = await getTransfers(token, 18, { pool: meta?.pool, launchedAt: meta?.launchedAt }).catch(() => ({ ev: null }));
  const complete = st.ev && st.ev.length > 0 && st.ev.length < STORE_CAP - 1000; // store holds the whole history
  const r = anchorToPons({
    ...(await backtest(token, { sym: meta?.sym || sym || "?", pool: meta?.pool, graduated: !!meta?.graduated, launchedAt: meta?.launchedAt, points, ethUsd, noPrice, cap, ev: complete ? st.ev : null })),
    name: meta?.name, logo: meta?.logo, mcapUsd: meta?.mcapUsd, priceUsd: meta?.priceUsd,
  }, meta?.mcapUsd);
  setJSON(kvKey, { at: Date.now(), data: r }).catch(() => {});
  return r;
}

// background discover-board: scan every live launch, verdict + market-cap-bucket, keep a ranked cache
const BOARD_REFRESH_MS = Number(process.env.BOARD_REFRESH_MS || 180000);
refreshBoard({ n: Number(process.env.BOARD_TOKENS || 18) }).catch(() => {});
setInterval(() => refreshBoard({ n: Number(process.env.BOARD_TOKENS || 18) }).catch(() => {}), BOARD_REFRESH_MS);

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
const LB_TOKENS = Number(process.env.LEADERBOARD_TOKENS || 40); // how many winners to aggregate over
let _leaderboard = null, _lbRunning = false;
async function refreshLeaderboard() {
  if (_lbRunning) return; _lbRunning = true;
  try {
    const b = getBoard();
    // winners only: graduated launchpad tokens + DEX-listed tokens, biggest first, deduped
    const seen = new Set();
    const tokens = [...(b.graduated || []), ...(b.dex || [])]
      .filter((t) => t.address && !seen.has(t.address) && seen.add(t.address))
      .sort((x, y) => (y.mcapUsd || 0) - (x.mcapUsd || 0))
      .slice(0, LB_TOKENS)
      .map((t) => ({ address: t.address.toLowerCase(), sym: t.sym }));
    if (!tokens.length) return;
    const lb = await buildLeaderboard(tokens, (addr) => computeBacktest(addr, `${addr}:90:3000:false:${Number(process.env.BT_CAP || 100000)}`, { points: 90, ethUsd: 3000 }));
    _leaderboard = lb;
    setJSON("leaderboard", lb).catch(() => {});
  } catch { /* transient — next tick retries */ } finally { _lbRunning = false; }
}
if (Number(process.env.LEADERBOARD_ON ?? 1) > 0) {
  getJSON("leaderboard").then((v) => { if (v) _leaderboard = v; }).catch(() => {});
  setTimeout(() => { refreshLeaderboard(); setInterval(refreshLeaderboard, LB_REFRESH_MS); }, 90000);
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
  const route = urlPath === "/" ? "board.html" : (urlPath === "/token" || urlPath === "/token.html") ? "index.html"
    : (urlPath === "/methodology" || urlPath === "/methodology.html") ? "methodology.html"
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

    if (u.pathname === "/api/status") { // system health/monitoring — board freshness, alert + store state, RPC provider
      const b = getBoard();
      const ageMs = b.updated ? Date.now() - b.updated : null;
      const healthy = !!b.updated && ageMs < BOARD_REFRESH_MS * 3;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({
        ok: healthy, uptimeS: Math.round(process.uptime()),
        board: { updated: b.updated || null, ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000), scanning: !!b.scanning,
          cooking: (b.cooking || []).length, graduated: (b.graduated || []).length, dex: (b.dex || []).length, store: b.stats?.store || null },
        rpc: { provider: PROVIDER }, alerts: { on: ALERTS_ON }, storage: { backend: KV_BACKEND },
      }));
    }

    if (u.pathname === "/api/alerts/calls") { // the durable track record of past alerts
      const calls = await getCalls(Number(u.searchParams.get("n") || 100));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ calls }));
    }

    if (u.pathname === "/api/leaderboard") { // proven-PnL wallets to follow — aggregated across graduated + DEX winners
      const lb = _leaderboard || await getJSON("leaderboard").catch(() => null);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (!lb) return res.end(JSON.stringify({ computing: true, rows: [] })); // first build not finished yet
      const n = Math.max(1, Math.min(200, Number(u.searchParams.get("n") || 100)));
      return res.end(JSON.stringify({ ...lb, rows: (lb.rows || []).slice(0, n) }));
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

    if (u.pathname === "/api/graph") { // wallet-relationship bubble map for one token: nodes/edges/clusters (bundles)
      const address = (u.searchParams.get("address") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?address=0x…"}'); }
      const topN = Math.max(10, Math.min(300, Number(u.searchParams.get("n") || 80)));
      const meta = await ponsMeta(address).catch(() => null);
      const st = await getTransfers(address, 18, { pool: meta?.pool, launchedAt: meta?.launchedAt }).catch(() => ({ ev: null, pool: null }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (!st.ev || !st.ev.length) return res.end(JSON.stringify({ address, sym: meta?.sym || null, nodes: [], edges: [], clusters: [], stats: { nodes: 0, edges: 0, clusters: 0 }, note: "no transfer history yet" }));
      const g = buildGraph(st.ev, { pool: st.pool || meta?.pool, topN });
      return res.end(JSON.stringify({ address, sym: meta?.sym || null, name: meta?.name || null, transfers: st.ev.length, ...g }));
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
      const tag = (arr, section) => (arr || []).map((t) => ({ ...t, section, venue: t.venue || (section === "dex" ? "uniswap-v4" : "pons") }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ updated: b.updated, scanning: b.scanning,
        cooking: tag(b.cooking, "cooking"), graduated: tag(b.graduated, "graduated"), dex: tag(b.dex, "dex"), stats: b.stats || {} }));
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
