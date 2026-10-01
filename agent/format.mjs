// Post text for the agent — deterministic, numbers only from our own computation, never written by an LLM.
// Every post carries the token's contract address and a footer; kinds that have not passed a forward test carry
// "Not validated (forward test n=NN)". lint() is the last gate before anything is published.
// NO LINKS: Orbio refuses any X post containing an http(s) link (X bills a linked post ~13× more), and X turns a bare
// domain into a link too. The address identifies the token (two live tokens share a ticker); block0.app lives in the bio.
import { KINDS } from "../alert-events.mjs";
import { AGENT_KINDS } from "./agent-events.mjs";

export const MAX_LEN = 280;
// Kinds whose predictive value is unproven. They are LOGGED, never posted, until the radar forward test says PASS
// (CLAUDE.md: "the radar is not validated until REPORT.txt says PASS").
export const UNVALIDATED = new Set(["smart-convergence", "clean-launch"]);

// Words that turn a fact into a call. Word-boundary, case-insensitive. "sell" alone is allowed (it is a fact: wallets
// sold); "sell now" is not.
const FORBIDDEN = /\b(will|expect(?:ed|s)?|likely|predict(?:s|ed|ion)?|target|probability|odds|buy|sell now|moon|gem|rug(?:ged|pull)?|scam|guaranteed?)\b/i;
// anything X would turn into a link: a scheme, www., or a word.tld
const LINK = /https?:\/\/\S*|\bwww\.\S*|\b[a-z0-9-]+\.(?:app|com|xyz|io|so|co|net|org|fun|ai|gg|me|to|ly|dev|finance|trade|exchange|money|meme|cc|tv|info|link|site|online|club|pro|vip|top|lol)\b/i;
export function lint(text) {
  const problems = [];
  if (!text || !text.trim()) problems.push("empty");
  if (text.length > MAX_LEN) problems.push(`length ${text.length} > ${MAX_LEN}`);
  const m = text.match(FORBIDDEN); if (m) problems.push(`forbidden word "${m[0]}"`);
  const l = text.match(LINK); if (l) problems.push(`link "${l[0]}"`);
  return problems;
}

const $ = (x) => (x == null ? null : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x));
const age = (h) => (h == null ? null : h < 1 ? Math.max(1, Math.round(h * 60)) + "m old" : h < 48 ? Math.round(h) + "h old" : Math.round(h / 24) + "d old");
// token symbols are attacker-controlled: keep them short and plain (no @mentions, URLs, domains or line breaks
// smuggled in — a "." would let a symbol like "x.co" become a link)
export const cleanSym = (s) => String(s || "?").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 16) || "?";

export function footer(kind, { forwardN = null } = {}) {
  return UNVALIDATED.has(kind) ? `Not validated (forward test n=${forwardN ?? 0}). Facts, not advice.` : "On-chain facts, not advice.";
}

export function formatPost(ev, { forwardN = null } = {}) {
  const k = KINDS[ev.kind] || AGENT_KINDS[ev.kind] || { icon: "•", label: ev.kind };
  const meta = [$(ev.mcapUsd) && `${$(ev.mcapUsd)} mcap`, age(ev.ageH), ev.venue === "orbio-agent" ? "Orbio agent" : null].filter(Boolean).join(" · ");
  const lines = [`${k.icon} $${cleanSym(ev.sym)} — ${k.label}`, ev.headline, meta, ev.address, footer(ev.kind, { forwardN })].filter(Boolean);
  let text = lines.join("\n");
  if (text.length > MAX_LEN) {                                   // trim the headline, never the address or footer
    const fixed = text.length - ev.headline.length;
    lines[1] = ev.headline.slice(0, Math.max(20, MAX_LEN - fixed - 1)) + "…";
    text = lines.join("\n");
  }
  return text;
}

// a reply to an @mention: 2–3 lines of facts about one token + its address
export function formatReply(read) {
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
  return [head, facts, owner, read.address, "Facts, not advice."].filter(Boolean).join("\n").slice(0, MAX_LEN);
}
