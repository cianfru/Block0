// "MOST PROMISING BY PRICE BRACKET" — an LLM-assisted read over the board, on honest rails.
//
// What it does: group every live launch into a market-cap BRACKET (fresh <$500k, $500k–$1M, …), then within each
// bracket surface the launch whose ON-CHAIN FINGERPRINT looks most like a real one — clean risk, a float that isn't
// stuck in a few hands, real holder adoption, proven wallets showing up. We pre-rank the candidates deterministically
// (that ranking is also the fallback), and the LLM's ONLY job is to pick among those candidates and say WHY in plain
// language, using ONLY the facts we hand it.
//
// Honesty rails, enforced in code (validatePick), not just prompted:
//   • the pick MUST be one of the candidates we computed — the model can't name a token or a number we didn't give it;
//   • the "why" is a READ of on-chain structure, never a price call — buy/sell/moon/guarantee language is rejected;
//   • no LLM key, or every model failing, degrades to the deterministic pick + a templated reason. Never a hard error.
// This is signal, not proof — never a buy recommendation.

import { blueprintMatch } from "./intel.mjs";

// Brackets are the STAGES of the winners' path (same stages the corridor gates on), named as such — each label
// still carries its honest $ range so a stage name never obscures what it means.
export const BRACKETS = [
  { key: "fresh",       label: "Block zero · under $500k",    min: 0,    max: 5e5 },
  { key: "early",       label: "First traction · $500k–$1M",  min: 5e5,  max: 1e6 },
  { key: "traction",    label: "The climb · $1M–$5M",         min: 1e6,  max: 5e6 },
  { key: "established", label: "Proving it · $5M–$10M",       min: 5e6,  max: 1e7 },
  { key: "bluechip",    label: "Made it · $10M+",             min: 1e7,  max: Infinity },
];
export const bracketOf = (mcap) => BRACKETS.find((b) => mcap >= b.min && mcap < b.max) || BRACKETS[0];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Deterministic "promise" score — how much a launch's on-chain fingerprint resembles a real one. Interpretable on
// purpose (each term is a named signal), and it IS the fallback ranking when the LLM is unavailable. Higher = cleaner.
export function promiseScore(t) {
  const f = t.flags || {};
  const bp = blueprintMatch({ bundles: f.bundles || 0, top10Pct: f.top10Pct ?? 100, holders: f.holders || 0, risk: t.risk ?? 100 });
  let s = 0;
  s += bp;                                             // 0–100: the winner-fingerprint fit
  s += clamp(60 - (t.risk ?? 100), 0, 60);             // cleaner risk = more promise
  s += clamp((f.holders || 0) / 10, 0, 30);            // real adoption (capped so a big base can't dominate)
  s += clamp((t.momentum || 0), -20, 40) / 2;          // recent net buying
  s += (t.smart?.count || 0) * 8;                      // proven wallets present is a strong tell
  s -= (f.sniperHeldPct || 0) * 0.4;                   // supply still in sniper hands
  s -= (f.bundleHeldPct || 0) * 0.5;                   // one actor wearing many wallets
  s -= (f.insiderSellersNow || 0) * 4;                 // being distributed right now
  return Math.round(s * 10) / 10;
}

// Compact, model-facing fact sheet for one candidate — ONLY fields we actually computed on-chain.
export function candidateFacts(t) {
  const f = t.flags || {};
  return {
    address: (t.address || "").toLowerCase(),
    sym: t.sym || (t.address || "").slice(0, 6),
    mcapUsd: t.mcapUsd || 0,
    risk: t.risk ?? null, riskLabel: t.label || null,
    blueprint: blueprintMatch({ bundles: f.bundles || 0, top10Pct: f.top10Pct ?? 100, holders: f.holders || 0, risk: t.risk ?? 100 }),
    holders: f.holders || 0,
    top10Pct: f.top10Pct ?? null,
    snipers: f.snipers || 0, sniperHeldPct: f.sniperHeldPct || 0,
    bundles: f.bundles || 0, bundleHeldPct: f.bundleHeldPct || 0,
    insiderSellersNow: f.insiderSellersNow || 0,
    momentum: t.momentum ?? 0,
    smartMoney: t.smart?.count || 0,
    ageH: t.ageH ?? null,
    graduated: !!t.graduated,
    promise: promiseScore(t),
  };
}

// Group live launches into brackets, keep the real-market ones, pre-rank by promise, cap the candidate set.
export function bracketize(tokens, { minHolders = 20, perBracket = 6 } = {}) {
  const cands = (tokens || [])
    .filter((t) => t && t.address && (t.mcapUsd || 0) > 0 && (t.flags?.holders || 0) >= minHolders)
    .map((t) => ({ t, facts: candidateFacts(t) }));
  return BRACKETS.map((b) => {
    const inB = cands.filter((c) => c.facts.mcapUsd >= b.min && c.facts.mcapUsd < b.max)
      .sort((x, y) => y.facts.promise - x.facts.promise)
      .slice(0, perBracket);
    return { key: b.key, label: b.label, tier: BRACKETS.indexOf(b), candidates: inB.map((c) => c.facts) };
  }).filter((b) => b.candidates.length);
}

// ── validation: the model may only pick a candidate, and only READ structure — never make a price/buy call ──
const BUYWORDS = /\b(buy|sell|ape|moon|pump|dump|guarantee\w*|100x|1000x|to the moon|financial advice|not financial advice|will (?:pump|moon|explode|rise|run)|gonna|send it|lambo|degen play)\b/i;
const SIGNALWORDS = /\b(holder|holders|sniper|snipers|bundle|bundles|concentration|top ?10|top-10|float|supply|smart|risk|clean|adoption|distribut\w+|momentum|blueprint|fingerprint|wallet|wallets)\b/i;

export function validatePick(out, candidates) {
  if (!out || typeof out !== "object") return null;
  const set = new Set(candidates.map((c) => c.address));
  const pick = String(out.pick || "").toLowerCase();
  if (!set.has(pick)) return null;                     // must be one of OUR candidates — no invented token
  let why = String(out.why || "").replace(/\s+/g, " ").trim();
  if (why.length < 12 || why.length > 260) return null;
  if (BUYWORDS.test(why)) return null;                 // no buy/price call ever
  if (!SIGNALWORDS.test(why)) return null;             // must actually cite an on-chain signal
  const runnerUp = String(out.runnerUp || "").toLowerCase();
  return { pick, why, runnerUp: set.has(runnerUp) && runnerUp !== pick ? runnerUp : null };
}

// Templated, honest reason from a candidate's strongest real facts — the no-LLM fallback voice.
export function templatedWhy(c) {
  const bits = [];
  if (c.risk != null) bits.push(c.risk < 25 ? "reads clean" : c.risk < 45 ? "risk is settled" : "risk is mixed but");
  if (c.holders) bits.push(`${c.holders.toLocaleString()} holders`);
  if (c.blueprint >= 55) bits.push(`a ${c.blueprint >= 75 ? "strong" : "partial"} winner-fingerprint fit`);
  if (c.top10Pct != null && c.top10Pct < 60) bits.push(`top-10 hold ${c.top10Pct}% (float isn't stuck)`);
  if (c.smartMoney) bits.push(`${c.smartMoney} proven wallet${c.smartMoney > 1 ? "s" : ""} holding`);
  if (!c.snipers && !c.bundles) bits.push("no snipers or bundles");
  const body = bits.slice(0, 3).join(", ");
  return `Cleanest fingerprint in its bracket — ${body || "the least red on-chain"}.`;
}

// The LLM message pair for one bracket. System = the rails; user = the honest candidate facts.
export function promptFor(bracket) {
  const system = [
    "You are Block0's on-chain analyst. You are given several token launches in one market-cap bracket, each with",
    "factual on-chain metrics already computed from public chain data. Choose the ONE whose on-chain fingerprint",
    "looks most like a real launch rather than a trap: clean risk, a float not stuck in a few wallets (low top-10%),",
    "real holder adoption, no snipers/bundles still sitting on supply, proven ('smart money') wallets present.",
    "",
    "HARD RULES:",
    "- Pick only from the given candidates (use the exact `address`). Never name a token or number not provided.",
    "- Explain WHY purely as a read of the on-chain structure. Cite specific metrics you were given.",
    "- Never predict price, never say buy/sell/moon/pump, never give advice. This is signal, not proof.",
    "- Keep `why` to one or two plain sentences (<= 240 chars).",
    'Return ONLY JSON: {"pick":"0x…","why":"…","runnerUp":"0x… or empty"}.',
  ].join("\n");
  const user = `Bracket: ${bracket.label}\nCandidates:\n${JSON.stringify(bracket.candidates, null, 0)}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// Build the full picks payload. `chat` is injected (llm.mjs `chat`, or a stub in tests). Each bracket gets ONE LLM
// call at most; any failure falls back to the deterministic pick so the endpoint always returns a complete result.
export async function buildPicks(tokens, chat, opts = {}) {
  const brackets = bracketize(tokens, opts);
  let llmUsed = false, model = null, llmError = null;   // llmError: why the model wasn't used (no_key / no_model / auth / parse)
  const out = [];
  for (const b of brackets) {
    const top = b.candidates[0];
    let pick = top.address, why = templatedWhy(top), runnerUp = b.candidates[1]?.address || null, viaLlm = false;
    if (chat && b.candidates.length >= 2) {
      try {
        const res = await chat(promptFor(b), { json: true, maxTokens: 400, temperature: 0.3 });
        model = res.model || model;
        let parsed = null; try { parsed = JSON.parse(res.text); } catch { parsed = null; }
        const v = validatePick(parsed, b.candidates);
        if (v) { pick = v.pick; why = v.why; runnerUp = v.runnerUp || runnerUp; viaLlm = true; llmUsed = true; }
        else llmError = llmError || (parsed ? "rejected:" + (String(res.text || "").slice(0, 80)) : "parse");   // model answered but failed the honesty rails
      } catch (e) { llmError = (e && e.code) || (e && e.message) || "error"; /* no key / all models failed → deterministic pick */ }
    }
    const pc = b.candidates.find((c) => c.address === pick) || top;
    out.push({ key: b.key, label: b.label, tier: b.tier,
      pick: { ...pc, why, viaLlm }, runnerUp,
      candidateCount: b.candidates.length, candidates: b.candidates });
  }
  return { updated: Date.now(), llmUsed, model, llmError, hasKey: !!chat, brackets: out,
    note: "Ranks each launch's on-chain fingerprint within its market-cap bracket. Signal, not proof — never a buy recommendation." };
}
