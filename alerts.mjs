// Launch ALERTS — the push layer that turns Block0 from a dashboard into a product you don't have to watch.
//
// Each pass pulls the NEWEST active launches from Pons (not the board's top-by-market-cap — a brand-new launch
// has tiny mcap and wouldn't be on the board), verdicts them with the same on-chain engine, and pushes the ones
// that clear the bar to Telegram. Dormant with no bot token (no-op), like every other integration here.
//
// The bar deliberately encodes what the validation measured: DON'T alert inside the first ~30 min (AUC ~0.55 —
// a coin flip; alerting there would train people to distrust the bot). Fire only once a token is old enough to
// mean something, clean, and on winner pace. One alert per token, ever.
import { fetchActive } from "./pons.mjs";
import { computeIntel, blueprintMatch, blueprintLabel } from "./intel.mjs";
import { pathPosition, liveTrajectory, corridorStatus } from "./model.mjs";
import { sAdd, sHas, sMembers, lPush, lRange, KV_BACKEND } from "./store/kv.mjs";

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT = (process.env.TELEGRAM_CHAT_ID || "").trim();
export const ALERTS_ON = !!(TOKEN && CHAT);
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://block0-production.up.railway.app").replace(/\/$/, "");

// tunable bar (env-overridable) — defaults chosen from the separation study
const CFG = {
  scan: Number(process.env.ALERT_SCAN || 14),          // newest tokens to verdict per pass
  minAgeH: Number(process.env.ALERT_MIN_AGE_H || 0.5),  // skip the coin-flip window (measured AUC ~0.55 under 30m)
  maxAgeH: Number(process.env.ALERT_MAX_AGE_H || 24),   // still a "fresh catch", not an old coin
  maxRisk: Number(process.env.ALERT_MAX_RISK || 40),    // must read clean-ish
  minBlueprint: Number(process.env.ALERT_MIN_BLUEPRINT || 60), // partial fit or better
  minHolders: Number(process.env.ALERT_MIN_HOLDERS || 40),     // real adoption, not dead-on-arrival
};
const intervalMs = Number(process.env.ALERT_INTERVAL_MS || 120000);

const ALERTED_KEY = "alerts:sent", CALLS_KEY = "alerts:calls";
const alerted = new Set(); // in-memory cache of ALERTED_KEY, hydrated from the durable store at startup
let seeded = false;        // first pass just learns the current set so a cold start doesn't blast a backlog
let hydrated = false;
async function hydrate() {
  if (hydrated) return; hydrated = true;
  try { for (const a of await sMembers(ALERTED_KEY)) alerted.add(a); } catch { /* */ }
  if (alerted.size) seeded = true; // a durable store that already knows tokens means this isn't a cold start
}
// the recorded track record of past alerts (durable) — the honest foundation for showing whether calls worked out
export async function getCalls(n = 100) { return lRange(CALLS_KEY, n); }

async function verdict(meta) {
  const r = await computeIntel(meta.address, meta.sym, { pool: meta.pool, mcapUsd: meta.mcapUsd, graduated: false, launchedAt: meta.launchedAt, whales: false });
  const blueprint = blueprintMatch({ bundles: r.flags.bundles, top10Pct: r.flags.top10Pct, holders: r.flags.holders, risk: r.risk });
  const ageH = meta.launchedAt ? (Date.now() - Date.parse(meta.launchedAt)) / 3.6e6 : (r.ageH || 0);
  const trajectory = liveTrajectory({ blueprint, holders: r.flags.holders, ageH });
  const wallets = r.flags.wallets || r.flags.holders;
  const corridor = corridorStatus(ageH, trajectory, { wallets, mcap: meta.mcapUsd });
  return { ...r, meta, blueprint, blueprintLabel: blueprintLabel(blueprint), ageH: +ageH.toFixed(1), trajectory, corridor, wallets,
    path: pathPosition(wallets, meta.mcapUsd) };
}

function qualifies(r) {
  if (r.ageH < CFG.minAgeH || r.ageH > CFG.maxAgeH) return false; // past the coin-flip window, still fresh
  if (r.flags.bundles > 0) return false;                          // the hard veto
  if (r.risk > CFG.maxRisk) return false;                        // clean-ish
  if (r.flags.holders < CFG.minHolders) return false;            // real adoption
  if (r.flags.insiderSellersNow > 0) return false;               // not while insiders are dumping
  const onPace = r.blueprint >= CFG.minBlueprint || (r.corridor && r.corridor.status === "on-track");
  return onPace;
}

const $ = (x) => x == null ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x || 0);
function format(r) {
  const cor = r.corridor ? (r.corridor.status === "on-track" ? "on winner pace" : r.corridor.status === "behind" ? "behind pace" : "stalling") : "";
  const lines = [
    `🟢 <b>${r.meta.sym}</b> — clean launch on winner pace`,
    ``,
    `Risk <b>${r.risk}</b>/100 · ${r.label}`,
    `Blueprint <b>${r.blueprint}</b>/100 (${r.blueprintLabel})${cor ? ` · ${cor}` : ""}`,
    `${r.wallets.toLocaleString()} wallets · ${r.flags.holders} holders · ${$(r.mcapUsd)} mcap · ${r.ageH}h old`,
    `No bundles · ${r.flags.snipers} snipers · top-10 ${r.flags.top10Pct}%`,
    ``,
    `<a href="${PUBLIC_URL}/token?address=${r.address}">Full dossier →</a>`,
    `<i>Signal, not proof — never a buy recommendation.</i>`,
  ];
  return lines.join("\n");
}

async function sendTelegram(text) {
  if (!ALERTS_ON) return { skipped: true };
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  if (!r.ok) throw new Error("telegram " + r.status + " " + (await r.text().catch(() => "")).slice(0, 120));
  return r.json();
}

export async function runAlertScan() {
  if (!ALERTS_ON) return { on: false };
  await hydrate();
  let fired = 0, checked = 0;
  try {
    const { items } = await fetchActive({ sort: "newest", pageSize: CFG.scan });
    for (const m of items.filter((t) => t.address && !t.graduated)) {
      if (alerted.has(m.address)) continue;
      let r; try { r = await verdict(m); } catch { continue; }
      checked++;
      if (!qualifies(r)) continue;
      alerted.add(m.address); await sAdd(ALERTED_KEY, m.address); // mark (durably) before send so an error can't double-fire
      if (seeded) {
        try {
          await sendTelegram(format(r)); fired++;
          await lPush(CALLS_KEY, { address: m.address, sym: r.meta.sym, at: Date.now(), risk: r.risk, blueprint: r.blueprint,
            corridor: r.corridor?.status || null, mcapAtCall: r.mcapUsd || null, wallets: r.wallets, ageH: r.ageH }, 500);
        } catch (e) { console.error("alert send failed", e.message); }
      }
    }
    if (!seeded) { seeded = true; console.log(`[alerts] seeded ${alerted.size} existing tokens (no backlog blast); watching newest ${CFG.scan}/pass`); }
  } catch (e) { console.error("[alerts] scan error", e.message); }
  return { on: true, checked, fired, alertedTotal: alerted.size };
}

export function startAlerts() {
  if (!ALERTS_ON) { console.log("[alerts] dormant — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable launch alerts"); return; }
  console.log(`[alerts] on — Telegram launch alerts every ${Math.round(intervalMs / 1000)}s (age ${CFG.minAgeH}-${CFG.maxAgeH}h · risk ≤${CFG.maxRisk} · blueprint ≥${CFG.minBlueprint} · no bundles) · store: ${KV_BACKEND}${KV_BACKEND === "file" ? " (set KV_REST_API_* for durable alerts across redeploys)" : ""}`);
  runAlertScan().catch(() => {});
  setInterval(() => runAlertScan().catch(() => {}), intervalMs);
}
