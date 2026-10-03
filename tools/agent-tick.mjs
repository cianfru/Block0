#!/usr/bin/env node
// Block0 agent — one cycle then exit, or `--watch`: loop every AGENT_INTERVAL_MIN (15) for AGENT_WATCH_MIN (345)
// minutes in ONE process, so the in-memory transfer store stays warm and every read after the first is a delta pull
// (a cold read is ~20 s per token on the free node; .github/workflows/agent.yml starts a watch job every 6 h).
// With AGENT_GIT_COMMIT=1 each cycle commits AGENT_DIR (a checkout of the `agent-data` branch) and pushes it.
// Wiring only: the logic is agent/tick.mjs. State + ledgers live in AGENT_DIR (the `agent-data` branch in CI):
//   state.json      detector + budget state           dry-run.jsonl   what WOULD have been posted
//   posted.jsonl    what was posted (public record)   events.jsonl    every detected event + its fate
//   board.json      the static site's live board      tokens/<a>.json the static site's per-token dossier
//   alerts.json     the board's alert strip (every detected event, posted or not)
//   timelines/<a>.json  each launch's timeline: every event with its evidence (agent/timeline.mjs), kept 30 days
// The branch is rewritten as ONE commit each cycle (force-push, no history): the dossiers churn every 15 min and would
// otherwise grow the repo by megabytes a day. The ledgers are append-only files, so nothing they record is lost.
//
// Env: AGENT_DRY_RUN (default "1" — only "0" publishes) · ORBIO_API_KEY · AGENT_X_HANDLE (optional: the connected
//      account from social.accounts is used when unset) ·
//      AGENT_MAX_CREDIT_PER_DAY (default 1.5) · AGENT_MAX_ORIGINALS_PER_DAY (default 15) · AGENT_DIR (default data/agent)
//      AGENT_FORWARD_REPORT (path to the radar REPORT.txt, for the "n=" in unvalidated footers)
// Never set RPC_URL / ALCHEMY_* for this job: token reads run on the free native node.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runTick, emptyState } from "../agent/tick.mjs";
import { makeOrbio } from "../agent/orbio.mjs";
import { fetchActive, fetchGraduated } from "../pons.mjs";
import { computeIntel } from "../intel.mjs";
import { mergeReads, boardSnapshot, dossierOf, alertsFeed } from "../agent/board-snapshot.mjs";
import { entryOf, stateEntries, appendTimeline, backfillEntries, expired } from "../agent/timeline.mjs";

const env = process.env;
const DIR = env.AGENT_DIR || join("data", "agent");
mkdirSync(join(DIR, "tokens"), { recursive: true });
const SEED_TIMELINES = !existsSync(join(DIR, "timelines"));
mkdirSync(join(DIR, "timelines"), { recursive: true });
const read = (f, d) => { try { return JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch { return d; } };
const append = (f, rows) => { if (rows.length) appendFileSync(join(DIR, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); };

let forwardN = null;
try { const m = readFileSync(env.AGENT_FORWARD_REPORT || "", "utf8").match(/scored (\d+)/); if (m) forwardN = Number(m[1]); } catch { /* optional */ }

const dryRun = env.AGENT_DRY_RUN !== "0";
const WATCH = process.argv.includes("--watch");
const until = Date.now() + Number(env.AGENT_WATCH_MIN || 345) * 60e3, every = Number(env.AGENT_INTERVAL_MIN || 15) * 60e3;
const orbio = makeOrbio({ apiKey: env.ORBIO_API_KEY || null });
let state = read("state.json", emptyState());
let reads = read("board-reads.json", {}), boardStats = null;   // latest read per live token → board.json for the static site

for (;;) {
  const t0 = Date.now();
  const r = await runTick({
    state, orbio, apiKey: env.ORBIO_API_KEY || null,
    pons: { fetchActive, fetchGraduated },
    readToken: (t, x = {}) => computeIntel(t.address, t.sym, { pool: t.pool, mcapUsd: t.mcapUsd ?? null, launchedAt: t.launchedAt, graduated: t.graduated, whales: true, watch: x.watch }),
    dryRun, forwardN, handle: env.AGENT_X_HANDLE || "",
    caps: { maxCreditPerDay: Number(env.AGENT_MAX_CREDIT_PER_DAY || 1.5), originalsPerDay: Number(env.AGENT_MAX_ORIGINALS_PER_DAY || 15) },
    log: (s) => console.log(new Date().toISOString(), s),
    // in watch mode a cycle may use most of its interval; a one-shot run keeps the 8-minute default
    opts: WATCH ? { timeBudgetMs: Math.max(60e3, every - 3 * 60e3) } : {},
  });
  state = r.state;
  const prevReads = reads;
  reads = mergeReads(reads, r.out.tokens);
  timelines(r.out, prevReads);
  if (r.out.stats) boardStats = r.out.stats;
  persist(r.out);
  if (!WATCH || Date.now() + every > until) break;
  await new Promise((s) => setTimeout(s, Math.max(0, every - (Date.now() - t0))));
}

// Each launch's timeline: events detected this cycle (with evidence) + state changes between reads. A token gets a
// coverage marker the first time it has a timeline. The first run with timelines seeds them from the ledgers.
function timelines(out, prevReads) {
  const path = (a) => join(DIR, "timelines", a + ".json"), now = Date.now();
  const add = new Map(), push = (a, e) => (add.get(a) || add.set(a, []).get(a)).push(e);
  if (SEED_TIMELINES) {
    const rows = [...readLines("events.jsonl"), ...(read("alerts.json", {}).events || [])];
    for (const e of backfillEntries(rows)) push(e.address, e);
  }
  for (const e of out.events) push(e.address, entryOf(e, { validated: e.validated }));
  for (const { text: _t, ...e } of out.followUps || []) push(e.address, e);
  for (const t of out.tokens) if (reads[t.address]) for (const e of stateEntries(prevReads[t.address], reads[t.address], { now, first: !existsSync(path(t.address)) && !add.has(t.address) })) push(t.address, e);
  for (const [a, entries] of add) {
    const prev = read(join("timelines", a + ".json"), null);
    // a launch seen for the first time this run starts its coverage at its earliest recorded entry
    if (!prev && !entries.some((e) => e.kind === "coverage")) {
      const t = reads[a] || out.tokens.find((x) => x.address === a);
      if (t) entries.push(...stateEntries(null, t, { now: Math.min(now, ...entries.map((e) => e.at)), first: true }));
    }
    const sym = entries.find((e) => e.sym)?.sym ?? out.events.find((e) => e.address === a)?.sym ?? reads[a]?.sym ?? null;
    writeFileSync(path(a), JSON.stringify(appendTimeline(prev, entries.map(({ sym: _s, address: _a, ...e }) => e), { address: a, sym, now })));
  }
  for (const f of readdirSync(join(DIR, "timelines"))) if (expired(read(join("timelines", f), null), now)) rmSync(join(DIR, "timelines", f));
}
function readLines(f) { try { return readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }

function persist(out) {
  writeFileSync(join(DIR, "state.json"), JSON.stringify(state));
  writeFileSync(join(DIR, "board-reads.json"), JSON.stringify(reads));
  writeFileSync(join(DIR, "board.json"), JSON.stringify(boardSnapshot(reads, boardStats)));
  writeFileSync(join(DIR, "alerts.json"), JSON.stringify(alertsFeed(read("alerts.json", null), out.events)));
  // a dossier per token on the board: rewritten when read this cycle, removed when the token leaves the board
  for (const t of out.tokens) { const d = reads[t.address] && dossierOf(t); if (d) writeFileSync(join(DIR, "tokens", t.address + ".json"), JSON.stringify(d)); }
  for (const f of readdirSync(join(DIR, "tokens"))) if (!reads[f.replace(/\.json$/, "")]) rmSync(join(DIR, "tokens", f));
  append("dry-run.jsonl", out.dryRun);
  append("posted.jsonl", [...out.posted, ...out.replies]);
  // every detected event with what the agent did with it (fate: posted · dry-run · held · logged). Rows written before
  // 2026-10-03 hold only the held/logged events, without id or fate.
  append("events.jsonl", [...out.events.map((e) => ({ id: e.id, at: e.at, kind: e.kind, address: e.address, sym: e.sym, headline: e.headline, fate: e.fate, why: e.why })),
    ...(out.followUps || []).map((e) => ({ id: e.id, at: e.at, kind: "follow-up", ref: e.ref, address: e.address, sym: e.sym, headline: e.headline, fate: e.posted ? "posted" : null }))]);
  for (const r of out.dryRun) console.log(`\n[dry-run ${r.kind}]\n${r.text}`);
  for (const e of out.errors) console.log("  ! " + e);
  writeFileSync(join(DIR, "README.md"),
    "# Block0 agent data\n\nWritten by `tools/agent-tick.mjs` every 15 min. `dry-run.jsonl` = posts the agent would have made; " +
    "`posted.jsonl` = what it actually posted; `events.jsonl` = every detected event and what the agent did with it; `board.json`, " +
    "`tokens/` and `timelines/` = what block0.app shows. The branch is kept as a single commit (no history); the ledgers are append-only.\n");
  if (env.AGENT_GIT_COMMIT === "1") {
    try {
      // one parentless commit holding the current tree, force-pushed over the branch
      execSync(`cd "${DIR}" && git add -A && c=$(git -c user.name=block0-agent -c user.email=block0-agent@users.noreply.github.com commit-tree "$(git write-tree)" -m "agent ${new Date().toISOString()}") && git push -q -f origin "$c:refs/heads/agent-data" && git reset -q --soft "$c"`, { stdio: "inherit", shell: "/bin/bash" });
    } catch (e) { console.log("  ! commit failed:", e.message); }
  }
}
