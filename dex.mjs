// DEX discovery — find tokens listed DIRECTLY on the Robinhood-Chain AMM / Uniswap factories, not only via Pons.
//
// The forensic engine is launchpad-agnostic: it verdicts any token from its transfer history. The only thing Pons
// gave us that a raw DEX token doesn't is DISCOVERY (which tokens exist) + metadata. This module supplies discovery
// by scanning pool-creation events on-chain, so the board can cover the whole chain, and the winner-study cohort
// can grow past the handful of Pons graduations (the real unlock for the model).
//
// Wide log scans use a dedicated RPC (default the native RH node, which serves 10k-block eth_getLogs ranges — far
// better than Alchemy's 10-block cap for this). Pool-creation event signatures are CONFIGURABLE because they differ
// by DEX version; `traceEvents` reports what actually fires so we wire discovery to the real ones, not guesses.
const DEX_RPC = (process.env.DEX_RPC || "https://rpc.mainnet.chain.robinhood.com").replace(/\/$/, "");
const AMM = (process.env.DEX_AMM || "0x8366a39cc670b4001a1121b8f6a443a643e40951").toLowerCase(); // RH singleton AMM
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73", USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const QUOTES = new Set([WETH, USDG, "0x0000000000000000000000000000000000000000"]);
const RANGE = Number(process.env.DEX_LOGS_RANGE || 9000), GAP = Number(process.env.DEX_LOGS_GAP_MS || 120);

// Known Uniswap pool-creation topic0s (same across chains — the event ABI is fixed). v4's Initialize varies by
// release, so it's discovered via traceEvents rather than assumed.
const KNOWN = {
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9": { dex: "uniswap-v2", ev: "PairCreated", tokenTopics: [1, 2] }, // (token0,token1 indexed)
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118": { dex: "uniswap-v3", ev: "PoolCreated", tokenTopics: [1, 2] }, // (token0,token1 indexed; fee indexed)
};

let rid = 1;
async function rpc(method, params, tries = 5) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params });
  let err;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(DEX_RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": "curl/8.5.0" }, body });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) { err = e; await new Promise((s) => setTimeout(s, 300 * (t + 1))); }
  }
  throw err;
}
const hx = (n) => "0x" + Number(n).toString(16);
const toNum = (h) => Number(BigInt(h || "0x0"));
const addrOf = (topic) => "0x" + (topic || "").slice(26).toLowerCase();

// walk eth_getLogs across [from,to] in RANGE spans, adaptively halving on limit/timeout errors
async function logsWide(filterBase, from, to) {
  const out = [];
  const pull = async (lo, hi) => {
    try {
      const part = await rpc("eth_getLogs", [{ ...filterBase, fromBlock: hx(lo), toBlock: hx(hi) }], 3);
      for (const l of part || []) out.push(l);
    } catch (e) {
      const m = String(e.message || e).toLowerCase();
      if (hi > lo && /limit|exceed|too many|range|timeout|timed out/.test(m)) {
        const mid = (lo + hi) >> 1; await pull(lo, mid); await new Promise((s) => setTimeout(s, GAP)); await pull(mid + 1, hi);
      } else throw e;
    }
  };
  for (let b = from; b <= to; b += RANGE) { await pull(b, Math.min(b + RANGE - 1, to)); if (b + RANGE <= to) await new Promise((s) => setTimeout(s, GAP)); }
  return out;
}

export async function latestBlock() { return toNum(await rpc("eth_blockNumber", [])); }

// TRACE: histogram of event topic0s emitted by the AMM (and any extra addresses) over the last `blocks`, so we can
// SEE which event is pool-creation and how its token addresses sit in the topics. Run this first on a new chain.
export async function traceEvents({ blocks = 40000, address = AMM } = {}) {
  const latest = await latestBlock();
  const from = Math.max(0, latest - blocks);
  const logs = await logsWide({ address }, from, latest);
  const byTopic = new Map();
  for (const l of logs) {
    const t0 = (l.topics && l.topics[0]) || "0x?";
    let e = byTopic.get(t0); if (!e) byTopic.set(t0, e = { topic0: t0, count: 0, nTopics: (l.topics || []).length, known: KNOWN[t0] || null, sampleTopics: l.topics, sampleData: (l.data || "").slice(0, 66) });
    e.count++;
  }
  return { address, scannedBlocks: blocks, fromBlock: from, latestBlock: latest, totalLogs: logs.length,
    events: [...byTopic.values()].sort((a, b) => b.count - a.count) };
}

// DISCOVER: scan for pool-creation events (known v2/v3 topic0s + any topic0s passed in `initTopics` for the v4
// singleton once identified), decode the two token addresses from indexed topics, strip quote assets → the set of
// tokens listed on the DEX. Returns candidates with the block/time they were listed.
export async function discoverDex({ blocks = 200000, address = AMM, initTopics = [] } = {}) {
  const topicSet = new Set([...Object.keys(KNOWN), ...initTopics.map((t) => t.toLowerCase())]);
  const latest = await latestBlock();
  const from = Math.max(0, latest - blocks);
  // one wide scan filtered to the AMM/factory address; classify each log by its topic0
  const logs = await logsWide({ address }, from, latest);
  const tokens = new Map();
  for (const l of logs) {
    const t0 = (l.topics && l.topics[0] || "").toLowerCase();
    if (!topicSet.has(t0)) continue;
    const spec = KNOWN[t0] || { dex: "amm-v4", ev: "Initialize", tokenTopics: [2, 3] }; // v4: currency0/1 are topics 2,3
    for (const ti of spec.tokenTopics) {
      const a = addrOf(l.topics?.[ti]);
      if (!a || a.length !== 42 || QUOTES.has(a)) continue;
      if (!tokens.has(a)) tokens.set(a, { address: a, dex: spec.dex, block: toNum(l.blockNumber), tx: l.transactionHash });
    }
  }
  return { fromBlock: from, latestBlock: latest, scannedBlocks: blocks, count: tokens.size, tokens: [...tokens.values()] };
}

export const DEX_CONFIG = { rpc: DEX_RPC, amm: AMM, range: RANGE };
