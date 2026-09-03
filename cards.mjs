// POST DESK — the daily content engine. Turns Block0's live, reproducible numbers into a set of postable cards:
// each carries an eyebrow, a hero stat, a plain-language summary, a ready-to-ship X post, and a small visual spec
// the client renders onto a canvas (colourful, on-brand). Pure + injectable — every builder takes already-fetched
// data and returns a card or null (a card that can't be built honestly is simply omitted, never faked).
//
// Voice rails (same moat as the rest of the product): plain-language hero, honest framing, NEVER a buy call, every
// number reproducible from a public endpoint. Tweets are kept tight (≤ ~280) so they post without a "see more" fold.

const A = { lime: "#c8ff4d", cyan: "#35e6e0", magenta: "#ff5cf0", amber: "#ffd23d", coral: "#ff3b5c" };

const usd = (n) => {
  n = Math.abs(Number(n) || 0);
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Math.round(n);
};
const pct = (x) => Math.round((Number(x) || 0) * 100);
const dstr = (d = new Date()) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// ---- individual card builders (each returns a card object or null) ----

// THE FADE REALITY — the study headline. Always available once the cohort study is present. The honest hook.
function fadeCard(v) {
  const c = v && v.cohort;
  if (!c || !(c.winners >= 0) || !(c.losers > 0)) return null;
  const tot = c.winners + c.losers, faded = Math.round((c.losers / tot) * 100);
  return {
    id: "fade", kind: "ring", accent: A.coral,
    eyebrow: `THE FADE REALITY · ${tot} STUDIED`,
    hero: faded + "%", heroSub: "faded within hours",
    title: "Most launches die on arrival",
    lines: [`${c.losers} of ${tot} studied launches faded`, `only ${c.winners} became real markets`, "every one reconstructed from public chain data"],
    viz: { type: "ring", pct: faded, color: A.coral },
    tweet: `${faded}% of new tokens on the Robinhood Chain die on arrival.\n\nWe studied ${tot}: ${c.losers} faded within hours, only ${c.winners} became real markets. Block0 grades every launch from public chain data — before you ape.\n\nSignal, not proof.`,
  };
}

// THE BOARD, GRADED — today's live launches by forensic verdict. The daily-fresh pulse.
function pulseCard(board) {
  const all = [...(board.cooking || []), ...(board.graduated || []), ...(board.dex || [])];
  if (!all.length) return null;
  const clean = all.filter((r) => r.risk < 35).length;
  const caution = all.filter((r) => r.risk >= 35 && r.risk < 66).length;
  const avoid = all.filter((r) => r.risk >= 66).length;
  const dumping = all.filter((r) => (r.flags && r.flags.insiderSellersNow) > 0).length;
  const grad = board.stats && board.stats.graduatedTotal;
  return {
    id: "pulse", kind: "bars", accent: A.lime,
    eyebrow: `THE BOARD · ${dstr()}`,
    hero: String(clean), heroSub: `of ${all.length} live launches read clean`,
    title: "Today on the Robinhood Chain",
    lines: [`${clean} clean · ${caution} caution · ${avoid} high-risk`,
      dumping ? `${dumping} with insiders selling right now` : "no live insider dumping on the board",
      grad ? `${grad} tokens have ever graduated the curve` : "sorted by forensics, not hype"],
    viz: { type: "bars", segs: [
      { label: "clean", v: clean, color: A.lime },
      { label: "caution", v: caution, color: A.amber },
      { label: "high-risk", v: avoid, color: A.coral }] },
    tweet: `Today on the Robinhood Chain: ${all.length} live launches graded.\n\n${clean} read clean on our forensics, ${avoid} are flashing snipers, bundles or insider dumps${dumping ? ` — ${dumping} selling right now` : ""}. Block0 sorts them so you don't have to.\n\nSignal, not proof.`,
  };
}

// FORWARD TRACK RECORD — out-of-sample. Shows the real rate once enough calls mature; otherwise the honest
// "accruing in the open" state (which is itself on-brand — we grade ourselves in public).
function trackCard(t) {
  if (!t || !(t.predicted > 0)) return null;
  if (t.ready && t.promising && t.promising.winRate != null) {
    const wr = pct(t.promising.winRate), base = t.baseRate != null ? pct(t.baseRate) : null;
    return {
      id: "track", kind: "gauge", accent: A.lime,
      eyebrow: "FORWARD TRACK RECORD · OUT-OF-SAMPLE",
      hero: wr + "%", heroSub: "of our 'promising' calls became real markets",
      title: "The model, marked to reality",
      lines: [`${t.resolved} calls matured · ${t.promising.winners} winners`,
        t.lift ? `${t.lift}× the ${base}% board base rate` : (base != null ? `vs a ${base}% base rate` : "measured, not claimed"),
        `frozen young, scored at ${t.horizonH}h — no hindsight`],
      viz: { type: "gauge", value: t.promising.winRate, base: t.baseRate || 0, color: A.lime },
      tweet: `Our "promising" calls on the Robinhood Chain: ${wr}% went on to become real markets${base != null ? ` — ${t.lift ? t.lift + "×" : "above"} the ${base}% base rate` : ""}.\n\nEvery call frozen young and scored ${t.horizonH}h later. Out-of-sample, no hindsight.\n\nSignal, not proof.`,
    };
  }
  return {
    id: "track", kind: "gauge", accent: A.cyan,
    eyebrow: "FORWARD TRACK RECORD",
    hero: `${t.resolved}/${t.minShow}`, heroSub: "calls matured — accruing in the open",
    title: "We grade ourselves in public",
    lines: [`${t.predicted} forward calls frozen`, `${t.pending} still maturing`, "every call timestamped — no cherry-picking"],
    viz: { type: "gauge", value: t.minShow ? t.resolved / t.minShow : 0, base: 0, color: A.cyan },
    tweet: `Block0 grades every launch — and grades itself in public.\n\n${t.predicted} forward calls frozen young, ${t.resolved} matured so far. No cherry-picking: every call is timestamped and scored later.\n\nSignal, not proof.`,
  };
}

// SMART-MONEY WATCH — where proven wallets have converged. Needs real convergence (≥2) to say anything.
function smartCard(sm) {
  const top = sm && sm.tokens && sm.tokens[0];
  if (!top || !(top.count >= 2)) return null;
  return {
    id: "smart", kind: "stat", accent: A.cyan,
    eyebrow: "SMART-MONEY WATCH",
    hero: String(top.count), heroSub: `proven wallets holding ${top.sym}`,
    title: "Smart money is converging",
    lines: [`${top.sym} · ${usd(top.mcapUsd)} · risk ${top.risk}/100`,
      `${top.count} wallets that won past launches now hold it`,
      "convergence is a signal, not a green light"],
    viz: { type: "dots", n: Math.min(top.count, 24), color: A.cyan },
    tweet: `${top.count} wallets with a proven track record on the Robinhood Chain are all holding ${top.sym} (${usd(top.mcapUsd)}).\n\nBlock0 reconstructs who actually made money on past launches, then watches where they go next. Convergence is a signal — not a green light.`,
  };
}

// LEADERBOARD — the chain's top proven wallet, anonymised (we aggregate, we don't dox in a post).
function leaderCard(lb) {
  const w = lb && lb.rows && lb.rows[0];
  if (!w) return null;
  const total = w.pnl != null ? w.pnl : w.realized;
  const up = total >= 0;
  return {
    id: "leader", kind: "stat", accent: A.lime,
    eyebrow: "LEADERBOARD · TOP WALLET",
    hero: (up ? "+" : "−") + usd(total), heroSub: "reconstructed profit, one wallet",
    title: "Follow the smart money",
    lines: [`${w.tokensWon} winning launch${w.tokensWon === 1 ? "" : "es"}${w.winRate != null ? ` · ${w.winRate}% hit rate` : ""}`,
      w.roi != null ? `${w.roi >= 0 ? "+" : ""}${Math.round(w.roi * 100)}% on capital deployed` : "cash actually taken out",
      "reconstructed from public transfers — our engine, no broker data"],
    viz: null,
    tweet: `The sharpest wallet on the Robinhood Chain has pulled ${(up ? "+" : "−") + usd(total)} across ${w.tokensWon} winning launch${w.tokensWon === 1 ? "" : "es"}${w.winRate != null ? ` (${w.winRate}% hit rate)` : ""}.\n\nBlock0 reconstructs every wallet's PnL from public transfers — no broker statements, no guessing.\n\nSignal, not proof.`,
  };
}

// FINGERPRINT SPOTLIGHT — a live launch that reads clean on the forensics. Framed HARD as a read, never a call.
function spotlightCard(board) {
  const all = [...(board.cooking || []), ...(board.dex || []), ...(board.graduated || [])].filter((r) => r.mcapUsd > 0 && r.sym);
  // a genuinely clean read: low risk, real blueprint fit, NOT concentrated, enough holders, no live insider dumping.
  // Concentration + dumping guards keep a whale-heavy token from being spotlit as a "winner's fingerprint".
  const cand = all.filter((r) => {
    const f = r.flags || {};
    return r.risk <= 40 && (r.blueprint || 0) >= 45 && (f.top10Pct == null || f.top10Pct < 60) && (f.holders || 0) >= 30 && !(f.insiderSellersNow > 0);
  }).sort((a, b) => (b.blueprint || 0) - (a.blueprint || 0) || a.risk - b.risk)[0];
  if (!cand) return null;
  const f = cand.flags || {};
  return {
    id: "spotlight", kind: "stat", accent: A.magenta,
    eyebrow: "FINGERPRINT SPOTLIGHT · A READ, NOT A CALL",
    hero: cand.sym, heroSub: `${(cand.blueprintLabel || "").toLowerCase()} · risk ${cand.risk}/100`,
    title: "Carrying a winner's fingerprint",
    lines: [`${usd(cand.mcapUsd)} · ${f.holders || 0} holders · ${(cand.ageH || 0).toFixed(0)}h old`,
      `${f.bundles || 0} bundles · top-10 hold ${f.top10Pct || 0}%${(f.insiderSellersNow || 0) ? ` · ${f.insiderSellersNow} selling` : " · no live dumping"}`,
      "clean forensics ≠ a guarantee it runs — do your own work"],
    viz: null,
    tweet: `${cand.sym} on the Robinhood Chain reads clean on the forensics we can check: risk ${cand.risk}/100, ${f.bundles || 0} bundles, top-10 hold ${f.top10Pct || 0}%, no live insider dumping.\n\nA clean read is not a call. Block0 shows the work; you decide.`,
  };
}

// Assemble the desk — daily-fresh first, evergreen after. Each builder is defensive; nulls drop out.
export function buildCards(ctx = {}) {
  const { board = {}, validation = null, track = null, smartMoney = null, leaderboard = null } = ctx;
  const cards = [
    pulseCard(board),
    spotlightCard(board),
    smartCard(smartMoney),
    fadeCard(validation),
    trackCard(track),
    leaderCard(leaderboard),
  ].filter(Boolean);
  return { updated: Date.now(), count: cards.length, cards };
}

export const _internals = { usd, pct, dstr, fadeCard, pulseCard, trackCard, smartCard, leaderCard, spotlightCard };
