#!/usr/bin/env node
// Does the forensic layer predict LOSERS? (2026-09-26) — reads committed study/ only, zero RPC.
//
// PRE-COMMITTED before any outcome was computed (thresholds chosen from the 6h feature
// distributions only, outcomes hidden):
//   Check point : first series point with ageH >= CHECK_H (default 6). Entry = mcap there.
//   Eligible    : token observed >= 7 days (cohort ageH >= 168) and entry mcap > 0.
//   Flags       : bundle   = bundles > 0 at the check
//                 conc     = top10 >= 60 %
//                 snipe    = sniperHeld >= 10 %
//                 risk     = risk score >= 50
//                 serial   = deployer has >= 2 earlier profiled launches (>= 7 d before this one), none reached $1M
//                 any      = bundle|conc|snipe|risk
//   Outcomes    : wipeout  = current mcap < 10 % of entry (an entry at the check lost >= 90 %)
//                 upside3  = series mcap after the check reaches >= 3x entry
//   Pass rule   : wipeout relative risk >= 1.5 with bootstrap 95 % CI lower bound > 1,
//                 in BOTH the earlier 70 % and the later 30 % of launches (time split).
//   Caveat      : the cohort is ~all GRADUATED Pons launches — pre-graduation rugs are not in it.
//
//   node tools/replay-safety.mjs [--checkH=6]
import fs from "node:fs";
import path from "node:path";

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const CHECK_H = Number(arg.checkH || 6);
const STUDY = process.env.STUDY_DIR || "study";

const cohort = new Map(JSON.parse(fs.readFileSync(path.join(STUDY, "cohort.json"), "utf8")).tokens.map((t) => [t.addr, t]));
const profiles = fs.readdirSync(path.join(STUDY, "profiles")).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(STUDY, "profiles", f), "utf8")));

const launchT = (p) => Date.parse(p.launchedAt) || (p.t0 || 0) * 1000;
const byDeployer = new Map();
for (const p of profiles) if (p.deployer) (byDeployer.get(p.deployer) || byDeployer.set(p.deployer, []).get(p.deployer)).push(p);

const rows = [];
for (const p of profiles) {
  const c = cohort.get(p.addr);
  const s = p.series || [];
  const i = s.findIndex((x) => x.ageH >= CHECK_H);
  if (!c || i < 0 || !(c.ageH >= 168)) continue;
  const at = s[i], entry = at.mcap;
  if (!(entry > 0)) continue;
  const later = s.slice(i + 1).map((x) => x.mcap || 0);
  const priors = (byDeployer.get(p.deployer) || []).filter((q) => q.addr !== p.addr && launchT(q) <= launchT(p) - 7 * 864e5);
  const flags = {
    bundle: (at.bundles || 0) > 0,
    conc: (at.top10 || 0) >= 60,
    snipe: (at.sniperHeld || 0) >= 10,
    risk: (at.risk || 0) >= 50,
    serial: priors.length >= 2 && priors.every((q) => !cohort.get(q.addr)?.reached),
  };
  flags.any = flags.bundle || flags.conc || flags.snipe || flags.risk;
  rows.push({
    t: launchT(p), sym: p.sym, entry, flags,
    wipeout: (c.curMcap || 0) < entry * 0.1,
    upside3: later.length > 0 && Math.max(...later) >= entry * 3,
  });
}
rows.sort((a, b) => a.t - b.t);

// Deterministic PRNG so the bootstrap is reproducible run to run.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const rate = (xs, k) => (xs.length ? xs.filter((r) => r[k]).length / xs.length : NaN);
function rr(set, flag, k) {
  const f = set.filter((r) => r.flags[flag]), u = set.filter((r) => !r.flags[flag]);
  const point = rate(f, k) / rate(u, k);
  const boots = [];
  for (let b = 0; b < 2000; b++) {
    const sf = f.map(() => f[Math.floor(rnd() * f.length)]), su = u.map(() => u[Math.floor(rnd() * u.length)]);
    const v = rate(sf, k) / rate(su, k);
    if (Number.isFinite(v)) boots.push(v);
  }
  boots.sort((a, b) => a - b);
  return { nF: f.length, nU: u.length, rF: rate(f, k), rU: rate(u, k), point, lo: boots[Math.floor(boots.length * 0.025)], hi: boots[Math.floor(boots.length * 0.975)] };
}

const cut = Math.floor(rows.length * 0.7);
const halves = { all: rows, early: rows.slice(0, cut), late: rows.slice(cut) };
const pc = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1).padStart(5) + "%" : "  n/a ");
const fx = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

console.log(`check at ${CHECK_H}h · eligible ${rows.length} · base wipeout ${pc(rate(rows, "wipeout"))} · base upside3 ${pc(rate(rows, "upside3"))}\n`);
const verdict = {};
for (const flag of ["bundle", "conc", "snipe", "risk", "serial", "any"]) {
  console.log(`— ${flag}`);
  for (const [h, set] of Object.entries(halves)) {
    const w = rr(set, flag, "wipeout"), u = rr(set, flag, "upside3");
    console.log(`  ${h.padEnd(5)} flagged ${String(w.nF).padStart(4)} / clean ${String(w.nU).padStart(4)} · wipeout ${pc(w.rF)} vs ${pc(w.rU)} RR ${fx(w.point)} [${fx(w.lo)}–${fx(w.hi)}] · upside3 ${pc(u.rF)} vs ${pc(u.rU)}`);
    if (h !== "all") verdict[flag] = (verdict[flag] ?? true) && w.point >= 1.5 && w.lo > 1;
  }
}
console.log("\nPASS (RR>=1.5, CI>1, both halves):", Object.entries(verdict).map(([k, v]) => `${k}=${v ? "PASS" : "fail"}`).join(" "));
