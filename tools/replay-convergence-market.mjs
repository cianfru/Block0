#!/usr/bin/env node
// SMART-MONEY CONVERGENCE on MARKET PRICES — the uncensored rerun of tools/replay-convergence.mjs (2026-09-30).
//
// v1 could not answer: profiles stop a median 6.6 days after launch, so only 13 of ~500 events had a 7-day forward
// window, and its prices were our swap-implied reconstruction. This version prices entry AND outcome from
// GeckoTerminal hourly candles (tools/fetch-candles.mjs, launch → +16 days). Smart-buyer timing still comes from the
// profiles' trader records. Zero RPC, zero cost.
//
// PRE-COMMITTED (written before any candle outcome was read; definitions and pass rule unchanged from v1):
//   Smart (loose)  : provenAt(ledger, a, T, minWins 2), contracts excluded (study/wallet-kinds.json).
//   Smart (strict) : ≥3 clean wins on distinct tokens AND ≥60 % win rate over closed non-sniped trips, before T.
//   Known window   : [launch, min(launch+168h, profile t1)] — trader records are complete only up to t1, so neither
//                    events nor controls are taken after it (a control there could hide an unseen smart buyer).
//   PRIMARY event  : the 2nd distinct smart buyer (T = its firstBuyT) inside the known window.
//   SECONDARY      : the 1st smart buyer, same machinery (reported, judged by the same rule, separately).
//   Entry          : E = the first hour boundary after T (a user sees the buy, then acts). Price at an hour = close
//                    of the last candle that ended by then (forward-filled: no trades ⇒ price unchanged).
//                    Entry mcap = price × supply, must be < $1M.
//   Outcomes       : peak7 = max candle high in [E, E+168h) / entry price ; close7 = price at E+168h / entry price.
//   Controls       : every hour boundary in any token's known window with ZERO smart buyers by then, mcap < $1M,
//                    a defined price. Matched per event on age (×0.5–2, ±1h) and mcap (×0.5–2); ≥20 required.
//   Statistic      : each event's percentile inside its matched controls (0.5 = no effect).
//   Pass rule      : mean peak7 percentile ≥ 0.58 with bootstrap 95 % CI lower bound > 0.5 in BOTH the earlier 70 %
//                    and the later 30 % of events, AND close7 mean percentile > 0.5 overall.
//   Caveat         : ~all profiled tokens graduated on Pons, so both arms are conditioned on graduating.
//
//   node tools/fetch-candles.mjs && node tools/replay-convergence-market.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { provenLedger, provenAt } from "../smart-money.mjs";
import { loadProfiles, contractSet } from "./cohort-lib.mjs";

const H = 3600, WEEK = 168 * H, MAXMC = 1e6, MIN_CTL = 20;
const CONTRACTS = contractSet();
const profs = loadProfiles().filter((p) => p.traders?.length && existsSync(join("data", "candles", p.addr + ".json")));
const candles = new Map(profs.map((p) => [p.addr, JSON.parse(readFileSync(join("data", "candles", p.addr + ".json"), "utf8"))]));

const loose = provenLedger(profs, { exclude: CONTRACTS });
const trips = new Map();
for (const p of profs) for (const w of p.traders) {
  if (w.sniper || w.exitT == null || !(w.invested >= 200) || CONTRACTS.has(w.a)) continue;
  (trips.get(w.a) || trips.set(w.a, []).get(w.a)).push({ t: w.exitT, token: p.addr, win: w.realized >= 100 });
}
for (const l of trips.values()) l.sort((a, b) => a.t - b.t);
const DEFS = {
  loose: (a, T, tok) => provenAt(loose, a, T, { exclude: tok, minWins: 2 }),
  strict: (a, T, tok) => {
    const l = trips.get(a); if (!l) return false;
    let n = 0, wins = 0; const won = new Set();
    for (const x of l) { if (x.t >= T) break; if (x.token === tok) continue; n++; if (x.win) { wins++; won.add(x.token); } }
    return won.size >= 3 && wins / n >= 0.6;
  },
};

// price at an hour boundary = close of the last candle that ENDED by then; peak = max high of candles starting in [a, b)
function market(addr) {
  const { c = [], supply = 1e9 } = candles.get(addr) || {};
  const priceAt = (t) => { let px = null; for (const [s, , , cl] of c) { if (s + H > t) break; px = cl; } return px; };
  const peakIn = (a, b) => { let m = 0; for (const [s, , hi] of c) { if (s >= b) break; if (s >= a && hi > m) m = hi; } return m; };
  const at = (E) => {
    const px = priceAt(E); if (!(px > 0)) return null;
    const pk = Math.max(peakIn(E, E + WEEK), px), cl = priceAt(E + WEEK) ?? px;
    return { mcap: px * supply, peak7: pk / px, close7: cl / px };
  };
  return { at, n: c.length };
}

function study(isSmart, nth) {
  const events = [], pool = [];
  for (const p of profs) {
    const mk = market(p.addr); if (!mk.n) continue;
    const end = Math.min(p.t0 + WEEK, p.t1);
    const smart = [...new Map(p.traders
      .filter((w) => !w.sniper && !CONTRACTS.has(w.a) && w.firstBuyT != null && w.firstBuyT <= end && isSmart(w.a, w.firstBuyT, p.addr))
      .map((w) => [w.a, w.firstBuyT])).values()].sort((a, b) => a - b);
    const first = smart[0] ?? Infinity;
    for (let E = Math.ceil(p.t0 / H) * H + H; E <= end; E += H) {
      if (E >= first) break;                                     // zero smart buyers by E
      const o = mk.at(E); if (o && o.mcap < MAXMC) pool.push({ age: E - p.t0, ...o });
    }
    if (smart.length >= nth) {
      const T = smart[nth - 1], E = Math.ceil((T + 1) / H) * H, o = mk.at(E);
      if (o && o.mcap < MAXMC) events.push({ T, sym: p.sym, age: E - p.t0, ...o });
    }
  }
  events.sort((a, b) => a.T - b.T);
  for (const e of events) {
    const m = pool.filter((c) => c.age >= e.age * 0.5 - H && c.age <= e.age * 2 + H && c.mcap >= e.mcap * 0.5 && c.mcap <= e.mcap * 2);
    e.nCtl = m.length; if (m.length < MIN_CTL) continue;
    const pct = (k) => (m.filter((c) => c[k] < e[k]).length + 0.5 * m.filter((c) => c[k] === e[k]).length) / m.length;
    e.pPeak = pct("peak7"); e.pClose = pct("close7");
    e.ctlPeak = med(m.map((c) => c.peak7)); e.ctlClose = med(m.map((c) => c.close7)); e.ctlUp2 = m.filter((c) => c.peak7 >= 2).length / m.length;
  }
  return { events: events.filter((e) => e.nCtl >= MIN_CTL), dropped: events.filter((e) => e.nCtl < MIN_CTL).length, pool: pool.length };
}

function med(a) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
let seed = 99; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const ci = (a) => { const b = []; for (let k = 0; k < 2000; k++) b.push(mean(a.map(() => a[Math.floor(rnd() * a.length)]))); b.sort((x, y) => x - y); return [b[50], b[1949]]; };
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const $ = (x) => (x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : "$" + Math.round(x / 1e3) + "k");

console.log(`${profs.length} tokens with candles + trader records · ${CONTRACTS.size} contracts excluded`);
for (const [nth, label] of [[2, "PRIMARY · 2nd smart buyer"], [1, "SECONDARY · 1st smart buyer"]]) for (const [name, fn] of Object.entries(DEFS)) {
  const { events: ev, dropped, pool } = study(fn, nth);
  console.log(`\n══ ${label} · ${name} · ${ev.length} events (${dropped} dropped: <${MIN_CTL} matched controls) · control pool ${pool} hours`);
  if (ev.length < 10) { console.log("  too few events to judge"); continue; }
  const cut = Math.floor(ev.length * 0.7), v = [];
  for (const [h, set] of [["all", ev], ["early", ev.slice(0, cut)], ["late", ev.slice(cut)]]) {
    const pp = set.map((e) => e.pPeak), pc = set.map((e) => e.pClose), [lo, hi] = ci(pp);
    console.log(`  ${h.padEnd(5)} n=${String(set.length).padStart(3)} · peak7 pct ${f2(mean(pp))} [${f2(lo)}–${f2(hi)}] · close7 pct ${f2(mean(pc))}`
      + ` · med peak7 ${f2(med(set.map((e) => e.peak7)))}× vs ctl ${f2(med(set.map((e) => e.ctlPeak)))}×`
      + ` · med close7 ${f2(med(set.map((e) => e.close7)))}× vs ctl ${f2(med(set.map((e) => e.ctlClose)))}×`
      + ` · ≥2× ${(100 * set.filter((e) => e.peak7 >= 2).length / set.length).toFixed(0)}% vs ctl ${(100 * mean(set.map((e) => e.ctlUp2))).toFixed(0)}%`);
    if (h === "all") v.push(mean(pc) > 0.5); else v.push(mean(pp) >= 0.58 && lo > 0.5);
  }
  console.log(`  median entry ${$(med(ev.map((e) => e.mcap)))} · median age ${f2(med(ev.map((e) => e.age / H)))}h`);
  console.log(`  VERDICT: ${v.every(Boolean) ? "PASS" : "FAIL"}  (close7>0.5: ${v[0]} · early: ${v[1]} · late: ${v[2]})`);
}
