// Real-time transfer tail over an Alchemy (or any EVM) websocket via eth_subscribe("logs").
// One shared socket; one log-subscription per watched token, added when the first viewer opens it and
// dropped when the last leaves. Auto-reconnects and re-subscribes on drop. If RPC_WS is unset the server
// falls back to HTTP polling. The only npm dependency in the project — everything else is Node built-ins.
import WebSocket from "ws";
import { TRANSFER_TOPIC } from "./rpc.mjs";

const WS_URL = (process.env.RPC_WS || "").trim();
export const WS_ENABLED = !!WS_URL;

let ws = null, ready = false, nextId = 1, reconnectT = null;
const pending = new Map();       // rpc id -> resolver
const subs = new Map();          // subscription id -> { address, onLog }
const want = new Map();          // address -> { onLog, subId }

function connect() {
  if (!WS_ENABLED || ws) return;
  ws = new WebSocket(WS_URL);
  ws.on("open", () => { ready = true; for (const [addr, w] of want) doSubscribe(addr, w); });
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === "eth_subscription") { const s = subs.get(m.params?.subscription); if (s && m.params?.result) { try { s.onLog(m.params.result); } catch { /* */ } } }
  });
  ws.on("close", () => { ready = false; ws = null; scheduleReconnect(); });
  ws.on("error", () => { try { ws.close(); } catch { /* */ } });
}
function scheduleReconnect() {
  if (reconnectT || !want.size) return;
  reconnectT = setTimeout(() => { reconnectT = null; subs.clear(); for (const w of want.values()) w.subId = null; connect(); }, 2000);
}
function call(method, params) {
  return new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); try { ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); } catch { resolve(null); } });
}
async function doSubscribe(address, w) {
  if (!ready) return;
  const sid = await call("eth_subscribe", ["logs", { address, topics: [TRANSFER_TOPIC] }]);
  if (typeof sid === "string") { w.subId = sid; subs.set(sid, { address, onLog: w.onLog }); }
}

// start pushing this token's transfer logs to onLog(log); returns an unsubscribe fn
export function watchLogs(address, onLog) {
  address = address.toLowerCase();
  let w = want.get(address);
  if (w) { w.onLog = onLog; } else { w = { onLog, subId: null }; want.set(address, w); if (!ws) connect(); else doSubscribe(address, w); }
  return () => unwatch(address);
}
export async function unwatch(address) {
  address = address.toLowerCase();
  const w = want.get(address); if (!w) return;
  want.delete(address);
  if (w.subId) { subs.delete(w.subId); try { await call("eth_unsubscribe", [w.subId]); } catch { /* */ } }
}
