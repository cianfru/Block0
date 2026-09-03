// Durable key/value + small collections — dependency-free, with THREE backends (auto-selected):
//   • redis (REST) — Upstash / Vercel KV REST API (KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_*).
//   • redis (TCP)  — a native redis:// / rediss:// service (Railway, Redis Cloud, …) via REDIS_URL. No SDK: RESP
//                    over a raw socket (store/redis-tcp.mjs). This is what Railway's managed Redis gives you.
//   • file         — a JSON file under DATA_DIR (default ./data). Zero-config; durable only within a deploy (or
//                    across redeploys if DATA_DIR is a mounted volume). Dev / single persistent container.
// Everything degrades safely: a store error never throws into the caller (reads return null/[], writes best-effort),
// so the scanner runs even if the store is down. Precedence: REST > TCP > file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redisCmd, HAS_REDIS_URL } from "./redis-tcp.mjs";

const R_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const MODE = (R_URL && R_TOK) ? "rest" : HAS_REDIS_URL ? "tcp" : "file";
export const KV_BACKEND = MODE === "file" ? "file" : "redis";   // public label ("redis" covers both REST + TCP)

// ---- unified command: REST (fetch a JSON array → {result}) or TCP (RESP over a socket) ----
async function rcmd(...args) {
  if (MODE === "tcp") return redisCmd(args);
  const r = await fetch(R_URL, { method: "POST", headers: { authorization: `Bearer ${R_TOK}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error("kv " + r.status);
  const j = await r.json();
  return j.result;
}

// Live connectivity check — did the app ACTUALLY connect, or is it silently on the file backend? Used by /api/status.
export async function kvPing() {
  if (MODE === "file") return { backend: "file", mode: "file", ok: true };
  try { const r = await rcmd("PING"); return { backend: "redis", mode: MODE, ok: String(r).toUpperCase().includes("PONG") }; }
  catch (e) { return { backend: "redis", mode: MODE, ok: false, error: String((e && e.message) || e).slice(0, 100) }; }
}

// ---- file backend: one JSON doc mirrored in memory, debounced to disk ----
const DIR = process.env.DATA_DIR || "./data";
const FILE = join(DIR, "kv.json");
let mem = null, wt = null;
function load() {
  if (mem) return mem;
  try { mem = JSON.parse(readFileSync(FILE, "utf8")); } catch { mem = {}; }
  return mem;
}
function flush() {
  if (wt) return; wt = setTimeout(() => { wt = null; try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(mem)); } catch { /* best-effort */ } }, 200);
}

// ---- public API (all soft-failing) ----
export async function getJSON(key) {
  try {
    if (KV_BACKEND === "redis") { const v = await rcmd("GET", key); return v == null ? null : JSON.parse(v); }
    return load()[key] ?? null;
  } catch { return null; }
}
export async function setJSON(key, val) {
  try {
    if (KV_BACKEND === "redis") { await rcmd("SET", key, JSON.stringify(val)); return true; }
    load()[key] = val; flush(); return true;
  } catch { return false; }
}
// set membership
export async function sAdd(key, member) {
  try {
    if (KV_BACKEND === "redis") { await rcmd("SADD", key, member); return true; }
    const m = load(); const a = m[key] ||= []; if (!a.includes(member)) a.push(member); flush(); return true;
  } catch { return false; }
}
export async function sHas(key, member) {
  try {
    if (KV_BACKEND === "redis") return (await rcmd("SISMEMBER", key, member)) === 1;
    return (load()[key] || []).includes(member);
  } catch { return false; }
}
export async function sMembers(key) {
  try {
    if (KV_BACKEND === "redis") return (await rcmd("SMEMBERS", key)) || [];
    return load()[key] || [];
  } catch { return []; }
}
// capped list (newest first): push to head, trim to `cap`
export async function lPush(key, val, cap = 500) {
  try {
    if (KV_BACKEND === "redis") { await rcmd("LPUSH", key, JSON.stringify(val)); await rcmd("LTRIM", key, 0, cap - 1); return true; }
    const m = load(); const a = m[key] ||= []; a.unshift(val); if (a.length > cap) a.length = cap; flush(); return true;
  } catch { return false; }
}
export async function lRange(key, n = 100) {
  try {
    if (KV_BACKEND === "redis") { const a = await rcmd("LRANGE", key, 0, n - 1); return (a || []).map((x) => { try { return JSON.parse(x); } catch { return x; } }); }
    return (load()[key] || []).slice(0, n);
  } catch { return []; }
}
