// Minimal, dependency-free JSON-RPC client. Works with any EVM RPC URL (set RPC_URL on Railway to your
// Alchemy/QuickNode key). Falls back to public drpc endpoints so the POC runs with no key. drpc + mevblocker
// enrich logs with blockTimestamp, so we get the time of every transfer without a separate block fetch.
const NATIVE_RPC = "https://rpc.mainnet.chain.robinhood.com";
// RPC_URL may be a single URL or a comma-separated list (primary first, then fallbacks) — redundancy so one
// endpoint's hiccup/throttle doesn't take the product down. Default is the native Robinhood-chain public RPC
// (verified: chain 4663, serves 10k-block eth_getLogs ranges for free).
const ENV_RPCS = (process.env.RPC_URL || "").split(",").map((s) => s.trim()).filter(Boolean);
const PRIMARY = ENV_RPCS[0] || NATIVE_RPC;
// Alchemy's free tier caps eth_getLogs to a 10-block range, so on Alchemy we pull via the enhanced,
// range-uncapped alchemy_getAssetTransfers endpoint instead. Any other RPC (incl. the native RH node) uses
// eth_getLogs, which the RH node serves in wide ranges. Provider is fixed by the PRIMARY endpoint, because the
// transfer-pull method is provider-specific — so fallbacks should be the SAME provider kind as the primary.
export const PROVIDER = /alchemy\.com/i.test(PRIMARY) ? "alchemy" : "generic";
// Assemble the rotation: the configured endpoints, plus the native RH node as a last-resort GENERIC fallback
// (only when we're already on the generic path — never mix a generic node into an Alchemy-enhanced rotation).
const RPCS = [...new Set([...(ENV_RPCS.length ? ENV_RPCS : [NATIVE_RPC]), ...(PROVIDER === "generic" ? [NATIVE_RPC] : [])])];
const UA = { "content-type": "application/json", "user-agent": "curl/8.5.0" };
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const LOGS_RANGE = Number(process.env.LOGS_RANGE || 8000); // generic-RPC eth_getLogs span (RH serves 10k)

let rid = 1;
export async function rpc(method, params, tries = 6) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params });
  let err;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(RPCS[t % RPCS.length], { method: "POST", headers: UA, body });
      if (r.status === 429) { // rate-limited: honour Retry-After, else back off much harder than a transient error
        const ra = Number(r.headers.get("retry-after")) || 0;
        err = new Error("http 429"); await new Promise((s) => setTimeout(s, ra ? ra * 1000 : 1500 * (t + 1))); continue;
      }
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) { err = e; await new Promise((s) => setTimeout(s, 350 * (t + 1))); }
  }
  throw err;
}

export const toNum = (hex) => Number(BigInt(hex || "0x0"));
export const hx = (n) => "0x" + n.toString(16);

export async function latestBlock() { return toNum(await rpc("eth_blockNumber", [])); }

// Is `address` a contract (has deployed bytecode)? Contract-ness is immutable for our purposes, so cache
// forever. Used to keep bots/routers/pools off the "smart money" leaderboard (a contract is not a trader you
// can follow) and to label contract holders on a dossier. Fails OPEN (returns false) so an RPC hiccup never
// wrongly brands a real trader a contract — and a failed lookup is not cached, so it retries next time.
const _codeCache = new Map();
export async function isContract(address) {
  const a = (address || "").toLowerCase();
  if (!a) return false;
  if (_codeCache.has(a)) return _codeCache.get(a);
  let out;
  try { const code = await rpc("eth_getCode", [a, "latest"], 3); out = !!code && code !== "0x" && code !== "0x0"; }
  catch { return false; }
  _codeCache.set(a, out);
  return out;
}

// binary-search the first block where the contract has code = its deploy block
export async function findDeployBlock(address, latest) {
  let lo = 0, hi = latest, ans = latest;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const code = await rpc("eth_getCode", [address, hx(mid)]);
    if (code && code !== "0x") { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

// Pull Transfer logs for a token across [from,to] via eth_getLogs. Walks in LOGS_RANGE spans with a small
// inter-call gap (keeps us under the RH node's burst throttle), and ADAPTIVELY HALVES any span that trips the
// node's 10k-logs-per-result cap or a query timeout — so a busy token in a wide window still completes.
export async function getTransferLogs(address, from, to) {
  const GAP = Number(process.env.LOGS_GAP_MS || 120);
  const MAXR = LOGS_RANGE;
  const out = [];
  const pull = async (lo, hi, again = 0) => {
    try {
      const part = await rpc("eth_getLogs", [{ address, topics: [TRANSFER_TOPIC], fromBlock: hx(lo), toBlock: hx(hi) }], 3);
      for (const l of part || []) out.push(l);
    } catch (e) {
      const m = String(e.message || e).toLowerCase();
      if (m.includes("429") && again < 4) { await new Promise((s) => setTimeout(s, 4000 * (again + 1))); return pull(lo, hi, again + 1); } // throttled: wait it out, same chunk
      if (hi > lo && (m.includes("limit") || m.includes("exceed") || m.includes("timed out") || m.includes("too many") || m.includes("range"))) {
        const mid = (lo + hi) >> 1;
        await pull(lo, mid); await new Promise((s) => setTimeout(s, GAP)); await pull(mid + 1, hi);
      } else throw e;
    }
  };
  for (let b = from; b <= to; b += MAXR) {
    await pull(b, Math.min(b + MAXR - 1, to));
    if (b + MAXR <= to) await new Promise((s) => setTimeout(s, GAP));
  }
  return out;
}

// Alchemy enhanced API: all ERC-20 transfers of `address` in [from,to], paged, no block-range cap.
// Returns already-decoded {from,to,value,rawContract,blockNum,metadata.blockTimestamp}.
export async function getAssetTransfers(address, from, to, pageKey) {
  const params = { fromBlock: hx(from), toBlock: hx(to), contractAddresses: [address],
    category: ["erc20"], order: "asc", withMetadata: true, excludeZeroValue: false, maxCount: "0x3e8" };
  if (pageKey) params.pageKey = pageKey;
  return rpc("alchemy_getAssetTransfers", [params]);
}
