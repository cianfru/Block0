// THE TOKEN TIMELINE — what changed in one launch, in order, each entry with the evidence it rests on. Pure.
// Built from the same record the agent writes every cycle (docs/product.md, "Next to build" #1):
//   • every event a detector fired (alert-events.mjs on the transfer replay, agent-events.mjs on Orbio's agent list),
//     posted or not — the timeline is the record, posting is rationed separately;
//   • (graduation is a detector event too: agent/tick.mjs fires it when a launch seen on the curve is listed graduated);
//   • when Block0 started keeping the timeline, so "nothing happened" can be told apart from "nothing was watched".
// tools/agent-tick.mjs keeps one file per token (agent-data/timelines/<address>.json, served at /api/timeline/<a>),
// newest first, bounded, and kept for KEEP_DAYS after its last entry — longer than the token stays on the board, so a
// launch that left the board still shows what happened while it was watched.
import { KINDS } from "../alert-events.mjs";
import { AGENT_KINDS } from "./agent-events.mjs";

export const MAX_ENTRIES = 100, KEEP_DAYS = 30;
const CHAIN = "Robinhood Chain transfers, read on the free node", ORBIO = "Orbio protocol API (api.orbio.so)";

const metaOf = (kind) => KINDS[kind] || AGENT_KINDS[kind] || STATE_KINDS[kind] || {};
export const STATE_KINDS = {
  coverage: { sev: "info", label: "timeline starts" },
};

// the evidence for one detector event, by kind: what anyone can check, and where it came from
export function evidenceOf(ev) {
  const d = ev.detail || {};
  if (ev.kind === "insider-dump") return { source: CHAIN, block: d.block ?? null,
    wallets: (d.wallets || []).map((w) => ({ a: w.a, amt: w.amt ?? null, block: w.block ?? null, bal: w.bal ?? null })),
    note: "early wallet = a sniper (first buy within 3 blocks of the first pool buy) or a same-block bundle; a sale = tokens sent into the pool or curve in the 30 minutes before the read" };
  if (ev.kind === "graduated") return { source: "Pons launchpad listing (graduated flag) + the launch's own transfers", detail: d };
  if (ev.kind === "serial-owner" && ev.venue === "pons") return { source: "Pons launchpad's deployer record (ponsfamily.com /api/deployers)", owner: ev.owner ?? null, detail: d };
  if (AGENT_KINDS[ev.kind]) return { source: ORBIO, owner: ev.owner ?? null, agentId: ev.agentId ?? null, detail: d };
  return { source: CHAIN, detail: d };
}

// a detector event (with its numbers at the time) → a timeline entry
export function entryOf(ev, { validated = true } = {}) {
  const m = metaOf(ev.kind);
  return { id: ev.id || `${ev.kind}:${ev.address}:${ev.at}`, at: ev.at, kind: ev.kind, sev: m.sev || "info", label: m.label || ev.kind,
    headline: ev.headline ?? null, validated,
    context: { mcapUsd: ev.mcapUsd ?? null, holders: ev.holders ?? null, risk: ev.risk ?? null, ageH: ev.ageH == null ? null : +(+ev.ageH).toFixed(1) },
    evidence: evidenceOf(ev) };
}

// the coverage marker for a launch's first timeline entry (prev is kept for future read-to-read state changes)
export function stateEntries(prev, cur, { now = Date.now(), first = false } = {}) {
  const out = [];
  if (!cur?.address) return out;
  if (first) out.push({ id: `coverage:${cur.address}`, at: now, kind: "coverage", sev: "info", label: STATE_KINDS.coverage.label,
    headline: "Block0 started keeping this timeline · the launch is read about every 15 minutes while it is under 72 hours old",
    validated: true, context: ctx(cur), evidence: { source: CHAIN } });
  return out;
}
const ctx = (t) => ({ mcapUsd: t.mcapUsd ?? null, holders: t.flags?.holders ?? null, risk: t.risk ?? null, ageH: t.launchedAgeH ?? t.ageH ?? null });

// merge new entries into a token's timeline: dedupe by id (the newer copy wins), newest first, bounded
export function appendTimeline(prev, entries, { address, sym = null, now = Date.now(), max = MAX_ENTRIES } = {}) {
  const byId = new Map(((prev && prev.entries) || []).map((e) => [e.id, e]));
  for (const e of entries || []) byId.set(e.id, e);
  const list = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, max);
  // the coverage marker is never dropped: without it an empty stretch reads as "watched, nothing happened"
  if (list.length === max && byId.has(`coverage:${address}`) && !list.some((e) => e.kind === "coverage")) list[max - 1] = byId.get(`coverage:${address}`);
  return { address, sym: sym ?? prev?.sym ?? null, updated: now, lastEventAt: list.filter((e) => e.kind !== "coverage").reduce((m, e) => Math.max(m, e.at), prev?.lastEventAt ?? 0) || null,
    source: "block0 agent — every event detected for this launch, posted or not, with its evidence", entries: list };
}

export const expired = (tl, now = Date.now(), keepDays = KEEP_DAYS) => now - Math.max(tl?.lastEventAt || 0, tl?.updated || 0) > keepDays * 86400e3;

// One-time seed from the ledgers written before timelines existed (events.jsonl rows and the alert strip). Those rows
// carry a headline but no evidence, and are marked so. Rows from the first detector (headline says "insider") counted
// any transfer out as selling (fixed 2026-10-01) — they measured something else and are left out.
export function backfillEntries(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r?.address || !r.kind || !r.at || /insider/i.test(r.headline || "")) continue;
    const m = metaOf(r.kind), id = `${r.kind}:${r.address}:${r.at}`;
    out.set(id, { id, at: r.at, kind: r.kind, sev: m.sev || "info", label: m.label || r.kind, headline: r.headline ?? null,
      validated: r.validated ?? !["smart-convergence", "clean-launch"].includes(r.kind), context: null,
      evidence: { source: AGENT_KINDS[r.kind] ? ORBIO : CHAIN, backfilled: true, note: "recorded before evidence was kept with each event" },
      address: r.address, sym: r.sym ?? null });   // address/sym route the entry to its file; the caller strips them
  }
  return [...out.values()];
}
