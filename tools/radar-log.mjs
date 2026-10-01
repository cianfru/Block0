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

const DIR = process.env.RADAR_DIR || join("data", "radar"), LOG = join(DIR, "log.jsonl");
const ONCE = process.argv.includes("--once"), WINDOW_H = ONCE ? 1.5 : 1, POLL_MS = 60000, WEEK = 7 * 86400, MAXMC = 1e6, N_CTL = 4;
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
  const recent = new Map(readLog().filter((r) => r.kind === "event").map((r) => [r.token, r.t]));
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
          const ev = { kind: "event", t, token: r.token, sym: m.sym || null, nHolding: r.nHolding, nSharp: r.nSharp, nSellers: r.nSellers,
            wallets: r.wallets.filter((w) => w.status === "buying" || w.status === "trimmed").map((w) => w.a),
            lastBuyAgoMin: Math.round((at(head) - at(r.lastBlock)) / 60),
            priceUsd: m.priceUsd ?? null, mcapUsd: m.mcapUsd ?? null, liquidityUsd: m.liquidityUsd ?? null, pool: m.url?.split("/").pop() || null, pairCreatedAt: m.pairCreatedAt ?? null };
          appendFileSync(LOG, JSON.stringify(ev) + "\n");
          console.log(new Date().toISOString(), "EVENT", ev.sym || ev.token, `${ev.nHolding} holding (${ev.nSharp} sharp)`, ev.mcapUsd ? "$" + Math.round(ev.mcapUsd) : "no market");
          if (!(ev.mcapUsd > 0) || !ev.pairCreatedAt) continue;
          universe ??= await launches();
          const age = t - ev.pairCreatedAt;
          const pool = universe.filter((u) => !touched.has(u.address) && u.address !== r.token && u.mcapUsd >= ev.mcapUsd * 0.5 && u.mcapUsd <= ev.mcapUsd * 2 && u.age >= age * 0.5 && u.age <= age * 2);
          for (const c of shuffle(pool).slice(0, N_CTL)) {
            const cm = (await marketFor([c.address]))[c.address];
            if (!cm?.priceUsd) continue;
            appendFileSync(LOG, JSON.stringify({ kind: "control", t: now(), forEvent: r.token, token: c.address, sym: cm.sym, priceUsd: cm.priceUsd, mcapUsd: cm.mcapUsd, liquidityUsd: cm.liquidityUsd, pool: cm.url?.split("/").pop() || null, pairCreatedAt: cm.pairCreatedAt ?? null }) + "\n");
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

async function outcomes() {
  const rows = readLog(); let filled = 0;
  for (const r of rows) {
    if (r.peak7 != null || r.outcomeNote || !r.pool || !r.priceUsd || now() < r.t + WEEK + 3600) continue;
    await new Promise((s) => setTimeout(s, 3000));                                   // GeckoTerminal is rate-limited
    try {
      const u = `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${r.pool}/ohlcv/hour?aggregate=1&limit=200&before_timestamp=${r.t + WEEK + 3600}&currency=usd&token=${r.token}`;
      const c = ((await (await fetch(u)).json())?.data?.attributes?.ohlcv_list || []).filter(([s]) => s >= Math.floor(r.t / 3600) * 3600 && s < r.t + WEEK).sort((a, b) => a[0] - b[0]);
      if (!c.length) { r.peak7 = null; r.outcomeNote = "no candles"; continue; }
      r.peak7 = Math.max(...c.map((x) => x[2])) / r.priceUsd; r.close7 = c.at(-1)[4] / r.priceUsd; filled++;
    } catch (e) { console.log("  outcome failed", r.token, e.message); }
  }
  writeFileSync(LOG, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`outcomes filled: ${filled}`);
}

function report() {
  const out = [], say = (l) => out.push(l);
  const rows = readLog(), ctl = rows.filter((r) => r.kind === "control" && r.peak7 != null);
  const ev = rows.filter((r) => r.kind === "event" && r.peak7 != null && r.mcapUsd < MAXMC).sort((a, b) => a.t - b.t);
  const all = rows.filter((r) => r.kind === "event");
  say(`events logged ${all.length} · priced & under $1M ${all.filter((r) => r.priceUsd && r.mcapUsd < MAXMC).length} · scored ${ev.length} · controls scored ${ctl.length}`);
  const age = (r) => r.t - (r.pairCreatedAt || r.t);
  for (const e of ev) {
    const m = ctl.filter((c) => age(c) >= age(e) * 0.5 - 3600 && age(c) <= age(e) * 2 + 3600 && c.mcapUsd >= e.mcapUsd * 0.5 && c.mcapUsd <= e.mcapUsd * 2);
    if (!m.length) continue;
    const pct = (k) => (m.filter((c) => c[k] < e[k]).length + 0.5 * m.filter((c) => c[k] === e[k]).length) / m.length;
    e.pPeak = pct("peak7"); e.pClose = pct("close7");
  }
  const s = ev.filter((e) => e.pPeak != null);
  if (s.length < 30) { say(`no verdict yet: ${s.length} scored events with matched controls (the pre-registered minimum is 30)`); return out.join("\n"); }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ci = (a) => { const b = []; for (let k = 0; k < 2000; k++) b.push(mean(a.map(() => a[Math.floor(Math.random() * a.length)]))); b.sort((x, y) => x - y); return [b[50], b[1949]]; };
  const cut = Math.floor(s.length * 0.7), v = [mean(s.map((e) => e.pClose)) > 0.5];
  for (const [h, set] of [["early", s.slice(0, cut)], ["late", s.slice(cut)]]) {
    const pp = set.map((e) => e.pPeak), [lo, hi] = ci(pp);
    say(`  ${h} n=${set.length} · peak7 percentile ${mean(pp).toFixed(2)} [${lo.toFixed(2)}–${hi.toFixed(2)}]`);
    v.push(mean(pp) >= 0.58 && lo > 0.5);
  }
  say(`  close7 percentile ${mean(s.map((e) => e.pClose)).toFixed(2)} · VERDICT: ${v.every(Boolean) ? "PASS" : "FAIL"}`);
  return out.join("\n");
}
