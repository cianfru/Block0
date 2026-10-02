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
    dossierView: (x, at = now) => dossierView(x, at), LIVE_MIN, MAX_READ_MIN, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    location: { search: `?address=${address}` }, window: {},
    document: { querySelector: s => s === "#root" ? root : null, addEventListener() {} },
    setTimeout: (fn, ms) => { timer = { fn, ms }; return 1; }, clearTimeout() {},
    fetch: async url => url.startsWith("/api/dossier/") ? { ok: true, json: async () => structuredClone(d) } : { ok: false },
  });
  vm.runInContext(script, ctx);
  return { root, ctx, load: () => vm.runInContext("load()", ctx), advance: ms => { now += ms; }, timer: () => timer, setReadAt: value => { d.readAt = value; } };
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
  for (const readAt of [null, undefined, NOW + 11 * 60e3]) {          // beyond the 10-min clock-skew allowance
    const p = page(readAt); await p.load();
    assert.match(p.root.innerHTML, /Read expired/);
    assert.equal(p.timer(), undefined);
  }
});


test("dossier: full 10-minute skew does not extend either freshness boundary", async () => {
  const p = page(NOW + 10 * 60e3);
  await p.load();
  assert.match(p.root.innerHTML, /Who is moving it/);
  assert.equal(p.timer().ms, LIVE_MIN * 60e3 + 1);

  // Re-fetching the same snapshot before the transition must retain its normalized clock.
  p.advance(10 * 60e3); await p.load();
  assert.equal(p.timer().ms, 35 * 60e3 + 1);
  p.advance(35 * 60e3); await p.load();
  assert.match(p.root.innerHTML, /Who is moving it/);
  assert.equal(p.timer().ms, 1);
  p.advance(p.timer().ms); await p.timer().fn();
  assert.match(p.root.innerHTML, /Historical read · not current/);
  assert.doesNotMatch(p.root.innerHTML, /4\.00% of held supply sold|Who is moving it/);
  assert.equal(p.timer().ms, (MAX_READ_MIN - LIVE_MIN) * 60e3);

  p.advance(p.timer().ms - 1); await p.load();
  assert.match(p.root.innerHTML, /Historical read · not current/);
  assert.equal(p.timer().ms, 1);
  p.advance(p.timer().ms); await p.timer().fn();
  assert.match(p.root.innerHTML, /Read expired/);
});

test("dossier: exact 45- and 180-minute boundaries transition one millisecond later", async () => {
  for (const minutes of [LIVE_MIN, MAX_READ_MIN]) {
    const p = page(NOW - minutes * 60e3);
    await p.load();
    assert.match(p.root.innerHTML, minutes === LIVE_MIN ? /Who is moving it/ : /Historical read · not current/);
    assert.equal(p.timer().ms, 1);
    p.advance(1); await p.timer().fn();
    assert.match(p.root.innerHTML, minutes === LIVE_MIN ? /Historical read · not current/ : /Read expired/);
  }
});


test("dossier: a newer snapshot starts its own normalized freshness window", async () => {
  const p = page(NOW + 10 * 60e3);
  await p.load();
  p.advance(p.timer().ms); await p.timer().fn();
  assert.match(p.root.innerHTML, /Historical read · not current/);
  p.setReadAt(NOW + 55 * 60e3 + 1);
  await p.load();
  assert.match(p.root.innerHTML, /4\.00% of held supply sold into the pool, last 30 min/);
  assert.equal(p.timer().ms, LIVE_MIN * 60e3 + 1);
});
