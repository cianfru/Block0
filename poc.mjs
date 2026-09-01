// POC: prove the real-time launch-scanner engine on real chain data, pulled live from public RPC.
// Pulls a token's recent Transfer logs, auto-detects the pool, and computes the "who's moving now" reads.
const RPCS = ["https://eth.drpc.org", "https://rpc.mevblocker.io"];
const UA = { "content-type": "application/json", "user-agent": "curl/8.5.0" };
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer
const TOKEN = (process.argv[2] || "0xA9E8AcF069C58aEc8825542845Fd754e41a9489A").toLowerCase(); // pepecoin default
const DECIMALS = Number(process.argv[3] || 18);
const WINDOW = Number(process.argv[4] || 1500); // blocks back (~5h)

let rid = 1;
async function rpc(method, params, tries = 6) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params });
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(RPCS[t % RPCS.length], { method: "POST", headers: UA, body });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (t === tries - 1) throw e; await new Promise((s) => setTimeout(s, 400 * (t + 1))); }
  }
}
const addr = (topic) => "0x" + topic.slice(26);
const big = (hex) => BigInt(hex || "0x0");
const num = (v) => Number(v) / 10 ** DECIMALS;

(async () => {
  const t0 = Date.now();
  const latest = Number(big(await rpc("eth_blockNumber", [])));
  const from = latest - WINDOW;
  const logs = [];
  for (let b = from; b <= latest; b += 500) {
    const to = Math.min(b + 499, latest);
    const part = await rpc("eth_getLogs", [{ address: TOKEN, topics: [TOPIC], fromBlock: "0x" + b.toString(16), toBlock: "0x" + to.toString(16) }]);
    for (const l of part || []) logs.push(l);
  }
  const pullMs = Date.now() - t0;

  // decode
  const ev = logs.filter((l) => l.topics && l.topics.length === 3).map((l) => ({
    from: addr(l.topics[1]), to: addr(l.topics[2]), amt: num(big(l.data)),
    ts: l.blockTimestamp ? Number(big(l.blockTimestamp)) : null, block: Number(big(l.blockNumber)),
  }));

  // auto-detect the pool = highest-degree counterparty (swaps flow through it)
  const deg = new Map();
  for (const e of ev) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
  const pool = [...deg.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // live reads
  const net = new Map();
  let buys = 0, sells = 0, buyVol = 0, sellVol = 0;
  const firstSeen = new Map();
  for (const e of ev) {
    net.set(e.from, (net.get(e.from) || 0) - e.amt);
    net.set(e.to, (net.get(e.to) || 0) + e.amt);
    if (!firstSeen.has(e.to)) firstSeen.set(e.to, e.ts);
    if (e.from === pool) { buys++; buyVol += e.amt; }
    if (e.to === pool) { sells++; sellVol += e.amt; }
  }
  const sellers = [...net.entries()].filter(([a]) => a !== pool).sort((a, b) => a[1] - b[1]).slice(0, 6);
  const buyers = [...net.entries()].filter(([a]) => a !== pool).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const spanH = ev.length ? ((ev[ev.length - 1].ts - ev[0].ts) / 3600).toFixed(1) : "?";

  const k = (x) => Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(2) + "M" : Math.abs(x) >= 1e3 ? (x / 1e3).toFixed(1) + "k" : x.toFixed(0);
  console.log(`\n=== LIVE SCAN ${TOKEN} ===`);
  console.log(`pulled ${ev.length} transfers over ${WINDOW} blocks (~${spanH}h) in ${pullMs}ms  ·  block ${from}→${latest}`);
  console.log(`auto-detected pool: ${pool}  (${deg.get(pool)} touches)`);
  console.log(`\nWINDOW FLOW:  ${buys} buys (${k(buyVol)}) · ${sells} sells (${k(sellVol)}) · net ${sellVol > buyVol ? "SELL" : "BUY"} pressure ${k(buyVol - sellVol)}`);
  console.log(`active wallets: ${net.size - 1} · new wallets appearing: ${[...firstSeen].length}`);
  console.log(`\nTOP SELLERS (net out, this window):`);
  for (const [a, v] of sellers) console.log(`  ${a}  ${k(v)}`);
  console.log(`TOP BUYERS (net in, this window):`);
  for (const [a, v] of buyers) console.log(`  ${a}  +${k(v)}`);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
