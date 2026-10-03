import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dossierView, LIVE_MIN, MAX_READ_MIN, SKEW_MS } from "../public/read-freshness.js";

// Execute the actual inline renderer/load path with a tiny DOM and mocked fetch. No network or browser dependency.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*;$/m, "").replace(/\nload\(\);\s*$/, "");
const NOW = Date.UTC(2026, 9, 1, 12), address = "0x" + "c".repeat(40);
function storage() {
  const items = new Map();
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
}
function page(readAt, { start = NOW, localStorage = storage(), token = address } = {}) {
  let now = start, timer;
  const root = { innerHTML: "" };
  const d = { address, readAt, ageH: 2, sym: "TEST", risk: 30, flags: { holders: 50, insiderSellersNow: 2, insiderDumpNowPct: 4, earlyMovedOutNow: 1, earlyMovedOutPct: 3 }, whales: [] };
  const ctx = vm.createContext({
    dossierView: (x, at = now) => dossierView(x, at), LIVE_MIN, MAX_READ_MIN, SKEW_MS, URLSearchParams, localStorage,
    Date: class extends Date { static now() { return now; } },
    location: { search: `?address=${token}` }, window: {},
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
  assert.match(p.root.innerHTML, /4\.00% of wallet-held supply sold into the pool, last 30 min/);
  assert.equal(typeof p.ctx.window.go, "function");
  assert.equal(p.timer().ms, 45 * 60e3 + 1);
  p.advance(p.timer().ms); await p.timer().fn();
  assert.match(p.root.innerHTML, /Historical read · not current/);
  assert.match(p.root.innerHTML, /Who was moving it/);
  assert.match(p.root.innerHTML, /Not current — read older than 45 min/);
  assert.doesNotMatch(p.root.innerHTML, /4\.00% of wallet-held supply sold|Who is moving it/);
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


test("dossier: full document reload preserves full-skew anchor and exact boundaries", async () => {
  const localStorage = storage(), readAt = NOW + SKEW_MS;
  const first = page(readAt, { localStorage });
  await first.load();
  assert.equal(first.timer().ms, LIVE_MIN * 60e3 + 1);

  // A fresh VM recreates all module state, as a full document reload does.
  const reloaded = page(readAt, { start: NOW + 9 * 60e3, localStorage });
  await reloaded.load();
  assert.match(reloaded.root.innerHTML, /Who is moving it/);
  assert.equal(reloaded.timer().ms, 36 * 60e3 + 1);

  for (const minutes of [LIVE_MIN, MAX_READ_MIN]) {
    const boundary = page(readAt, { start: NOW + minutes * 60e3, localStorage });
    await boundary.load();
    assert.match(boundary.root.innerHTML, minutes === LIVE_MIN ? /Who is moving it/ : /Historical read · not current/);
    assert.equal(boundary.timer().ms, 1);
    boundary.advance(1); await boundary.timer().fn();
    assert.match(boundary.root.innerHTML, minutes === LIVE_MIN ? /Historical read · not current/ : /Read expired/);
  }
});

test("dossier: persisted clocks are isolated by address and snapshot identity", async () => {
  const localStorage = storage(), readAt = NOW + SKEW_MS;
  const first = page(readAt, { localStorage }); await first.load();
  const start = NOW + 9 * 60e3;
  for (const options of [
    { token: "0x" + "d".repeat(40), snapshot: readAt },
    { token: address, snapshot: start + SKEW_MS },
  ]) {
    const next = page(options.snapshot, { start, localStorage, token: options.token });
    await next.load();
    assert.equal(next.timer().ms, LIVE_MIN * 60e3 + 1);
  }
  const old = page(readAt, { start, localStorage }); await old.load();
  assert.equal(old.timer().ms, 36 * 60e3 + 1);
});

test("dossier: unavailable storage cannot renew the skew allowance on reload", async () => {
  for (const method of ["getItem", "setItem"]) {
    const localStorage = storage();
    localStorage[method] = () => { throw new Error("Storage blocked"); };
    const readAt = NOW + SKEW_MS;
    const first = page(readAt, { localStorage }); await first.load();
    const reload = page(readAt, { start: NOW + 9 * 60e3, localStorage }); await reload.load();
    assert.equal(reload.timer().ms, 36 * 60e3 + 1);
  }
});
