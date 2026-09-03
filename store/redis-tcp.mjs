// Dependency-free Redis client over the native RESP protocol (TCP / TLS) — so Railway's redis:// service works
// without an SDK. Speaks only what store/kv.mjs needs (GET/SET/SADD/SISMEMBER/SMEMBERS/LPUSH/LTRIM/LRANGE/PING).
//
// One lazy persistent connection with an in-order reply queue (Redis answers commands in the order sent), an
// incremental length-prefixed parser (handles replies split across TCP chunks or batched in one), AUTH + SELECT on
// connect, and reconnect on drop. All soft-failing: a dead socket rejects the command, and kv.mjs turns that into a
// null/[]/false so the scanner never crashes on a store hiccup. The pure encode/parseOne are exported for tests.
import net from "node:net";
import tls from "node:tls";

export function parseRedisUrl(u) {
  try {
    const x = new URL(u);
    if (!/^rediss?:$/.test(x.protocol)) return null;
    return { host: x.hostname, port: Number(x.port || 6379), user: decodeURIComponent(x.username || ""),
      pass: decodeURIComponent(x.password || ""), tls: x.protocol === "rediss:", db: (x.pathname || "").replace(/^\//, "") };
  } catch { return null; }
}

// RESP command encoding: *<n>\r\n $<bytelen>\r\n <arg>\r\n …  (byte length so multibyte JSON values are correct)
export function encode(args) {
  let s = "*" + args.length + "\r\n";
  for (const a of args) { const v = String(a); s += "$" + Buffer.byteLength(v) + "\r\n" + v + "\r\n"; }
  return s;
}

// Parse ONE reply from buf starting at i. Returns { v, next, err } or null if the buffer doesn't yet hold a full reply.
export function parseOne(buf, i = 0) {
  if (i >= buf.length) return null;
  const type = buf[i];
  const end = buf.indexOf("\r\n", i + 1, "latin1");
  if (end < 0) return null;                                    // header line incomplete
  const line = buf.toString("latin1", i + 1, end);
  if (type === 43) return { v: line, next: end + 2 };          // '+' simple string
  if (type === 45) return { v: new Error(line), err: true, next: end + 2 }; // '-' error
  if (type === 58) return { v: Number(line), next: end + 2 };  // ':' integer
  if (type === 36) {                                           // '$' bulk string
    const len = Number(line); if (len === -1) return { v: null, next: end + 2 };
    const start = end + 2, stop = start + len;
    if (stop + 2 > buf.length) return null;                    // body not fully arrived
    return { v: buf.toString("utf8", start, stop), next: stop + 2 };
  }
  if (type === 42) {                                           // '*' array
    const count = Number(line); if (count === -1) return { v: null, next: end + 2 };
    const out = []; let p = end + 2;
    for (let k = 0; k < count; k++) { const r = parseOne(buf, p); if (!r) return null; out.push(r.err ? null : r.v); p = r.next; }
    return { v: out, next: p };
  }
  return { v: null, next: end + 2 };                           // unknown — skip the line
}

const URL_STR = process.env.REDIS_URL || process.env.REDIS_TLS_URL || process.env.REDISCLOUD_URL || "";
export const HAS_REDIS_URL = !!parseRedisUrl(URL_STR);

let sock = null, ready = null, pending = [], buf = Buffer.alloc(0);

function failAll(err) {
  const q = pending; pending = []; for (const p of q) p.reject(err);
  buf = Buffer.alloc(0); sock = null; ready = null;                 // force reconnect next call
}
function onData(chunk) {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  for (;;) { const r = parseOne(buf, 0); if (!r) break; buf = buf.subarray(r.next); const p = pending.shift(); if (p) { r.err ? p.reject(r.v) : p.resolve(r.v); } }
}
function write(args) { return new Promise((resolve, reject) => { if (!sock) return reject(new Error("no socket")); pending.push({ resolve, reject }); sock.write(encode(args)); }); }

function ensure() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const cfg = parseRedisUrl(URL_STR); if (!cfg) return reject(new Error("no/invalid REDIS_URL"));
    const s = cfg.tls ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
    s.setNoDelay(true); s.setKeepAlive(true, 30000);
    s.on("data", onData);
    s.on("error", (e) => { if (sock !== s) reject(e); failAll(e); });
    s.on("close", () => failAll(new Error("redis connection closed")));
    s.once(cfg.tls ? "secureConnect" : "connect", () => {
      sock = s;
      (async () => {
        try {
          if (cfg.pass) await write(cfg.user ? ["AUTH", cfg.user, cfg.pass] : ["AUTH", cfg.pass]);
          if (cfg.db && cfg.db !== "0") await write(["SELECT", cfg.db]);
          resolve();
        } catch (e) { try { s.destroy(); } catch {} reject(e); }
      })();
    });
  }).catch((e) => { ready = null; sock = null; throw e; });          // allow a fresh attempt next command
  return ready;
}

export async function redisCmd(args) { await ensure(); return write(args); }
