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
import { refreshBoard, getBoard, ensureFresh } from "./board.mjs";
import { backtest } from "./backtest.mjs";
import { fetchActive, fetchGraduated } from "./pons.mjs";

// find a token's Pons metadata (pool / graduated / launchedAt / symbol) by address, for the backtest
const _btCache = new Map();
async function ponsMeta(token) {
  const [a, g] = await Promise.all([fetchActive({ pageSize: 400 }).catch(() => ({ items: [] })), fetchGraduated().catch(() => ({ items: [] }))]);
  return [...(a.items || []), ...(g.items || [])].find((t) => t.address === token) || null;
}

// background discover-board: scan every live launch, verdict + market-cap-bucket, keep a ranked cache
const BOARD_REFRESH_MS = Number(process.env.BOARD_REFRESH_MS || 180000);
refreshBoard({ n: Number(process.env.BOARD_TOKENS || 18) }).catch(() => {});
setInterval(() => refreshBoard({ n: Number(process.env.BOARD_TOKENS || 18) }).catch(() => {}), BOARD_REFRESH_MS);

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
  const route = urlPath === "/" ? "board.html" : (urlPath === "/token" || urlPath === "/token.html") ? "index.html" : null;
  const file = route || urlPath.replace(/^\//, "");
  try {
    const buf = await readFile(join(__dir, "public", file));
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
}

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }

    // Temporary: source loser/laggard candidates from the Pons universe to validate the blueprint against.
    if (u.pathname === "/api/losers") {
      const [a, g] = await Promise.all([fetchActive({ pageSize: 500 }).catch(() => ({ items: [] })), fetchGraduated().catch(() => ({ items: [] }))]);
      const now = Date.now();
      const ageD = (t) => t.launchedAt ? (now - Date.parse(t.launchedAt)) / 86400000 : 0;
      const staleD = (t) => (now - Date.parse(t.latestBuyAt || t.launchedAt || 0)) / 86400000;
      // launched >4d ago, tiny cap now, no recent buys → had a shot and died
      const dead = (a.items || []).filter((t) => t.address && ageD(t) > 4 && t.mcapUsd < 9000 && staleD(t) > 1.5)
        .sort((x, y) => ageD(y) - ageD(x)).slice(0, 10);
      // graduated but faded to the bottom of the pack
      const faded = (g.items || []).filter((t) => t.address).sort((x, y) => (x.mcapUsd || 0) - (y.mcapUsd || 0)).slice(0, 6);
      const map = (t, kind) => ({ sym: t.sym, address: t.address, mcapUsd: Math.round(t.mcapUsd || 0), graduated: !!t.graduated, launchedAt: t.launchedAt, pool: t.pool, kind });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ dead: dead.map((t) => map(t, "dead")), faded: faded.map((t) => map(t, "faded")) }, null, 2));
    }

    if (u.pathname === "/api/backtest") {
      const token = (u.searchParams.get("token") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"pass ?token=0x…"}'); }
      const points = Number(u.searchParams.get("points") || 90), ethUsd = Number(u.searchParams.get("eth") || 3000);
      const noPrice = u.searchParams.get("price") === "0", cap = Number(u.searchParams.get("cap") || 400000);
      const key = `${token}:${points}:${ethUsd}:${noPrice}:${cap}`;
      if (!_btCache.has(key)) {
        const meta = await ponsMeta(token);
        _btCache.set(key, backtest(token, { sym: meta?.sym || u.searchParams.get("sym") || "?", pool: meta?.pool, graduated: !!meta?.graduated, launchedAt: meta?.launchedAt, points, ethUsd, noPrice, cap })
          .then((r) => ({ ...r, name: meta?.name, logo: meta?.logo, mcapUsd: meta?.mcapUsd, priceUsd: meta?.priceUsd }))
          .catch((e) => { _btCache.delete(key); throw e; }));
      }
      const out = await _btCache.get(key);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(out));
    }

    if (u.pathname === "/api/board") {
      const b = ensureFresh(BOARD_REFRESH_MS);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ updated: b.updated, scanning: b.scanning, cooking: b.cooking || [], graduated: b.graduated || [], stats: b.stats || {} }));
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
