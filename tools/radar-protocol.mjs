// The forward test's scoring — PURE, so the verdict rule is pinned by tests (test/radar-protocol.test.mjs).
// tools/radar-log.mjs does the I/O; this file decides what counts.
//
// PROTOCOL v2 (2026-10-01, written before the first v2 event; prompted by the 2026-10-01 code audit, F03–F07):
//   • Detector: the radar core as fixed for F03/F04 — a buy needs payment evidence, transfers out and deposits count
//     against "still hasn't sold or moved it". v1 rows (logged by the earlier detector) stay in the log, untouched,
//     and are counted but never scored: they measured a different, flawed definition.
//   • Every event has an id (`token:t`); every control carries the id of the ONE event it was drawn for. An event is
//     compared only with its own controls — never with controls drawn for other events or on other days (F05).
//   • Outcome window starts at the first full hour AFTER detection (the bar containing detection may hold a pre-entry
//     high) and ends 7 days after detection (F06).
//       peak7  = max high over that window / entry price — needs ≥1 post-entry candle, else "no post-entry trades".
//       close7 = the last close at or before the horizon / entry — needs a candle in the horizon's final 24 h; without
//                one the end is NOT covered and close7 stays null (counted, reported, never filled with an older close).
//   • A failed candle request (HTTP error, 429, malformed body) is a TRANSIENT failure: retried on a later run, never
//     recorded as "no candles" (F07). An empty answer from a successful request becomes permanent only on the 3rd
//     separate run, so an indexing lag cannot drop an outcome.
//   • Verdict (unchanged statistic and bar): each scored event's peak7 percentile among ITS OWN scored controls; mean
//     ≥ 0.58 with bootstrap 95% CI lower bound > 0.5 in both the earlier 70% and later 30% of events, and the mean
//     close7 percentile > 0.5 over events whose end is covered. No verdict below 30 scored v2 events.
export const PROTOCOL = 2, WEEK = 7 * 86400, MAXMC = 1e6, EMPTY_RUNS = 3;

export const eventId = (token, t) => `${token}:${t}`;

// candles: GeckoTerminal ohlcv_list rows [start, open, high, low, close, volume], any order
// → { peak7, close7, postCandles, endCovered, note }
export function outcomeFromCandles(entryT, entryPrice, candles, { week = WEEK } = {}) {
  const start = Math.ceil(entryT / 3600) * 3600, horizon = entryT + week;
  const c = (candles || []).filter((x) => x[0] >= start && x[0] < horizon).sort((a, b) => a[0] - b[0]);
  if (!c.length) return { peak7: null, close7: null, postCandles: 0, endCovered: false, note: "no post-entry trades" };
  const endCovered = c.at(-1)[0] >= horizon - 86400;
  return { peak7: Math.max(...c.map((x) => x[2])) / entryPrice, close7: endCovered ? c.at(-1)[4] / entryPrice : null,
    postCandles: c.length, endCovered, note: endCovered ? null : "end of horizon not covered" };
}

// rows → { lines, verdict } — the report, v2 rows only
export function report(rows, { seed = 1 } = {}) {
  const lines = [], say = (l) => lines.push(l);
  const v1 = rows.filter((r) => r.kind === "event" && r.v !== PROTOCOL);
  const ev = rows.filter((r) => r.kind === "event" && r.v === PROTOCOL);
  const ctl = rows.filter((r) => r.kind === "control" && r.v === PROTOCOL);
  const eligible = ev.filter((r) => r.priceUsd && r.mcapUsd < MAXMC);
  const scored = eligible.filter((r) => r.peak7 != null).sort((a, b) => a.t - b.t);
  say(`protocol v${PROTOCOL} · events logged ${ev.length} · priced & under $1M ${eligible.length} · peak scored ${scored.length}`
    + ` · end covered ${scored.filter((r) => r.close7 != null).length}`);
  const byEvent = new Map();
  for (const c of ctl) (byEvent.get(c.forId) || byEvent.set(c.forId, []).get(c.forId)).push(c);
  const pct = (e, cs, k) => (cs.filter((c) => c[k] < e[k]).length + 0.5 * cs.filter((c) => c[k] === e[k]).length) / cs.length;
  let noCtl = 0, ctlPending = 0;
  for (const e of scored) {
    const own = byEvent.get(e.id) || [];
    const peakCtl = own.filter((c) => c.peak7 != null);
    if (!own.length) noCtl++; else if (!peakCtl.length) ctlPending++;
    if (peakCtl.length) e.pPeak = pct(e, peakCtl, "peak7");
    const closeCtl = own.filter((c) => c.close7 != null);
    if (e.close7 != null && closeCtl.length) e.pClose = pct(e, closeCtl, "close7");
  }
  const s = scored.filter((e) => e.pPeak != null);
  say(`controls: ${ctl.length} logged · ${ctl.filter((c) => c.peak7 != null).length} scored · events with no control ${noCtl} · events whose controls are not scored yet ${ctlPending}`);
  if (v1.length) say(`(${v1.length} events logged by the v1 detector are kept in the log and not scored — see tools/radar-protocol.mjs)`);
  if (s.length < 30) { say(`no verdict yet: ${s.length} scored events with scored controls of their own (the pre-registered minimum is 30)`); return { lines, verdict: null }; }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  let st = seed >>> 0; const rand = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };   // seeded: the same log always gives the same report
  const ci = (a) => { const b = []; for (let k = 0; k < 2000; k++) b.push(mean(a.map(() => a[Math.floor(rand() * a.length)]))); b.sort((x, y) => x - y); return [b[50], b[1949]]; };
  const cut = Math.floor(s.length * 0.7), closes = s.filter((e) => e.pClose != null).map((e) => e.pClose);
  const pass = [closes.length > 0 && mean(closes) > 0.5];
  for (const [h, set] of [["early", s.slice(0, cut)], ["late", s.slice(cut)]]) {
    const pp = set.map((e) => e.pPeak), [lo, hi] = ci(pp);
    say(`  ${h} n=${set.length} · peak7 percentile ${mean(pp).toFixed(2)} [${lo.toFixed(2)}–${hi.toFixed(2)}]`);
    pass.push(mean(pp) >= 0.58 && lo > 0.5);
  }
  const verdict = pass.every(Boolean) ? "PASS" : "FAIL";
  say(`  close7 percentile ${closes.length ? mean(closes).toFixed(2) : "n/a"} (n=${closes.length}) · VERDICT: ${verdict}`);
  return { lines, verdict };
}
