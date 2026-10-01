// Post text for the agent — deterministic, numbers only from our own computation, never written by an LLM.
// Every post carries the token address link and a footer; kinds that have not passed a forward test carry
// "Not validated (forward test n=NN)". lint() is the last gate before anything is published.
import { KINDS } from "../alert-events.mjs";
import { AGENT_KINDS } from "./agent-events.mjs";

export const MAX_LEN = 280;
// Kinds whose predictive value is unproven. They are LOGGED, never posted, until the radar forward test says PASS
// (CLAUDE.md: "the radar is not validated until REPORT.txt says PASS").
export const UNVALIDATED = new Set(["smart-convergence", "clean-launch"]);

// Words that turn a fact into a call. Word-boundary, case-insensitive. "sell" alone is allowed (it is a fact: wallets
// sold); "sell now" is not.
const FORBIDDEN = /\b(will|expect(?:ed|s)?|likely|predict(?:s|ed|ion)?|target|probability|odds|buy|sell now|moon|gem|rug(?:ged|pull)?|scam|guaranteed?)\b/i;
export function lint(text) {
  const problems = [];
  if (!text || !text.trim()) problems.push("empty");
  if (text.length > MAX_LEN) problems.push(`length ${text.length} > ${MAX_LEN}`);
  const m = text.match(FORBIDDEN); if (m) problems.push(`forbidden word "${m[0]}"`);
  return problems;
}

const $ = (x) => (x == null ? null : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x));
const age = (h) => (h == null ? null : h < 1 ? Math.max(1, Math.round(h * 60)) + "m old" : h < 48 ? Math.round(h) + "h old" : Math.round(h / 24) + "d old");
// token symbols are attacker-controlled: keep them short and plain (no @mentions, URLs or line breaks smuggled in)
export const cleanSym = (s) => String(s || "?").replace(/[^\p{L}\p{N}_.-]/gu, "").slice(0, 16) || "?";

export function footer(kind, { forwardN = null } = {}) {
  return UNVALIDATED.has(kind) ? `Not validated (forward test n=${forwardN ?? 0}). Facts, not advice.` : "On-chain facts, not advice.";
}

export function formatPost(ev, { publicUrl = "", forwardN = null } = {}) {
  const k = KINDS[ev.kind] || AGENT_KINDS[ev.kind] || { icon: "•", label: ev.kind };
  const meta = [$(ev.mcapUsd) && `${$(ev.mcapUsd)} mcap`, age(ev.ageH), ev.venue === "orbio-agent" ? "Orbio agent" : null].filter(Boolean).join(" · ");
  const link = publicUrl ? `${publicUrl.replace(/\/$/, "")}/token?address=${ev.address}` : ev.address;
  const lines = [`${k.icon} $${cleanSym(ev.sym)} — ${k.label}`, ev.headline, meta, link, footer(ev.kind, { forwardN })].filter(Boolean);
  let text = lines.join("\n");
  if (text.length > MAX_LEN) {                                   // trim the headline, never the link or footer
    const fixed = text.length - ev.headline.length;
    lines[1] = ev.headline.slice(0, Math.max(20, MAX_LEN - fixed - 1)) + "…";
    text = lines.join("\n");
  }
  return text;
}

// a reply to an @mention: 2–3 lines of facts about one token + the link
export function formatReply(read, { publicUrl = "" } = {}) {
  const f = read.flags || {};
  const facts = [
    read.risk != null && `risk ${read.risk}/100`,
    f.holders != null && `${Number(f.holders).toLocaleString("en-US")} holders`,
    f.top10Pct != null && `top10 ${Math.round(f.top10Pct)}%`,
    f.bundles > 0 ? `${f.bundles} bundle${f.bundles > 1 ? "s" : ""}` : "no bundles",
    f.snipers > 0 && `${f.snipers} snipers`,
    f.insiderSellersNow > 0 && `${f.insiderSellersNow} early wallets selling now`,
  ].filter(Boolean).join(" · ");
  const head = `$${cleanSym(read.sym)} · ${[$(read.mcapUsd) && `${$(read.mcapUsd)} mcap`, age(read.ageH)].filter(Boolean).join(" · ")}`;
  const owner = read.ownerRep ? `owner: ${read.ownerRep.launched} launches, ${read.ownerRep.graduated} graduated` : null;
  const link = publicUrl ? `${publicUrl.replace(/\/$/, "")}/token?address=${read.address}` : read.address;
  return [head, facts, owner, link, "Facts, not advice."].filter(Boolean).join("\n").slice(0, MAX_LEN);
}
