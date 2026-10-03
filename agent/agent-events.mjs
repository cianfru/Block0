// ORBIO-ECONOMICS EVENTS — pure transitions over consecutive snapshots of Orbio's public agent list
// (GET https://api.orbio.so/api/protocol/agents). Facts about money already on-chain; no prediction anywhere.
//
//   principal-withdrawn  stake.withdrawnWei 0 → >0, or grows ≥10%            (the creator took staked ORBIO out)
//   cliff-24h            the 10-day principal lock ends within 24h, once      (the staked ORBIO becomes withdrawable)
//   serial-owner         a NEW agent whose owner already launched ≥3 agents, none graduated
//   credit-idle          ≥7d old, ≥$500 of fees converted to USDG credit, none activated — once per 7d
//   first-harvest        converted fees cross $100 for the first time
//
// Rails (same as alert-events.mjs): a cold start SEEDS and never blasts a backlog; per-agent per-kind cooldown;
// a null field never fires (null = unavailable, never zero). Amounts are BigInt-exact — wei never touches a float
// until it is formatted.
export const AGENT_KINDS = {
  // routine: the staked half of claimed fees, withdrawn once its lock ends (agent/materiality.mjs) — info, not a flag
  "principal-withdrawn": { sev: "info", icon: "◇", label: "creator withdrew unlocked fee stake" },
  "serial-owner": { sev: "bad", icon: "▲", label: "repeat owner, no graduations" },
  "cliff-24h": { sev: "info", icon: "◷", label: "principal lock ends within 24h" },
  "credit-idle": { sev: "info", icon: "◌", label: "fee credit unused" },
  "first-harvest": { sev: "info", icon: "◆", label: "first $100 of fees converted" },
  // not Orbio-specific: any Pons launch seen on the curve and later listed as graduated (detected in agent/tick.mjs)
  graduated: { sev: "info", icon: "◆", label: "graduated" },
};

const DEF = { cooldownMs: 6 * 3600e3, idleCooldownMs: 7 * 86400e3, idleMinUsd: 500, idleMinAgeD: 7, harvestUsd: 100, serialMin: 3 };
const big = (v) => { try { return v == null || v === "" ? null : BigInt(v); } catch { return null; } };
const usdgUsd = (atoms) => (atoms == null ? null : Number(atoms) / 1e6);          // USDG has 6 decimals
const orbio = (wei) => (wei == null ? null : Number(wei / 10n ** 14n) / 1e4);     // 18 decimals → float for display only

// Orbio API record → the fields the detector reads (strings in, typed out; missing stays null)
export function normAgent(x, now = Date.now()) {
  const launched = Number(x.launchedAt) || null;
  return {
    id: String(x.agentId), address: String(x.token || "").toLowerCase(), sym: x.symbol || "?", name: x.name || "",
    owner: String(x.owner || "").toLowerCase(), launchedAt: launched, ageH: launched ? (now / 1000 - launched) / 3600 : null,
    graduated: !!x.price?.graduated, mcapUsd: x.price?.marketCapMicroUsd != null ? Number(x.price.marketCapMicroUsd) / 1e6 : null,
    stakedWei: big(x.stake?.stakedWei), withdrawnWei: big(x.stake?.withdrawnWei),
    usdgAtoms: big(x.converted?.usdgAtoms), activatedAtoms: big(x.credit?.activatedAtoms),
    unlocksAt: Number(x.cliff?.unlocksAt) || null, locked: x.cliff?.locked ?? null,
  };
}

// what the next run needs to know about each agent (JSON-safe: BigInts as strings)
const snap = (a, cliffDone) => ({ withdrawn: a.withdrawnWei?.toString() ?? null, usdg: a.usdgAtoms?.toString() ?? null, cliffDone: !!cliffDone });

export function agentEvents(prev, agents, opts = {}) {
  const o = { ...DEF, ...opts }, now = o.now ?? Date.now(), orbioUsd = o.orbioUsd ?? null;
  const lastFired = { ...(o.lastFired || {}) }, next = {}, events = [];
  const cold = !prev || Object.keys(prev).length === 0;
  const byOwner = new Map();
  for (const a of agents) (byOwner.get(a.owner) || byOwner.set(a.owner, []).get(a.owner)).push(a);
  const fire = (kind, a, detail, headline, cooldown = o.cooldownMs) => {
    const k = kind + ":" + a.id;
    if (lastFired[k] && now - lastFired[k] < cooldown) return;
    lastFired[k] = now;
    events.push({ id: `${kind}:${a.address}:${now}`, kind, sev: AGENT_KINDS[kind].sev, at: now, agentId: a.id, address: a.address,
      sym: a.sym, mcapUsd: a.mcapUsd, ageH: a.ageH, venue: "orbio-agent", owner: a.owner || null, detail, headline });
  };
  const usd = (n) => (n == null ? "" : n >= 1e3 ? ` (≈$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k)` : ` (≈$${Math.round(n)})`);

  for (const a of agents) {
    if (!a.id || !a.address) continue;
    const was = prev?.[a.id];
    const leftH = a.unlocksAt ? (a.unlocksAt - now / 1000) / 3600 : null;
    const cliffNow = a.locked === true && leftH != null && leftH > 0 && leftH <= 24;
    next[a.id] = snap(a, was?.cliffDone || (cold && cliffNow));
    if (cold) continue;                                                        // seed only — no backlog blast

    if (!was) {                                                                // a NEW agent
      const prior = (byOwner.get(a.owner) || []).filter((x) => x.id !== a.id && (x.launchedAt || 0) <= (a.launchedAt || Infinity));
      if (a.owner && prior.length >= o.serialMin && prior.every((x) => !x.graduated))
        fire("serial-owner", a, { prior: prior.length, graduated: 0 }, `owner wallet launched ${prior.length} agents before this one · 0 graduated`);
      continue;
    }
    const w0 = big(was.withdrawn), w1 = a.withdrawnWei;
    if (w0 != null && w1 != null && w1 > w0 && (w0 === 0n || w1 * 10n >= w0 * 11n)) {
      const amt = orbio(w1 - w0);
      fire("principal-withdrawn", a, { withdrawnOrbio: amt, totalWithdrawnOrbio: orbio(w1), stakedOrbio: a.stakedWei != null ? orbio(a.stakedWei) : null,
        withdrawnUsd: orbioUsd != null ? +(amt * orbioUsd).toFixed(2) : null },
        `creator withdrew ${Math.round(amt).toLocaleString("en-US")} staked ORBIO${usd(orbioUsd != null ? amt * orbioUsd : null)}`);
    }
    if (cliffNow && !was.cliffDone) {
      next[a.id].cliffDone = true;
      const st = a.stakedWei != null ? orbio(a.stakedWei) : null;
      fire("cliff-24h", a, { hoursLeft: Math.round(leftH), stakedOrbio: st },
        `principal lock ends in ${Math.max(1, Math.round(leftH))}h${st != null ? ` · ${Math.round(st).toLocaleString("en-US")} ORBIO staked${usd(orbioUsd != null ? st * orbioUsd : null)} becomes withdrawable` : ""}`);
    }
    const u0 = usdgUsd(big(was.usdg)), u1 = usdgUsd(a.usdgAtoms);
    if (u0 != null && u1 != null && u0 < o.harvestUsd && u1 >= o.harvestUsd)
      fire("first-harvest", a, { convertedUsd: Math.round(u1) }, `creator fees converted to credit passed $${o.harvestUsd} ($${Math.round(u1)} so far)`);
    if (u1 != null && a.activatedAtoms != null && a.ageH != null && a.ageH >= o.idleMinAgeD * 24 && u1 >= o.idleMinUsd && a.activatedAtoms === 0n)
      fire("credit-idle", a, { convertedUsd: Math.round(u1), ageD: Math.floor(a.ageH / 24) },
        `$${Math.round(u1).toLocaleString("en-US")} of fees converted to credit, none activated after ${Math.floor(a.ageH / 24)} days (activation is public, spending is not)`, o.idleCooldownMs);
  }
  return { events, next, lastFired };
}
