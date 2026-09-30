#!/usr/bin/env node
// SMART-MONEY CONVERGENCE — event study (2026-09-30). Reads committed study/ only, zero RPC.
//
// The product claim under test: "a young token where a SECOND proven wallet just bought does better than a
// comparable token nobody proven has touched." Not a daily top-1 pick (that is tools/replay-smart.mjs) — every event.
//
// PRE-COMMITTED before any outcome was computed:
//   Smart (loose)  : provenAt(ledger, a, T, minWins 2) — the definition the product ships (≥2 closed, profitable,
//                    non-sniped round trips on OTHER tokens, closed strictly before T).
//   Smart (strict) : ≥3 such wins on distinct tokens AND ≥60 % win rate over ALL its closed non-sniped trips
//                    (≥$200 invested) before T, other tokens only.
//   Buy            : a trader record with firstBuyT inside the token's first 168h, not a block-0 sniper on it.
//   Event          : the first time a token has 2 DISTINCT smart buyers (T = the second one's firstBuyT).
//   Entry          : first series point at or after T (what a user could act on), mcap > 0 and < $1M.
//   Outcomes       : peak7  = max mcap in (entry, entry+7d] / entry ;  close7 = last mcap ≤ entry+7d / entry.
//                    Only events whose profile was observed ≥7d past entry (no censored outcomes).
//   Controls       : every series point of any token, age ≤168h, mcap < $1M, observed ≥7d after, with ZERO
//                    smart buyers by then. Matched per event on age (×0.5–2) and mcap (×0.5–2).
//   Statistic      : each event's percentile inside its matched-control distribution (0.5 under no effect).
//   Pass rule      : mean peak7 percentile ≥ 0.58 with bootstrap 95 % CI lower bound > 0.5, in BOTH the earlier
//                    70 % and the later 30 % of events; and the close7 mean percentile > 0.5 overall.
//   Wallets        : contracts (study/wallet-kinds.json) are excluded from both definitions — added after the first
//                    run exposed routers/bots in the ledger; a data fix, the rules above are unchanged.
//   Caveat         : the cohort is ~all graduated Pons tokens, so both arms are conditioned on graduating.
//
//   node tools/replay-convergence.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { provenLedger, provenAt } from "../smart-money.mjs";
import { STUDY_DIR, contractSet } from "./cohort-lib.mjs";

const H = 3600, D = 86400, MAXAGE = 168 * H, MAXMC = 1e6, FWD = 7 * D;
const meta = new Map(JSON.parse(readFileSync(join(STUDY_DIR, "cohort.json"), "utf8")).tokens.map((t) => [t.addr, t]));
const profs = readdirSync(join(STUDY_DIR, "profiles")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(STUDY_DIR, "profiles", f), "utf8")))
  .filter((p) => p.series?.length && p.traders?.length && meta.has(p.addr));

// ── definitions ──────────────────────────────────────────────────────────────────────────────────────────────
const CONTRACTS = contractSet();      // routers/aggregators/bots are never smart money (tools/scan-wallet-kinds.mjs)
const loose = provenLedger(profs, { exclude: CONTRACTS });
const trips = new Map();              // wallet → [{t, token, win}] every closed non-sniped trip, sorted by close time
for (const p of profs) for (const w of p.traders) {
  if (w.sniper || w.exitT == null || !(w.invested >= 200) || CONTRACTS.has(w.a)) continue;
  (trips.get(w.a) || trips.set(w.a, []).get(w.a)).push({ t: w.exitT, token: p.addr, win: w.realized >= 100 });
}
for (const l of trips.values()) l.sort((a, b) => a.t - b.t);
const strictAt = (a, T, exclude) => {
  const l = trips.get(a); if (!l) return false;
  let n = 0, wins = 0; const won = new Set();
  for (const x of l) { if (x.t >= T) break; if (x.token === exclude) continue; n++; if (x.win) { wins++; won.add(x.token); } }
  return won.size >= 3 && wins / n >= 0.6;
};
const DEFS = {
  loose: (a, T, tok) => provenAt(loose, a, T, { exclude: tok, minWins: 2 }),
  strict: (a, T, tok) => strictAt(a, T, tok),
};

// ── per-definition study ─────────────────────────────────────────────────────────────────────────────────────
function study(isSmart) {
  const events = [], pool = [];
  for (const p of profs) {
    const smartTimes = [...new Map(p.traders
      .filter((w) => !w.sniper && w.firstBuyT != null && w.firstBuyT - p.t0 <= MAXAGE && isSmart(w.a, w.firstBuyT, p.addr))
      .map((w) => [w.a, w.firstBuyT])).values()].sort((a, b) => a - b);
    const nSmartBy = (t) => { let n = 0; for (const x of smartTimes) if (x <= t) n++; return n; };
    const outcome = (i) => {
      const e = p.series[i], end = e.t + FWD;
      if (!(e.mcap > 0) || p.t1 < end) return null;
      let peak = 0, close = null;
      for (let j = i + 1; j < p.series.length && p.series[j].t <= end; j++) { const m = p.series[j].mcap || 0; if (m > peak) peak = m; if (m > 0) close = m; }
      if (close == null) return null;
      return { peak7: peak / e.mcap, close7: close / e.mcap };
    };
    p.series.forEach((pt, i) => {
      const age = pt.t - p.t0;
      if (age < 0 || age > MAXAGE || !(pt.mcap > 0) || pt.mcap >= MAXMC || nSmartBy(pt.t) > 0) return;
      const o = outcome(i); if (o) pool.push({ age, mcap: pt.mcap, ...o });
    });
    if (smartTimes.length >= 2) {
      const T = smartTimes[1], i = p.series.findIndex((pt) => pt.t >= T);
      if (i < 0) continue;
      const pt = p.series[i], age = pt.t - p.t0;
      if (age > MAXAGE || !(pt.mcap > 0) || pt.mcap >= MAXMC) continue;
      const o = outcome(i); if (o) events.push({ T, sym: p.sym, age, mcap: pt.mcap, ...o });
    }
  }
  events.sort((a, b) => a.T - b.T);
  for (const e of events) {
    const m = pool.filter((c) => c.age >= e.age * 0.5 - H && c.age <= e.age * 2 + H && c.mcap >= e.mcap * 0.5 && c.mcap <= e.mcap * 2);
    e.nCtl = m.length;
    if (!m.length) continue;
    const pct = (k) => (m.filter((c) => c[k] < e[k]).length + 0.5 * m.filter((c) => c[k] === e[k]).length) / m.length;
    e.pPeak = pct("peak7"); e.pClose = pct("close7");
    e.ctlPeak = med(m.map((c) => c.peak7)); e.ctlClose = med(m.map((c) => c.close7));
    e.ctlUp2 = m.filter((c) => c.peak7 >= 2).length / m.length;
  }
  return { events: events.filter((e) => e.nCtl >= 20), dropped: events.filter((e) => e.nCtl < 20).length, pool: pool.length };
}

function med(a) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
let seed = 99; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
function ci(a) {
  const b = [];
  for (let k = 0; k < 2000; k++) b.push(mean(a.map(() => a[Math.floor(rnd() * a.length)])));
  b.sort((x, y) => x - y); return [b[50], b[1949]];
}
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const $ = (x) => (x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : "$" + Math.round(x / 1e3) + "k");

for (const [name, fn] of Object.entries(DEFS)) {
  const { events: ev, dropped, pool } = study(fn);
  console.log(`\n══ ${name.toUpperCase()} smart · ${ev.length} convergence events (${dropped} dropped: <20 matched controls) · control pool ${pool} points`);
  if (ev.length < 10) { console.log("  too few events to judge"); continue; }
  const cut = Math.floor(ev.length * 0.7), verdict = [];
  for (const [h, set] of [["all", ev], ["early", ev.slice(0, cut)], ["late", ev.slice(cut)]]) {
    const pp = set.map((e) => e.pPeak), pc = set.map((e) => e.pClose), [lo, hi] = ci(pp);
    console.log(`  ${h.padEnd(5)} n=${String(set.length).padStart(3)} · peak7 pct ${f2(mean(pp))} [${f2(lo)}–${f2(hi)}] · close7 pct ${f2(mean(pc))}`
      + ` · median peak7 ${f2(med(set.map((e) => e.peak7)))}× vs ctl ${f2(med(set.map((e) => e.ctlPeak)))}×`
      + ` · median close7 ${f2(med(set.map((e) => e.close7)))}× vs ctl ${f2(med(set.map((e) => e.ctlClose)))}×`
      + ` · ≥2× ${(100 * set.filter((e) => e.peak7 >= 2).length / set.length).toFixed(0)}% vs ctl ${(100 * mean(set.map((e) => e.ctlUp2))).toFixed(0)}%`);
    if (h !== "all") verdict.push(mean(pp) >= 0.58 && lo > 0.5);
    if (h === "all") verdict.push(mean(pc) > 0.5);
  }
  console.log(`  median entry ${$(med(ev.map((e) => e.mcap)))} · median age at event ${f2(med(ev.map((e) => e.age / H)))}h · span ${new Date(ev[0].T * 1000).toISOString().slice(0, 10)} → ${new Date(ev.at(-1).T * 1000).toISOString().slice(0, 10)}`);
  console.log(`  VERDICT: ${verdict.every(Boolean) ? "PASS" : "FAIL"}  (close7>0.5: ${verdict[0]} · early: ${verdict[1]} · late: ${verdict[2]})`);
}
