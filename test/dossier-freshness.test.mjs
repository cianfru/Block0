import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dossierView, LIVE_MIN, MAX_READ_MIN } from "../public/read-freshness.js";

// Execute the actual inline renderer/load path with a tiny DOM and mocked fetch. No network or browser dependency.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*;$/m, "").replace(/\nload\(\);\s*$/, "");
const NOW = Date.UTC(2026, 9, 1, 12), address = "0x" + "c".repeat(40);
function page(readAt) {
  let now = NOW, timer;
  const root = { innerHTML: "" };
  const d = { address, readAt, ageH: 2, sym: "TEST", risk: 30, flags: { holders: 50, insiderSellersNow: 2, insiderDumpNowPct: 4, earlyMovedOutNow: 1, earlyMovedOutPct: 3 }, whales: [] };
  const ctx = vm.createContext({
    dossierView: (x) => dossierView(x, now), LIVE_MIN, MAX_READ_MIN, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    location: { search: `?address=${address}` }, window: {},
    document: { querySelector: s => s === "#root" ? root : null, addEventListener() {} },
    setTimeout: (fn, ms) => { timer = { fn, ms }; return 1; }, clearTimeout() {},
    fetch: async url => url.startsWith("/api/dossier/") ? { ok: true, json: async () => structuredClone(d) } : { ok: false },
  });
  vm.runInContext(script, ctx);
  return { root, ctx, load: () => vm.runInContext("load()", ctx), advance: ms => { now += ms; }, timer: () => timer };
}

test("dossier: fresh -> historical -> expired in an already-open tab", async () => {
  const p = page(NOW);
  await p.load();
  assert.match(p.root.innerHTML, /4\.00% of held supply sold into the pool, last 30 min/);
  assert.equal(typeof p.ctx.window.go, "function");
  assert.equal(p.timer().ms, 45 * 60e3 + 1);
  p.advance(p.timer().ms); await p.timer().fn();
  assert.match(p.root.innerHTML, /Historical read · not current/);
  assert.match(p.root.innerHTML, /Who was moving it/);
  assert.match(p.root.innerHTML, /Not current — read older than 45 min/);
  assert.doesNotMatch(p.root.innerHTML, /4\.00% of held supply sold|Who is moving it/);
  p.advance(p.timer().ms); await p.timer().fn();
  assert.match(p.root.innerHTML, /Read expired/);
  assert.doesNotMatch(p.root.innerHTML, /Early wallets selling|What the chain shows/);
});

test("dossier: a snapshot with no valid read time is never presented as current", async () => {
  for (const readAt of [null, undefined, NOW + 1000]) {
    const p = page(readAt); await p.load();
    assert.match(p.root.innerHTML, /Read expired/);
    assert.equal(p.timer(), undefined);
  }
});
