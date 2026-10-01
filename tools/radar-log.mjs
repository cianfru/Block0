#!/usr/bin/env node
// FORWARD TEST of the smart-money radar — the only honest way left to answer "does convergence mean anything?".
//
// History could not answer it (tools/replay-convergence*.mjs, CLAUDE.md 2026-09-30): outcomes were censored and
// early-hour prices disagree by up to ~20× between sources. Forward, both problems vanish: every event is logged the
// moment the radar sees it, priced by the market at that moment, next to matched launches nobody smart touched,
// and scored 7 days later from market candles. Nothing is selected afterwards, so there is no survivorship.
//
// PRE-REGISTERED (2026-09-30, before the first event was logged):
//   Event    : a token's radar row turns "converging" (≥2 proven wallets bought, verified self-sent, and still hold)
//              inside the rolling window (1h live, 90 min in --once mode). One event per token per 7 days.
//              Entry = DexScreener price at detection. In the scheduled mode detection lags the second buy by up to
//              ~30–50 min (cron cadence + GitHub's scheduling delay); `lastBuyAgoMin` records the lag. The claim tested
//              is therefore "a convergence seen within the hour", which is what a user of a periodic digest gets.
//   (Amended 2026-09-30, before any real event was logged: added --once mode, the lag field, and a GeckoTerminal
//    new-pools fallback for the control universe when Pons is unreachable from the runner.)
//   (Amended 2026-10-01, 41 events logged, none scored: GitHub ran the 30-min --once schedule only every ~4–6 h, so
//    most convergences were never seen. The Action now runs the live 60-s watch mode (1 h window) for ~5h40m and
//    restarts itself. Event definition, controls, outcomes and verdict are unchanged; lastBuyAgoMin still records
//    the detection lag, which now drops from up to ~50 min to ~1 min.)
//              Eligible for scoring only with a price and mcap < $1M (the early-stage claim).
//   Controls : at the same moment, up to 4 Pons launches with mcap ×0.5–2 of the event's and launch age ×0.5–2 of
//              its pool age, no smart-wallet activity in the window, priced the same way.
//   Outcomes : after 7 days, GeckoTerminal hourly candles: peak7 = max high / entry, close7 = last close / entry.
//   Verdict  : same statistic and bar as the replays — each event's percentile among controls matched on age and
//              mcap (×0.5–2); mean peak7 percentile ≥ 0.58 with bootstrap 95% CI lower bound > 0.5 in both the earlier
//              70% and later 30% of events, and close7 mean percentile > 0.5. No verdict below 30 scored events.
//
//
//   ⚠ SUPERSEDED BY PROTOCOL v3 (2026-10-01) — tools/radar-protocol.mjs holds the rules now in force (event ids, own
//   controls only, a post-entry outcome window, covered endpoints, transient failures retried). The text above is
//   kept as the record of what v1 promised; v1/v2 rows stay in the log and are not scored.
//
//   node tools/radar-log.mjs              poll every 60 s, append to data/radar/log.jsonl (run it anywhere; free)
//        [--minutes=N]                    stop after N minutes; with RADAR_GIT_COMMIT=1, rewrite REPORT.txt and commit +
//                                         push RADAR_DIR every 15 min — what .github/workflows/radar-log.yml runs
//   node tools/radar-log.mjs --once       one pass over the last 90 min, then exit
//   node tools/radar-log.mjs --outcomes   fill 7-day outcomes for matured rows from market candles
//   node tools/radar-log.mjs --report     the pre-registered verdict over scored events
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { loadWallets, makeFeed, marketFor } from "../radar-feed.mjs";
import { fetchActive, fetchGraduated } from "../pons.mjs";
import { PROTOCOL, eventId, outcomeFromCandles, report as reportOf, EMPTY_RUNS } from "./radar-protocol.mjs";

const DIR = process.env.RADAR_DIR || join("data", "radar"), LOG = join(DIR, "log.jsonl");
const ONCE = process.argv.includes("--once"), WINDOW_H = ONCE ? 1.5 : 1, POLL_MS = 60000, WEEK = 7 * 86400, N_CTL = 4;
const arg = new Set(process.argv.slice(2));
const MINUTES = Number(process.argv.find((a) => a.startsWith("--minutes="))?.split("=")[1] || 0);
const COMMIT = process.env.RADAR_GIT_COMMIT === "1", COMMIT_MS = 15 * 60e3;
mkdirSync(DIR, { recursive: true });
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const now = () => Math.floor(Date.now() / 1000);

if (arg.has("--outcomes")) await outcomes();
else if (arg.has("--report")) console.log(report());
// (--once falls through to watch(), which returns after one pass)
else await watch();

async function watch() {
  const W = loadWallets(), feed = makeFeed(W);
  // one event per token per 7 days within the current protocol; legacy events do not block the new cohort
  const recent = new Map(readLog().filter((r) => r.kind === "event" && r.v === PROTOCOL).map((r) => [r.token, r.t]));
  console.log(`radar-log · ${W.wallets.length} wallets · ${LOG} · ${recent.size} events so far`);
  const stopAt = MINUTES ? Date.now() + MINUTES * 60e3 : Infinity;
  let committedAt = Date.now();
  for (;;) {
    try {
      const { rows, head, at } = await feed.tick(WINDOW_H);
      const touched = new Set(rows.map((r) => r.token));
      const fresh = rows.filter((r) => r.signal === "converging" && !(now() - (recent.get(r.token) || 0) < WEEK));
      if (fresh.length) {
        const mk = await marketFor(fresh.map((r) => r.token));
        let universe = null;
        for (const r of fresh) {
          const m = mk[r.token] || {}, t = now();
          recent.set(r.token, t);
          const ev = { kind: "event", v: PROTOCOL, id: eventId(r.token, t), t, token: r.token, sym: m.sym || null, nHolding: r.nHolding, nSharp: r.nSharp, nSellers: r.nSellers,
            wallets: r.wallets.filter((w) => w.status === "buying").map((w) => w.a),
            lastBuyAgoMin: Math.round((at(head) - at(r.lastBuyBlock ?? r.lastBlock)) / 60),
            priceUsd: m.priceUsd ?? null, mcapUsd: m.mcapUsd ?? null, liquidityUsd: m.liquidityUsd ?? null, pool: m.url?.split("/").pop() || null, pairCreatedAt: m.pairCreatedAt ?? null };
          appendFileSync(LOG, JSON.stringify(ev) + "\n");
          console.log(new Date().toISOString(), "EVENT", ev.sym || ev.token, `${ev.nHolding} buyers without outflow (${ev.nSharp} sharp)`, ev.mcapUsd ? "$" + Math.round(ev.mcapUsd) : "no market");
          if (!(ev.mcapUsd > 0) || !ev.pairCreatedAt) continue;
          universe ??= await launches();
          const age = t - ev.pairCreatedAt;
          const pool = universe.filter((u) => !touched.has(u.address) && u.address !== r.token && u.mcapUsd >= ev.mcapUsd * 0.5 && u.mcapUsd <= ev.mcapUsd * 2 && u.age >= age * 0.5 && u.age <= age * 2);
          for (const c of shuffle(pool).slice(0, N_CTL)) {
            const cm = (await marketFor([c.address]))[c.address];
            if (!cm?.priceUsd) continue;
            appendFileSync(LOG, JSON.stringify({ kind: "control", v: PROTOCOL, forId: ev.id, t: now(), forEvent: r.token, token: c.address, sym: cm.sym, priceUsd: cm.priceUsd, mcapUsd: cm.mcapUsd, liquidityUsd: cm.liquidityUsd, pool: cm.url?.split("/").pop() || null, pairCreatedAt: cm.pairCreatedAt ?? null }) + "\n");
          }
        }
      }
    } catch (e) { console.log(new Date().toISOString(), "poll failed:", e.message); if (ONCE) process.exitCode = 1; }
    if (ONCE) return;
    const last = Date.now() + POLL_MS > stopAt;
    if (COMMIT && (last || Date.now() - committedAt >= COMMIT_MS)) { commit(); committedAt = Date.now(); }
    if (last) return;
    await new Promise((s) => setTimeout(s, POLL_MS));
  }
}

function commit() {
  try {
    writeFileSync(join(DIR, "REPORT.txt"), report() + "\n");
    execSync(`git -C "${DIR}" add -A && (git -C "${DIR}" diff --cached --quiet || (git -C "${DIR}" -c user.name=radar-log -c user.email=radar-log@users.noreply.github.com commit -q -m "radar log ${new Date().toISOString().slice(0, 16)}Z" && git -C "${DIR}" push -q origin radar-data))`, { stdio: "inherit", shell: "/bin/bash" });
  } catch (e) { console.log("  ! commit failed:", e.message); }
}

async function launches() {
  const t = Date.now() / 1000, out = [];
  try {
    const [g, a] = await Promise.all([fetchGraduated(), fetchActive({ pageSize: 100, sort: "newest" })]);
    for (const x of [...a.items, ...g.items]) if (x.mcapUsd > 0 && x.launchedAt) out.push({ address: x.address, mcapUsd: x.mcapUsd, age: t - Date.parse(x.launchedAt) / 1000 });
  } catch (e) { console.log("  pons unreachable — falling back to GeckoTerminal new pools:", e.message); }
  if (!out.length) {
    for (let page = 1; page <= 5; page++) {
      try {
        const d = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/new_pools?page=${page}`)).json();
        for (const p of d?.data || []) {
          const a = p.attributes, token = p.relationships?.base_token?.data?.id?.replace(/^robinhood_/, "");
          const mc = Number(a.market_cap_usd || a.fdv_usd || 0);
          if (token && mc > 0 && a.pool_created_at) out.push({ address: token.toLowerCase(), mcapUsd: mc, age: t - Date.parse(a.pool_created_at) / 1000 });
        }
      } catch { break; }
      await new Promise((s) => setTimeout(s, 2500));
    }
  }
  return out;
}
function shuffle(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

// Fill 7-day outcomes for matured current-protocol rows (tools/radar-protocol.mjs decides what counts). A failed request is retried
// on a later run and never recorded as "no candles" (audit F07); an empty answer becomes final on the 3rd run.
async function outcomes() {
  const rows = readLog(); let filled = 0, transient = 0;
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
  const candles = async (r) => {
    const u = `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${r.pool}/ohlcv/hour?aggregate=1&limit=200&before_timestamp=${r.t + WEEK + 3600}&currency=usd&token=${r.token}`;
    for (let i = 0; i < 3; i++) {
      await sleep(3000 * (i + 1));                                                   // GeckoTerminal is rate-limited
      try {
        const res = await fetch(u);
        if (!res.ok) continue;                                                       // 429 / 5xx: transient
        const list = (await res.json())?.data?.attributes?.ohlcv_list;
        if (Array.isArray(list)) return list;
      } catch { /* network: transient */ }
    }
    return null;
  };
  for (const r of rows) {
    if (r.v !== PROTOCOL || r.peak7 != null || r.outcomeNote || !r.pool || !r.priceUsd || now() < r.t + WEEK + 3600) continue;
    const list = await candles(r);
    if (list == null) { transient++; continue; }
    const o = outcomeFromCandles(r.t, r.priceUsd, list);
    r.postCandles = o.postCandles; r.endCovered = o.endCovered;
    if (o.peak7 != null) { r.peak7 = o.peak7; r.close7 = o.close7; filled++; }
    else if ((r.emptyRuns = (r.emptyRuns || 0) + 1) >= EMPTY_RUNS) r.outcomeNote = o.note;
  }
  writeFileSync(LOG, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`outcomes filled: ${filled} · transient failures (retried next run): ${transient}`);
}

function report() { return reportOf(readLog()).lines.join("\n"); }
