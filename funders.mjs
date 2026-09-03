// COMMON-FUNDER LINKS — the deeper bubble-map signal: wallets funded from the SAME source. A bundle careful enough
// never to trade with itself is still betrayed by where its wallets got their first gas/quote. Two of our holders
// funded by one wallet is a coordination edge the intra-token graph can't see.
//
// ⭐ BUDGET-CONSCIOUS BY DESIGN (see CLAUDE.md North Star — minimum cost). This is the only part of the bubble map
// that costs Alchemy, so it is fenced hard:
//   • TOP N ONLY (default 40) — never every holder.
//   • OPT-IN (`?funders=1`) — never runs on the default graph or on a schedule.
//   • ONE getAssetTransfers per wallet, and the result (a wallet's first funder) is IMMUTABLE → cached FOREVER in
//     KV (`funder:{addr}`). A wallet is looked up once, ever, across all tokens and restarts.
//   • Fan-out guard: a funder that seeded many of our wallets is an exchange/faucet, not a bundler — dropped, so we
//     don't fabricate a cluster out of "everyone withdrew from the same CEX."
//
// Pure/injectable: `resolveFunders` takes the rpc + kv functions so it's testable with stubs and reuses the app's
// real Alchemy client + KV in production. `funderLinks` is pure.
import { INFRA } from "./dex.mjs";

const FUNDER_CAP = Number(process.env.FUNDER_CAP || 40); // hard ceiling on per-wallet lookups per token
const MAX_FANOUT = Number(process.env.FUNDER_MAX_FANOUT || 6); // a funder seeding more of our wallets than this = infra

// first inbound source of a wallet (the funder). ETH (external) first, then erc20 quote — whichever arrived first.
async function firstFunder(addr, rpc) {
  const p = { fromBlock: "0x0", toBlock: "latest", toAddress: addr, category: ["external", "erc20"], order: "asc", maxCount: "0x5", excludeZeroValue: true };
  const r = await rpc("alchemy_getAssetTransfers", [p]).catch(() => null);
  for (const t of r?.transfers || []) {
    const from = (t.from || "").toLowerCase();
    if (!from || from === addr || INFRA.has(from)) continue;
    return from;
  }
  return null;
}

// Resolve the funder for the top `cap` wallets, caching each permanently. Returns Map(addr -> funder|null) and a
// count of how many live Alchemy calls were actually made (0 when everything was cached).
export async function resolveFunders(wallets, { rpc, kvGet, kvSet, cap = FUNDER_CAP } = {}) {
  const out = new Map();
  let calls = 0;
  for (const addr of wallets.slice(0, cap)) {
    const a = addr.toLowerCase();
    const key = `funder:${a}`;
    let cached = kvGet ? await kvGet(key).catch(() => null) : null;
    if (cached && Object.prototype.hasOwnProperty.call(cached, "funder")) { out.set(a, cached.funder); continue; }
    const funder = rpc ? await firstFunder(a, rpc) : null;
    calls++;
    out.set(a, funder);
    if (kvSet) kvSet(key, { funder, at: Date.now() }).catch(() => {}); // immutable → cache forever
  }
  return { funders: out, calls };
}

// Pure: turn a wallet→funder map into coordination edges among wallets that share a funder. Star-linked (hub = the
// first co-funded wallet) so k co-funded wallets add k−1 edges, not k². The fan-out guard drops exchange-like
// funders. Restrict to `nodeSet` so we only link wallets already on the map. Returns { edges, groups }.
export function funderLinks(funderMap, nodeSet, { maxFanout = MAX_FANOUT } = {}) {
  const byFunder = new Map();
  for (const [addr, funder] of funderMap) {
    if (!funder || (nodeSet && !nodeSet.has(addr))) continue;
    if (!byFunder.has(funder)) byFunder.set(funder, []);
    byFunder.get(funder).push(addr);
  }
  const edges = [], groups = [];
  for (const [funder, ws] of byFunder) {
    if (ws.length < 2) continue;            // a funder shared by only one of our wallets links nothing
    if (ws.length > maxFanout) continue;    // shared by many → exchange/faucet, not a bundler
    const hub = ws[0];
    for (const a of ws.slice(1)) edges.push({ a: hub, b: a, kind: "funder", via: funder });
    groups.push({ funder, wallets: ws.slice() });
  }
  return { edges, groups };
}
