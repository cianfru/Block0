// FORWARD OUT-OF-SAMPLE TRACK RECORD — the honest proof that accrues over time.
//
// The methodology page's LOO/AUC measure SEPARATION on the study cohort — in-sample, by construction. This measures
// the real thing a trader cares about: we SCORE a launch while it is still YOUNG (before the outcome is known),
// freeze that call, then observe what ACTUALLY happened days later. The realized hit-rate — "when we flagged a young
// launch PROMISING, it went on to win X% of the time, across N resolved launches" — is a live, never-seen-it-before
// track record. It starts empty and fills in as launches mature; that honest "accruing" state is the point.
//
// Persisted in KV so it survives restarts once a store is connected (degrades to in-process otherwise). All the
// scoring logic is pure + exported so it is unit-tested without a chain or a clock.
import { getJSON, setJSON } from "./store/kv.mjs";

// ── knobs (env-overridable) ──────────────────────────────────────────────────────────────────────────────────
const PREDICT_MAX_AGE_H = Number(process.env.TR_PREDICT_MAX_AGE_H || 8);   // only count tokens we called while this young
const MATURE_H = Number(process.env.TR_MATURE_H || 72);                    // resolve as loser after this if not a winner
const WIN_MCAP = Number(process.env.TR_WIN_MCAP || 1_000_000);            // a real outcome: reached this mcap…
const WIN_MULT = Number(process.env.TR_WIN_MULT || 4);                     // …or ≥ this multiple of its early mcap
const KEEP = Number(process.env.TR_KEEP || 5000);                         // cap the store size
const MIN_SHOW = Number(process.env.TR_MIN_SHOW || 10);                   // below this many resolved, show "accruing" not a rate

// Classify our EARLY call from the first young prediction — mirrors what the board surfaces as "worth watching".
export function earlyCall(p) {
  if (!p) return "unknown";
  if (p.corridorStatus === "on-track" || ((p.blueprint || 0) >= 55 && (p.risk ?? 100) < 30)) return "promising";
  if ((p.risk ?? 0) >= 45 || p.corridorStatus === "failing") return "avoid";
  return "watch";
}

// Ingest the current board verdicts: create/extend a record per token with a FROZEN young prediction + running peak.
export function ingest(store, tokens, now = Date.now()) {
  store.tokens = store.tokens || {};
  for (const t of tokens || []) {
    if (!t || !t.address) continue;
    const ageH = t.ageH != null ? t.ageH : null;
    const mcap = t.mcapUsd || 0;
    let r = store.tokens[t.address];
    if (!r) r = store.tokens[t.address] = { address: t.address, sym: t.sym || null, firstSeen: now, firstMcap: mcap, peakMcap: mcap, graduated: !!t.graduated, lastSeen: now, prediction: null, call: null, resolved: false, outcome: null };
    r.lastSeen = now; r.sym = r.sym || t.sym || null;
    if (mcap > r.peakMcap) r.peakMcap = mcap;
    if (t.graduated) r.graduated = true;
    // freeze the FIRST prediction made while the token is still young — a genuine forward call, made before the outcome
    if (!r.prediction && ageH != null && ageH <= PREDICT_MAX_AGE_H) {
      r.prediction = { ts: now, ageH: +ageH.toFixed(2), risk: t.risk, blueprint: t.blueprint ?? null, corridorStatus: (t.corridor && t.corridor.status) || null, mcap };
      r.call = earlyCall(r.prediction);
    }
  }
  return store;
}

// Resolve outcomes for matured tokens (winner = graduated / hit WIN_MCAP / ran WIN_MULT×; loser = matured & not a winner).
export function resolve(store, now = Date.now()) {
  for (const r of Object.values(store.tokens || {})) {
    if (r.resolved) continue;
    const win = r.graduated || r.peakMcap >= WIN_MCAP || (r.firstMcap > 0 && r.peakMcap >= r.firstMcap * WIN_MULT);
    if (win) { r.resolved = true; r.outcome = "winner"; r.resolvedAt = now; continue; }
    if ((now - r.firstSeen) / 3.6e6 >= MATURE_H) { r.resolved = true; r.outcome = "loser"; r.resolvedAt = now; }
  }
  const all = Object.values(store.tokens);           // trim oldest by last-seen
  if (all.length > KEEP) { all.sort((a, b) => a.lastSeen - b.lastSeen); for (let i = 0; i < all.length - KEEP; i++) delete store.tokens[all[i].address]; }
  return store;
}

// The live track record. Only tokens with a YOUNG frozen prediction count (a genuine forward call).
export function report(store, now = Date.now()) {
  const recs = Object.values((store && store.tokens) || {}).filter((r) => r.prediction && r.call);
  // HONESTY RAIL: a winner resolves the moment it runs, a loser only at MATURE_H. Counting every resolved token
  // therefore over-represents winners at ANY snapshot — a freshly-started store read 100% wins (baseRate 1, lift 1,
  // "avoid" 9/9 winners) purely because no token had aged enough to resolve as a loser yet. Rates are computed over
  // the MATURED cohort only: tokens old enough that either outcome was possible (every one of them is resolved).
  // Winners that ran early but aren't matured yet are reported separately as wonEarly, never folded into a rate.
  const matured = recs.filter((r) => (now - r.firstSeen) / 3.6e6 >= MATURE_H);
  const resolved = matured.filter((r) => r.resolved);
  const wonEarly = recs.filter((r) => r.resolved && r.outcome === "winner" && (now - r.firstSeen) / 3.6e6 < MATURE_H).length;
  const byCall = {};
  for (const r of resolved) { const b = byCall[r.call] || (byCall[r.call] = { call: r.call, n: 0, winners: 0 }); b.n++; if (r.outcome === "winner") b.winners++; }
  const buckets = Object.values(byCall).map((b) => ({ ...b, winRate: b.n ? +(b.winners / b.n).toFixed(3) : null }))
    .sort((a, b) => ["promising", "watch", "avoid"].indexOf(a.call) - ["promising", "watch", "avoid"].indexOf(b.call));
  const N = resolved.length, W = resolved.filter((r) => r.outcome === "winner").length;
  const prom = byCall.promising || { n: 0, winners: 0 };
  const base = N ? W / N : null;
  return {
    updated: now,
    ready: N >= MIN_SHOW,                    // enough MATURED calls to show a rate honestly
    minShow: MIN_SHOW,
    predicted: recs.length,                  // young forward calls made
    matured: matured.length,                 // old enough that either outcome was possible — the only basis for a rate
    pending: recs.length - matured.length,   // called, not yet matured (includes early winners still ageing in)
    wonEarly,                                // ran the multiple before maturing — shown, but never counted in a rate
    resolved: N, winners: W,
    baseRate: base == null ? null : +base.toFixed(3),
    promising: { n: prom.n, winners: prom.winners, winRate: prom.n ? +(prom.winners / prom.n).toFixed(3) : null },
    lift: (base && prom.n) ? +((prom.winners / prom.n) / base).toFixed(2) : null,
    buckets,
    horizonH: MATURE_H, predictMaxAgeH: PREDICT_MAX_AGE_H, winMcap: WIN_MCAP, winMult: WIN_MULT,
  };
}

// ── server glue (KV-persisted singleton) ─────────────────────────────────────────────────────────────────────
let _store = null;
async function load() { if (_store) return _store; try { _store = await getJSON("track-record"); } catch { /* no store */ } if (!_store) _store = { tokens: {} }; return _store; }
export async function tick(tokens) { const s = await load(); ingest(s, tokens); resolve(s); setJSON("track-record", s).catch(() => {}); return s; }
export async function trackRecord() { return report(await load()); }
