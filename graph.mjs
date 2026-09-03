// WALLET RELATIONSHIP GRAPH — the "bubble map" data layer. From a token's own transfers it builds the nodes
// (holders, sized by bag), the EDGES that link them (who bought together, who moved the token to whom), and the
// CLUSTERS those links form — so a bundle stops being a number ("4 bundles") and becomes a picture you can look at:
// which specific wallets are one operator, how much of the float they hold, and whether they're moving in concert.
//
// Two link types, both from the token's OWN transfer set (no extra RPC):
//  • BUNDLE  — wallets whose FIRST buy landed in the same block (coordinated snipe). Same rule the verdict uses.
//  • TRANSFER — one holder sent THIS token directly to another (neither side the pool/router). Unrelated holders
//    don't shuffle a fresh launch between themselves; a web of these is the signature of one operator's wallets.
//
// Clusters = connected components over those links. A cluster of ≥2 wallets that (a) bought in the same block or
// (b) passes the token hand-to-hand, holding a real slice of supply, is a bundle to be aware of — flagged.
//
// Roles mirror engine.analyze (sniper = first buy ≤ snipeBlocks after the pool opened; bundle = same-block cohort)
// so a wallet's colour on the bubble map matches its treatment in the card's score. Common-funder links (wallets
// funded from the same source) are a deeper second pass that needs a per-wallet lookup — layered on top, not here.
import { ROUTERS } from "./engine.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const AMM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // RH singleton AMM

class UF {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

export function buildGraph(transfers, opts = {}) {
  const pool = (opts.pool || "").toLowerCase();
  const snipeBlocks = opts.snipeBlocks ?? 3;
  const topN = opts.topN ?? 80;
  const minEdgeAmt = opts.minEdgeAmt ?? 0; // drop dust transfer edges below this token amount
  const windowSec = opts.window ?? 86400;  // "are they selling NOW" horizon for the green/red flow (default 24h)
  const extraInfra = new Set((opts.extraInfra || []).map((a) => a.toLowerCase()));
  const isInfra = (a) => a === ZERO || a === DEAD || a === pool || a === AMM || ROUTERS.has(a) || extraInfra.has(a);
  const isBuy = (e) => e.from === pool || e.from === AMM || ROUTERS.has(e.from);
  const isSell = (e) => e.to === pool || e.to === AMM || ROUTERS.has(e.to);

  // recent-flow window is measured back from the latest transfer seen, so a stale token isn't all-flat
  let maxTs = 0; for (const e of transfers) if (e.ts && e.ts > maxTs) maxTs = e.ts;
  const cutoff = maxTs ? maxTs - windowSec : 0;

  const W = new Map();
  const get = (a) => { let w = W.get(a); if (!w) W.set(a, w = { a, bal: 0, bought: 0, sold: 0, recIn: 0, recOut: 0, first: null, firstBlock: null, sniper: false }); return w; };
  const edgeMap = new Map(); // "lo|hi" -> { a, b, amt, n } : direct holder→holder token moves
  let firstPoolBlock = null;

  for (const e of transfers) {
    if (isBuy(e) && firstPoolBlock == null) firstPoolBlock = e.block;
    const recent = e.ts && e.ts >= cutoff;
    if (!isInfra(e.from)) { const w = get(e.from); w.bal -= e.amt; if (isSell(e)) w.sold += e.amt; if (recent) w.recOut += e.amt; }
    if (!isInfra(e.to)) {
      const w = get(e.to); w.bal += e.amt;
      if (w.first == null) { w.first = e.ts; w.firstBlock = e.block; }
      if (isBuy(e)) w.bought += e.amt;
      if (recent) w.recIn += e.amt;
    }
    // a wallet-to-wallet move (neither side infra, not a pool trade) = a coordination edge
    if (!isInfra(e.from) && !isInfra(e.to) && !isBuy(e) && !isSell(e) && e.from !== e.to && e.amt > 0) {
      const [lo, hi] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
      const k = `${lo}|${hi}`; let ed = edgeMap.get(k);
      if (!ed) edgeMap.set(k, ed = { a: lo, b: hi, amt: 0, n: 0 });
      ed.amt += e.amt; ed.n++;
    }
  }

  if (firstPoolBlock != null) for (const w of W.values()) if (w.firstBlock != null && w.firstBlock <= firstPoolBlock + snipeBlocks && w.bought > 0) w.sniper = true;

  // same-block first-buy bundles
  const byBlock = new Map();
  for (const w of W.values()) if (w.sniper) { const b = w.firstBlock; if (!byBlock.has(b)) byBlock.set(b, []); byBlock.get(b).push(w.a); }
  const bundleGroups = [...byBlock.entries()].filter(([, l]) => l.length >= 2).map(([block, wallets]) => ({ block, wallets }));

  // nodes: the biggest current holders, plus any bundle/sniper wallet (so a coordinated group that already
  // distributed still shows up as the thing to be aware of)
  const held = [...W.values()].reduce((s, w) => s + Math.max(0, w.bal), 0) || 1;
  const holders = [...W.values()].filter((w) => w.bal > 1e-9);
  holders.sort((a, b) => b.bal - a.bal);
  const nodeSet = new Set(holders.slice(0, topN).map((w) => w.a));
  for (const g of bundleGroups) for (const a of g.wallets) nodeSet.add(a);

  const role = (w) => (w.firstBlock != null && bundleGroups.some((g) => g.wallets.includes(w.a))) ? "bundle" : w.sniper ? "sniper" : "holder";
  // flow sign from the recent window: net tokens in − out. "sell"/"buy" needs the move to matter vs the position,
  // so the gate is 1% of the balance (with a tiny floor) — a whale trimming 0.1% is not "distributing".
  const flowOf = (net, bal) => { const g = Math.max(1e-6, bal * 0.01); return net < -g ? "sell" : net > g ? "buy" : "flat"; };
  const nodes = [...nodeSet].map((a) => { const w = W.get(a); const bal = Math.max(0, w.bal); const net = w.recIn - w.recOut; return {
    a, bal: +bal.toFixed(2), pct: +(bal / held * 100).toFixed(2),
    bought: +w.bought.toFixed(2), sold: +w.sold.toFixed(2), first: w.first, firstBlock: w.firstBlock, role: role(w),
    net: +net.toFixed(2), flow: flowOf(net, bal), // green (buy) / red (sell) / neutral, per wallet
  }; });

  // edges: transfer links between two node wallets, above the dust floor
  const edges = [];
  for (const ed of edgeMap.values()) {
    if (ed.amt < minEdgeAmt || !nodeSet.has(ed.a) || !nodeSet.has(ed.b)) continue;
    edges.push({ a: ed.a, b: ed.b, kind: "transfer", amt: +ed.amt.toFixed(2), n: ed.n });
  }
  // bundle links: connect a same-block cohort in a star (to its biggest member) so k wallets add k−1 edges, not k²
  const balOf = (a) => Math.max(0, W.get(a)?.bal || 0);
  for (const g of bundleGroups) {
    const mem = g.wallets.filter((a) => nodeSet.has(a)); if (mem.length < 2) continue;
    const hub = mem.slice().sort((x, y) => balOf(y) - balOf(x))[0];
    for (const a of mem) if (a !== hub) edges.push({ a: hub, b: a, kind: "bundle", block: g.block });
  }

  // clusters: connected components over every link
  const uf = new UF();
  for (const a of nodeSet) uf.find(a);
  for (const e of edges) uf.union(e.a, e.b);
  const byRoot = new Map();
  for (const n of nodes) { const r = uf.find(n.a); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(n); }
  const clusters = [...byRoot.values()].filter((m) => m.length >= 2).map((m, i) => {
    const wallets = m.map((n) => n.a);
    const memberSet = new Set(wallets);
    const bal = m.reduce((s, n) => s + n.bal, 0);
    // cluster net flow = the group's EXTERNAL move over the window (internal shuffles cancel), so the whole
    // cohort lights green (accumulating) or red (the insiders are selling this token now).
    const net = m.reduce((s, n) => s + n.net, 0);
    const hasBundle = edges.some((e) => e.kind === "bundle" && memberSet.has(e.a) && memberSet.has(e.b));
    const hasSniper = m.some((n) => n.role === "sniper" || n.role === "bundle");
    return { id: `c${i}`, size: m.length, wallets, bal: +bal.toFixed(2), pct: +(bal / held * 100).toFixed(2),
      net: +net.toFixed(2), flow: flowOf(net, bal), // the group's green/red verdict
      hasBundle, hasSniper, flag: hasBundle || (m.length >= 3 && bal / held > 0.05) };
  }).sort((x, y) => y.pct - x.pct);

  const clusterOf = new Map();
  clusters.forEach((c) => c.wallets.forEach((a) => clusterOf.set(a, c.id)));
  for (const n of nodes) n.cluster = clusterOf.get(n.a) || null;

  return {
    nodes, edges, clusters,
    stats: {
      nodes: nodes.length, edges: edges.length, clusters: clusters.length,
      bundleGroups: bundleGroups.length,
      flaggedClusters: clusters.filter((c) => c.flag).length,
      biggestClusterPct: clusters.length ? clusters[0].pct : 0,
      firstPoolBlock,
    },
  };
}
