#!/usr/bin/env node
// Block0 agent — one cycle then exit, or `--watch`: loop every AGENT_INTERVAL_MIN (15) for AGENT_WATCH_MIN (345)
// minutes in ONE process, so the in-memory transfer store stays warm and every read after the first is a delta pull
// (a cold read is ~20 s per token on the free node; .github/workflows/agent.yml starts a watch job every 6 h).
// With AGENT_GIT_COMMIT=1 each cycle commits AGENT_DIR (a checkout of the `agent-data` branch) and pushes it.
// Wiring only: the logic is agent/tick.mjs. State + ledgers live in AGENT_DIR (the `agent-data` branch in CI):
//   state.json      detector + budget state           dry-run.jsonl   what WOULD have been posted
//   posted.jsonl    what was posted (public record)   events.jsonl    every event incl. held/unvalidated, with why
//
// Env: AGENT_DRY_RUN (default "1" — only "0" publishes) · ORBIO_API_KEY · AGENT_X_HANDLE · PUBLIC_URL ·
//      AGENT_MAX_CREDIT_PER_DAY (default 1.5) · AGENT_MAX_ORIGINALS_PER_DAY (default 15) · AGENT_DIR (default data/agent)
//      AGENT_FORWARD_REPORT (path to the radar REPORT.txt, for the "n=" in unvalidated footers)
// Never set RPC_URL / ALCHEMY_* for this job: token reads run on the free native node.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runTick, emptyState } from "../agent/tick.mjs";
import { makeOrbio } from "../agent/orbio.mjs";
import { fetchActive, fetchGraduated } from "../pons.mjs";
import { computeIntel } from "../intel.mjs";

const env = process.env;
const DIR = env.AGENT_DIR || join("data", "agent");
mkdirSync(DIR, { recursive: true });
const read = (f, d) => { try { return JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch { return d; } };
const append = (f, rows) => { if (rows.length) appendFileSync(join(DIR, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); };

let forwardN = null;
try { const m = readFileSync(env.AGENT_FORWARD_REPORT || "", "utf8").match(/scored (\d+)/); if (m) forwardN = Number(m[1]); } catch { /* optional */ }

const dryRun = env.AGENT_DRY_RUN !== "0";
const WATCH = process.argv.includes("--watch");
const until = Date.now() + Number(env.AGENT_WATCH_MIN || 345) * 60e3, every = Number(env.AGENT_INTERVAL_MIN || 15) * 60e3;
const orbio = makeOrbio({ apiKey: env.ORBIO_API_KEY || null });
let state = read("state.json", emptyState());

for (;;) {
  const t0 = Date.now();
  const r = await runTick({
    state, orbio, apiKey: env.ORBIO_API_KEY || null,
    pons: { fetchActive, fetchGraduated },
    readToken: (t) => computeIntel(t.address, t.sym, { pool: t.pool, mcapUsd: t.mcapUsd ?? null, launchedAt: t.launchedAt, graduated: t.graduated, whales: false }),
    dryRun, publicUrl: env.PUBLIC_URL || "", forwardN, handle: env.AGENT_X_HANDLE || "",
    caps: { maxCreditPerDay: Number(env.AGENT_MAX_CREDIT_PER_DAY || 1.5), originalsPerDay: Number(env.AGENT_MAX_ORIGINALS_PER_DAY || 15) },
    log: (s) => console.log(new Date().toISOString(), s),
  });
  state = r.state;
  persist(r.out);
  if (!WATCH || Date.now() + every > until) break;
  await new Promise((s) => setTimeout(s, Math.max(0, every - (Date.now() - t0))));
}

function persist(out) {
  writeFileSync(join(DIR, "state.json"), JSON.stringify(state));
  append("dry-run.jsonl", out.dryRun);
  append("posted.jsonl", [...out.posted, ...out.replies]);
  append("events.jsonl", [...out.logged, ...out.held].map((e) => ({ at: e.at, kind: e.kind, address: e.address, sym: e.sym, headline: e.headline, why: e.why })));
  for (const r of out.dryRun) console.log(`\n[dry-run ${r.kind}]\n${r.text}`);
  for (const e of out.errors) console.log("  ! " + e);
  if (!existsSync(join(DIR, "README.md"))) writeFileSync(join(DIR, "README.md"),
    "# Block0 agent data\n\nWritten by `tools/agent-tick.mjs` every 15 min. `dry-run.jsonl` = posts the agent would have made; " +
    "`posted.jsonl` = what it actually posted; `events.jsonl` = held or unvalidated events with the reason.\n");
  if (env.AGENT_GIT_COMMIT === "1") {
    try {
      execSync(`git -C "${DIR}" add -A && (git -C "${DIR}" diff --cached --quiet || (git -C "${DIR}" -c user.name=block0-agent -c user.email=block0-agent@users.noreply.github.com commit -q -m "agent ${new Date().toISOString()}" && git -C "${DIR}" push -q origin agent-data))`, { stdio: "inherit", shell: "/bin/bash" });
    } catch (e) { console.log("  ! commit failed:", e.message); }
  }
}
