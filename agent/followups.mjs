// FOLLOW-UPS — what happened after a material event, reported on the same thread (docs/product.md, "Next to build" #2).
// Pure. An event that cleared the materiality bar (agent/materiality.mjs) opens a follow-up due HORIZON_H later; when it
// is due, the tick hands in the launch's current numbers and this module writes the update: for early-wallet sales,
// whether those exact wallets have since sold out; for every kind, market cap and holders then → now. The update goes
// on the launch's timeline and, when the original was posted, as a reply to that post. Facts after the fact — never a
// verdict on whether the event "mattered" (that is the forward test's job, and it is not this one).
import { cleanSym, MAX_LEN } from "./format.mjs";

export const HORIZON_H = 24, GRACE_H = 6, KINDS = new Set(["insider-dump", "serial-owner", "graduated"]);

// events (with fate, from the tick) → follow-ups to open; only material kinds that reached the posting gate
export function openFollowUps(follow, events, { now = Date.now(), posted = {} } = {}) {
  const next = { ...(follow || {}) };
  for (const e of events || []) {
    if (!KINDS.has(e.kind) || !["posted", "dry-run", "held"].includes(e.fate) || next[e.id]) continue;
    next[e.id] = { id: e.id, kind: e.kind, address: e.address, sym: e.sym ?? null, at: e.at ?? now, due: (e.at ?? now) + HORIZON_H * 3600e3,
      headline: e.headline ?? null, mcapUsd: e.mcapUsd ?? null, holders: e.holders ?? null,
      wallets: (e.detail?.wallets || []).map((w) => w.a), owner: e.owner ?? null, prior: e.detail?.prior ?? null,
      fate: e.fate, postId: posted[e.id] ?? null };
  }
  return next;
}

// the wallets each launch's due-soon follow-ups need balances for (passed to the token read)
export function watchList(follow, now = Date.now(), aheadMs = 3600e3) {
  const out = {};
  for (const f of Object.values(follow || {})) {
    if (f.due - now > aheadMs || !f.wallets?.length) continue;
    const s = (out[f.address] ||= new Set());
    for (const a of f.wallets) s.add(a);
  }
  return Object.fromEntries(Object.entries(out).map(([a, s]) => [a, [...s]]));
}

const $ = (x) => (x == null ? null : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x));
const n = (x) => Number(x).toLocaleString("en-US");
const qty = (x) => (x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? Math.round(x / 1e3) + "k" : String(Math.round(x)));

// a due follow-up + the launch now → { headline } or { wait: true } (no fresh read yet, still inside the grace window)
//   cur: { mcapUsd, holders, graduated, read: boolean, watched: { wallet: balance }, ownerLaunched, ownerGraduated }
export function writeFollowUp(f, cur, { now = Date.now() } = {}) {
  const late = now > f.due + GRACE_H * 3600e3;
  if (f.kind === "insider-dump" && f.wallets.length && !cur?.watched && !late) return { wait: true };
  const parts = [];
  if (f.kind === "insider-dump" && cur?.watched) {
    const bals = f.wallets.map((a) => cur.watched[a] ?? 0), out = bals.filter((b) => b <= 0).length, still = bals.filter((b) => b > 0);
    parts.push(out === f.wallets.length ? (f.wallets.length === 1 ? "the early wallet that sold has since sold out" : `all ${f.wallets.length} early wallets that sold have since sold out`)
      : `${out} of the ${f.wallets.length} early wallets that sold have since sold out; ${still.length} still hold ${still.map(qty).join(" / ")}`);
  }
  if (f.mcapUsd != null && cur?.mcapUsd != null) parts.push(`market cap ${$(f.mcapUsd)} → ${$(cur.mcapUsd)}`);
  if (f.holders != null && cur?.holders != null) parts.push(`holders ${n(f.holders)} → ${n(cur.holders)}`);
  if (cur?.graduated != null) parts.push(cur.graduated ? "graduated" : "not graduated");
  if (f.kind === "serial-owner" && cur?.ownerLaunched != null) parts.push(`the owner has now launched ${cur.ownerLaunched} agents, ${cur.ownerGraduated ?? 0} graduated`);
  if (!parts.length) return { headline: null, why: "no current numbers for this launch" };
  return { headline: parts.join(" · ") };
}

export function formatFollowUp(f, headline) {
  const h = Math.round(HORIZON_H);
  const lines = [`↻ $${cleanSym(f.sym)} — ${h}h later`, headline, f.address, "On-chain facts, not advice."];
  let text = lines.join("\n");
  if (text.length > MAX_LEN) { lines[1] = headline.slice(0, Math.max(20, MAX_LEN - (text.length - headline.length) - 1)) + "…"; text = lines.join("\n"); }
  return text;
}

// a written follow-up → its timeline entry (agent/timeline.mjs shape), pointing at the event it follows
export function followUpEntry(f, headline, cur, now = Date.now()) {
  return { id: `follow-up:${f.id}`, at: now, kind: "follow-up", sev: "info", label: `${HORIZON_H}h later`, headline, validated: true, ref: f.id,
    refHeadline: f.headline, context: { mcapUsd: cur?.mcapUsd ?? null, holders: cur?.holders ?? null, risk: null, ageH: null },
    evidence: { source: "the launch's own transfers and listing, re-read on the free node", wallets: f.kind === "insider-dump" && cur?.watched
      ? f.wallets.map((a) => ({ a, amt: null, block: null, bal: cur.watched[a] ?? 0 })) : undefined } };
}
