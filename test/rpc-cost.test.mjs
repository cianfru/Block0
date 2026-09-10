// A $50 Alchemy bill for one week of a project that has not shipped a validated result. These pin the two things
// that keep the bill at zero: a metered endpoint cannot be reached without an explicit opt-in, and the most
// expensive read in the system (market cap: a supply call, a transfer lookup, then a receipt per swap) does not
// re-run for every token on every board pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { computeMcap, _resetMcapCache } from "../intel.mjs";

const ALCHEMY = "https://eth-mainnet.g.alchemy.com/v2/TESTKEY";
// rpc.mjs resolves its endpoints once at import, so each case needs its own process
const status = (env) => JSON.parse(execFileSync(process.execPath,
  ["-e", 'import("./rpc.mjs").then(m => console.log(JSON.stringify(m.RPC_STATUS)))'],
  { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, ...env }, encoding: "utf8" })
  .trim().split("\n").at(-1));

test("a metered endpoint is unreachable without an explicit opt-in", () => {
  const guarded = status({ RPC_URL: ALCHEMY, ALLOW_BILLABLE_RPC: "" });
  assert.equal(guarded.metered, false, "the configured Alchemy URL is not used");
  assert.equal(guarded.provider, "generic");
  assert.equal(guarded.meteredRejected, 1, "and the service reports that it ignored it");
});

test("the opt-in still works, so this is a default and not a wall", () => {
  const opted = status({ RPC_URL: ALCHEMY, ALLOW_BILLABLE_RPC: "1" });
  assert.equal(opted.metered, true);
  assert.equal(opted.provider, "alchemy");
});

test("with nothing configured it runs on the free native node", () => {
  const d = status({ RPC_URL: "", ALLOW_BILLABLE_RPC: "" });
  assert.equal(d.provider, "generic");
  assert.equal(d.metered, false);
});

test("a caller that already knows the supply is never charged to read it again", async () => {
  _resetMcapCache();
  const calls = [];
  const _rpc = async (m) => { calls.push(m); return m === "eth_getTransactionReceipt" ? { logs: [] } : "0x0"; };
  await computeMcap("0x" + "1".repeat(40), 3000, { supply: 1e9, _rpc, _recent: async () => [] });
  assert.deepEqual(calls, [], "the DEX scan already read totalSupply off the free node");
});

test("market cap is cached, so a board pass every five minutes does not re-price every token", async () => {
  _resetMcapCache();
  const addr = "0x" + "2".repeat(40);
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  let receipts = 0;
  // a receipt carrying both legs of one swap: 1 token out, $2 of USDG in → a real price sample
  const _rpc = async (m) => {
    if (m !== "eth_getTransactionReceipt") return "0x0";
    receipts++;
    return { logs: [{ topics: [TRANSFER], address: addr, data: "0x" + (10n ** 18n).toString(16) },
                    { topics: [TRANSFER], address: USDG, data: "0x" + (2n * 10n ** 6n).toString(16) }] };
  };
  const _recent = async () => ["0xdead"];
  const opts = { supply: 1e9, _rpc, _recent, ttlMs: 60000 };
  const first = await computeMcap(addr, 3000, opts);
  assert.equal(first.price, 2, "the swap prices the token at $2");
  assert.equal(first.mcap, 2e9);
  const after1 = receipts;
  await computeMcap(addr, 3000, opts);
  await computeMcap(addr, 3000, opts);
  assert.ok(after1 > 0, "the first call actually reads receipts");
  assert.equal(receipts, after1, "later calls inside the TTL read nothing");
});

test("a failed read is not cached, so a zero market cap is retried rather than frozen", async () => {
  _resetMcapCache();
  const addr = "0x" + "3".repeat(40);
  let attempts = 0;
  const _recent = async () => { attempts++; return []; };          // no swaps found → zero samples
  const opts = { supply: 1e9, _rpc: async () => "0x0", _recent, ttlMs: 60000 };
  await computeMcap(addr, 3000, opts);
  await computeMcap(addr, 3000, opts);
  assert.equal(attempts, 2, "an unknown price is not a fact worth remembering for fifteen minutes");
});
