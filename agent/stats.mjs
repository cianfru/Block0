// STATE OF LAUNCHES — the week in numbers, from the launchpads' own lists and Block0's own record. Pure.
// Written to agent-data/stats.json every cycle (the /stats page) and posted once a week (Monday 17:00 UTC) by the
// agent. Counts and medians only — facts about the chain's launches, never a ranking of what to buy.
import { lint } from "./format.mjs";

const WEEK = 7 * 86400e3;
const med = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// agents: normAgent rows (owner, launchedAt s, graduated, usdgAtoms) · ponsGrads: pons items with graduatedAt (ISO)
// events: events.jsonl rows · reads: the latest read per live launch (board-reads.json values)
export function weeklyStats({ agents = [], ponsGrads = [], events = [], reads = [], now = Date.now() } = {}) {
  const since = now - WEEK;
  const week = agents.filter((a) => a.launchedAt && a.launchedAt * 1000 >= since);
  const byOwner = new Map(); for (const a of agents) (byOwner.get(a.owner) || byOwner.set(a.owner, []).get(a.owner)).push(a);
  const repeat = [...byOwner.values()].filter((l) => l.length >= 5);
  const once = [...byOwner.values()].filter((l) => l.length === 1);
  const fees = agents.map((a) => (a.usdgAtoms != null ? Number(a.usdgAtoms) / 1e6 : 0)).filter((x) => x > 0).sort((x, y) => y - x);
  const ev = events.filter((e) => e.fate && e.at >= since), kindN = (k) => ev.filter((e) => e.kind === k).length;
  const live = reads.filter((r) => !r.graduated), grad = reads.filter((r) => r.graduated);
  return {
    at: now, windowDays: 7,
    orbio: { launched: week.length, graduated: week.filter((a) => a.graduated).length, gradPct: pct(week.filter((a) => a.graduated).length, week.length),
      allTime: agents.length, allTimeGraduated: agents.filter((a) => a.graduated).length,
      owners: byOwner.size, repeatOwners: repeat.length, repeatLaunches: repeat.reduce((s, l) => s + l.length, 0),
      repeatGraduated: repeat.reduce((s, l) => s + l.filter((a) => a.graduated).length, 0),
      singleOwners: once.length, singleGraduated: once.filter((l) => l[0].graduated).length,
      feesUsd: Math.round(fees.reduce((s, x) => s + x, 0)), feesTop10Pct: pct(fees.slice(0, 10).reduce((s, x) => s + x, 0), fees.reduce((s, x) => s + x, 0)) },
    pons: { graduated: ponsGrads.filter((g) => g.graduatedAt && Date.parse(g.graduatedAt) >= since).length },
    events: { earlySales: kindN("insider-dump"), earlySalesLaunches: new Set(ev.filter((e) => e.kind === "insider-dump").map((e) => e.address)).size,
      repeatOwnerLaunches: kindN("serial-owner"), graduations: kindN("graduated"), feeWithdrawals: kindN("principal-withdrawn"),
      material: ev.filter((e) => ["posted", "dry-run", "held"].includes(e.fate)).length, total: ev.length },
    reads: { launches: reads.length, bundledPct: pct(reads.filter((r) => r.flags?.bundles > 0).length, reads.length),
      curve: { n: live.length, holders: med(live.map((r) => r.flags?.holders)), top10: med(live.map((r) => r.flags?.top10Pct)) },
      graduated: { n: grad.length, holders: med(grad.map((r) => r.flags?.holders)), top10: med(grad.map((r) => r.flags?.top10Pct)) } },
  };
}

// Monday, 17:00 UTC or later, once per ISO week
export const weekKey = (t) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = d.getUTCFullYear(); return `${y}-W${String(Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7)).padStart(2, "0")}`; };
export const weeklyDue = (lastWeek, now) => { const d = new Date(now); return d.getUTCDay() === 1 && d.getUTCHours() >= 17 && lastWeek !== weekKey(now); };

export function formatWeekly(s) {
  const n = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US")), pl = (x, one, many = one + "s") => `${n(x)} ${x === 1 ? one : many}`;
  const lines = ["Robinhood Chain launches · 7 days",
    `Orbio: ${pl(s.orbio.launched, "agent")} · ${n(s.orbio.graduated)} graduated${s.orbio.gradPct != null ? ` (${s.orbio.gradPct}%)` : ""}`,
    `Owners with 5+ agents: ${n(s.orbio.repeatOwners)} · ${pl(s.orbio.repeatLaunches, "launch", "launches")} · ${n(s.orbio.repeatGraduated)} graduated`,
    `Pons: ${n(s.pons.graduated)} graduated`,
    `${pl(s.events.earlySales, "early-wallet sell-off")} on ${pl(s.events.earlySalesLaunches, "launch", "launches")}`,
    "Launchpad data + Block0 reads. Not advice."];
  let text = lines.join("\n");
  if (lint(text).length) text = lines.filter((l) => !/^Owners with/.test(l)).join("\n");
  return text;
}
