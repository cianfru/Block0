#!/usr/bin/env node
// Classify every wallet that could ever count as "proven smart money" as a person or a contract — once, forever.
//
// Why: the research ledger (smart-money.provenLedger) never filtered contracts, so routers, aggregators and bots
// with "wins" on dozens of tokens were minted smart money and showed up in ~half of all launches. The live
// leaderboard always filtered them (rpc.isContract); the study did not. This closes that gap.
//
// Cost: one eth_getCode per wallet on the FREE native node, "latest" (the node is head-only, and latest is all this
// needs). Incremental — wallets already in study/wallet-kinds.json are never re-read. EIP-7702 delegated EOAs carry
// a 23-byte 0xef0100… pointer as code; they are people, recorded as "delegated", and stay eligible.
//
//   node tools/scan-wallet-kinds.mjs [--minWins=2]
import { writeFileSync } from "node:fs";
import { rpc } from "../rpc.mjs";
import { loadProfiles, loadWalletKinds, WALLET_KINDS_PATH } from "./cohort-lib.mjs";
import { provenLedger, walletKind } from "../smart-money.mjs";

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const MIN_WINS = Number(arg.minWins || 2);

const kinds = loadWalletKinds();
const ledger = provenLedger(loadProfiles());
const todo = [...ledger].filter(([a, w]) => !kinds[a] && new Set(w.map((x) => x.token)).size >= MIN_WINS).map(([a]) => a);
console.log(`${ledger.size} wallets with a clean win · ${todo.length} candidates (≥${MIN_WINS} tokens) not yet classified`);

let done = 0, failed = 0;
const worker = async () => {
  while (todo.length) {
    const a = todo.pop();
    try { kinds[a] = walletKind(await rpc("eth_getCode", [a, "latest"], 3)); } catch { failed++; }
    if (++done % 100 === 0) console.log(`  ${done} read`);
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync(WALLET_KINDS_PATH, JSON.stringify(Object.fromEntries(Object.entries(kinds).sort())));
const count = (k) => Object.values(kinds).filter((v) => v === k).length;
console.log(`→ ${WALLET_KINDS_PATH}: ${count("eoa")} eoa · ${count("delegated")} delegated · ${count("contract")} contract · ${failed} failed (re-run to retry)`);
