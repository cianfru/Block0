// Minimal, dependency-free JSON-RPC client. Works with any EVM RPC URL (set RPC_URL on Railway to your
// Alchemy/QuickNode key). Falls back to public drpc endpoints so the POC runs with no key. drpc + mevblocker
// enrich logs with blockTimestamp, so we get the time of every transfer without a separate block fetch.
const ENV_RPC = (process.env.RPC_URL || "").trim();
const RPCS = ENV_RPC ? [ENV_RPC] : ["https://eth.drpc.org", "https://rpc.mevblocker.io"];
const UA = { "content-type": "application/json", "user-agent": "curl/8.5.0" };
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

let rid = 1;
export async function rpc(method, params, tries = 6) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params });
  let err;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(RPCS[t % RPCS.length], { method: "POST", headers: UA, body });
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

// pull Transfer logs for a token across [from,to], chunked to stay under RPC range/row caps
export async function getTransferLogs(address, from, to, chunk = 500) {
  const out = [];
  for (let b = from; b <= to; b += chunk) {
    const end = Math.min(b + chunk - 1, to);
    const part = await rpc("eth_getLogs", [{ address, topics: [TRANSFER_TOPIC], fromBlock: hx(b), toBlock: hx(end) }]);
    for (const l of part || []) out.push(l);
  }
  return out;
}
