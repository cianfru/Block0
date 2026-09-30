#!/usr/bin/env node
// The radar's wallet list: every PERSON with a clean record on this chain, as a static file the browser loads.
// Zero RPC — built from the committed study (study/profiles traders[] + study/wallet-kinds.json).
//
// Record = closed, non-sniped round trips with ≥$200 in (sniping at block 0 is launch access, not skill).
//   proven : profitable round trips on ≥2 distinct tokens            (smart-money.provenAt, minWins 2)
//   sharp  : ≥3 distinct winning tokens AND ≥60 % of closed trips profitable
// Contracts (routers, aggregators, bots) are dropped; EIP-7702 delegated EOAs stay (they are people).
// Only win COUNTS and RATES are published: dollar PnL comes from the swap-implied reconstruction, which is off by up
// to ~10× in a token's first hours (see CLAUDE.md, 2026-09-30), so a "$ realised" figure would overstate precision.
//
//   node tools/scan-wallet-kinds.mjs && node tools/build-smart-wallets.mjs   → public/smart-wallets.json
import { writeFileSync } from "node:fs";
import { loadProfiles, contractSet } from "./cohort-lib.mjs";
import { ROUTERS } from "../engine.mjs";
import { INFRA } from "../dex.mjs";
import { EXCLUDE_TOKENS } from "../outcome.mjs";
import { fetchActive, fetchGraduated } from "../pons.mjs";

const AMM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";   // Robinhood singleton AMM (intel.mjs, graph.mjs)
const profs = loadProfiles().filter((p) => p.traders?.length);
const CONTRACTS = contractSet();

const rec = new Map();
for (const p of profs) for (const w of p.traders) {
  if (w.sniper || w.exitT == null || !(w.invested >= 200) || CONTRACTS.has(w.a)) continue;
  const r = rec.get(w.a) || rec.set(w.a, { trips: 0, wins: 0, won: new Set(), lastT: 0 }).get(w.a);
  r.trips++; if (w.realized >= 100) { r.wins++; r.won.add(p.addr); }
  r.lastT = Math.max(r.lastT, w.exitT);
}

const wallets = [];
for (const [a, r] of rec) {
  if (r.won.size < 2) continue;
  const winRate = r.wins / r.trips;
  wallets.push({ a, tier: r.won.size >= 3 && winRate >= 0.6 ? "sharp" : "proven", tokensWon: r.won.size, trips: r.trips, winRate: +winRate.toFixed(2), lastT: r.lastT });
}
wallets.sort((x, y) => (x.tier === y.tier ? 0 : x.tier === "sharp" ? -1 : 1) || y.tokensWon - x.tokensWon || y.winRate - x.winRate);

const launches = profs.map((p) => p.t0).sort((a, b) => a - b), iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
// QUOTE tokens: the other side of every pool (WETH, stables, the tokenized stocks Pons pairs launches against). A
// wallet that SELLS a launch RECEIVES one of these from the venue — without this list every sell reads as a buy.
// Pons publishes each pool's pairToken; fail soft to the static infra list if it is unreachable.
const quotes = new Set([...INFRA, ...EXCLUDE_TOKENS]);
try {
  const [g, a] = await Promise.all([fetchGraduated(), fetchActive({ pageSize: 100, sort: "newest" })]);
  for (const t of [...g.items, ...a.items]) if (t.pairToken) quotes.add(t.pairToken);
} catch (e) { console.log("  pons unreachable — quote list is the static infra set only:", e.message); }
quotes.delete("0x0000000000000000000000000000000000000000");   // native ETH pairs emit no ERC-20 leg

const out = {
  generatedAt: new Date().toISOString(),
  basis: { launches: profs.length, from: iso(launches[0]), to: iso(launches.at(-1)), contractsExcluded: CONTRACTS.size },
  rules: { proven: "profitable closed round trips on ≥2 distinct tokens (no block-0 snipes, ≥$200 in)", sharp: "≥3 winning tokens and ≥60% of closed trips profitable" },
  venues: [AMM, ...ROUTERS],
  quotes: [...quotes].sort(),
  wallets,
};
writeFileSync("public/smart-wallets.json", JSON.stringify(out));
console.log(`public/smart-wallets.json · ${quotes.size} quote tokens · ${wallets.length} wallets (${wallets.filter((w) => w.tier === "sharp").length} sharp) · launches ${out.basis.from} → ${out.basis.to}`);
