// Durable key/value + small collections — dependency-free, with two backends:
//   • redis  — Upstash / Vercel KV REST API (set KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_*).
//              Survives Railway restarts AND redeploys. This is the production choice.
//   • file   — a JSON file under DATA_DIR (default ./data). Zero-config; durable only within a deploy (or across
//              redeploys if DATA_DIR is a mounted volume). Good for dev and a single persistent container.
// No SDK — Redis is spoken over its REST command API with fetch. Everything degrades safely: a store error never
// throws into the caller (reads return null/[], writes best-effort), so the scanner runs even if the store is down.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const R_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const KV_BACKEND = R_URL && R_TOK ? "redis" : "file";

// ---- redis REST: POST the command as a JSON array, read {result} ----
async function rcmd(...args) {
  const r = await fetch(R_URL, { method: "POST", headers: { authorization: `Bearer ${R_TOK}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error("kv " + r.status);
  const j = await r.json();
  return j.result;
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
