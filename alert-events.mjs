// EVENT ALERTS — the product a trader keeps open. Pure detection of alert-worthy TRANSITIONS between consecutive
// board snapshots (zero extra RPC: it runs over verdicts the board already computed every cycle):
//
//   • insider-dump      — flagged early wallets STARTED selling into the pool (insiderSellersNow 0 → ≥1)
//   • smart-convergence — proven-PnL wallets REACHED two or more on one token (the high-confidence read)
//   • clean-launch      — a fresh launch cleared the clean/on-pace bar (mirrors alerts.mjs' Telegram bar)
//
// Honesty rails: every alert carries the concrete numbers it fired on; a per-token per-kind COOLDOWN means a
// flickering signal can't spam; a cold start SEEDS (learns the current state) and never blasts a backlog. Injectable
// clock, previous-state map and last-fired map so it's unit-testable and restart-safe when persisted by the caller.

export const KINDS = {
  "insider-dump":      { sev: "bad",  icon: "▼", label: "insiders selling" },
  "smart-convergence": { sev: "good", icon: "◎", label: "smart money converging" },
  "clean-launch":      { sev: "good", icon: "●", label: "clean launch on pace" },
};

const DEF = {
  cooldownMs: 6 * 3600 * 1000,   // one alert per token per kind per 6h
  maxAgeH: 72,                   // only live launches (a week-old coin's insider sale isn't a launch alert)
  minMcap: 5000,                 // ignore dust
  smartMin: 2,                   // convergence = at least this many proven wallets
  cleanMinAgeH: 0.5, cleanMaxAgeH: 24, cleanMaxRisk: 40, cleanMinBlueprint: 60, cleanMinHolders: 40,
};

// state per token the detector needs from the PREVIOUS snapshot
const snap = (t) => ({ sellers: t.flags?.insiderSellersNow || 0, smart: t.smart?.count || 0, clean: false });

export function detectEvents(prev, tokens, opts = {}) {
  const o = { ...DEF, ...opts }; const now = o.now || Date.now();
  const lastFired = { ...(o.lastFired || {}) };   // "kind:address" -> ts
  const next = {}; const events = [];
  const canFire = (kind, a) => { const k = kind + ":" + a; return !(lastFired[k] && now - lastFired[k] < o.cooldownMs); };
  const fire = (kind, t, detail, headline) => {
    if (!canFire(kind, t.address)) return;
    lastFired[kind + ":" + t.address] = now;
    events.push({ id: `${kind}:${t.address}:${now}`, kind, sev: KINDS[kind].sev, at: now,
      address: t.address, sym: t.sym || t.address.slice(0, 6), mcapUsd: t.mcapUsd || 0, ageH: t.ageH ?? null,
      risk: t.risk ?? null, holders: t.flags?.holders || 0, detail, headline });
  };
  for (const t of tokens || []) {
    if (!t || !t.address) continue;
    const a = t.address.toLowerCase(); const cur = snap(t); const was = prev && prev[a];
    // compute the FULL state (incl. clean) BEFORE the seed check, so a token that was already clean at first sight
    // is recorded as clean and can't fire "clean launch" on the very next cycle (that would be a backlog blast)
    const f = t.flags || {};
    cur.clean = (t.ageH ?? 0) >= o.cleanMinAgeH && (t.ageH ?? 0) <= o.cleanMaxAgeH && !(f.bundles > 0) && (t.risk ?? 100) <= o.cleanMaxRisk
      && (f.holders || 0) >= o.cleanMinHolders && !(f.insiderSellersNow > 0) && ((t.blueprint || 0) >= o.cleanMinBlueprint || t.corridor?.status === "on-track");
    next[a] = cur;
    const live = (t.mcapUsd || 0) >= o.minMcap && (t.ageH == null || t.ageH <= o.maxAgeH);
    if (!was) continue;                       // first sight = seed, never fire (no cold-start backlog blast)
    if (!live) continue;
    // insiders STARTED selling
    if (cur.sellers >= 1 && was.sellers === 0) {
      const pct = t.flags?.insiderDumpNowPct;
      fire("insider-dump", t, { sellers: cur.sellers, pct: pct ?? null, top10Pct: t.flags?.top10Pct ?? null },
        `${cur.sellers} insider wallet${cur.sellers > 1 ? "s" : ""} started selling${pct ? ` · ${pct}% of supply moving` : ""}`);
    }
    // smart money REACHED convergence
    if (cur.smart >= o.smartMin && was.smart < o.smartMin) {
      fire("smart-convergence", t, { smart: cur.smart, risk: t.risk ?? null },
        `${cur.smart} proven wallets now holding · risk ${t.risk ?? "—"}/100`);
    }
    // a fresh launch cleared the clean bar (fires once per cooldown; mirrors the Telegram launch bar)
    if (cur.clean && !was.clean) fire("clean-launch", t, { blueprint: t.blueprint ?? null, top10Pct: f.top10Pct ?? null, snipers: f.snipers || 0 },
      `risk ${t.risk}/100 · blueprint ${t.blueprint ?? "—"}/100 · ${(f.holders || 0).toLocaleString()} holders · no bundles`);
  }
  return { events, next, lastFired };
}

const $ = (x) => x == null ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
// Telegram HTML for one event — concrete numbers, a link, the honesty line.
export function formatEvent(ev, publicUrl = "") {
  const k = KINDS[ev.kind] || { icon: "•", label: ev.kind };
  const ageS = ev.ageH == null ? "" : ev.ageH < 1 ? ` · ${Math.round(ev.ageH * 60)}m old` : ` · ${Math.round(ev.ageH)}h old`;
  return [
    `${ev.sev === "bad" ? "🔴" : "🟢"} <b>${ev.sym}</b> — ${k.label}`,
    ``,
    ev.headline,
    `${$(ev.mcapUsd)} mcap${ageS}`,
    ``,
    publicUrl ? `<a href="${publicUrl}/token?address=${ev.address}">Full dossier →</a>` : "",
    `<i>Signal, not proof — never a buy recommendation.</i>`,
  ].filter((l, i) => l !== "" || i === 1 || i === 4).join("\n");
}
