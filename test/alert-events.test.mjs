import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEvents, formatEvent } from "../alert-events.mjs";

const base = (o = {}) => ({ address: "0xabc", sym: "TOK", mcapUsd: 50000, ageH: 2, risk: 20, blueprint: 70, corridor: { status: "on-track" },
  flags: { insiderSellersNow: 0, insiderDumpNowPct: 0, holders: 120, bundles: 0, top10Pct: 40, snipers: 0 }, smart: { count: 0 }, ...o });

test("first sight seeds silently — no cold-start backlog blast", () => {
  const r = detectEvents({}, [base({ flags: { ...base().flags, insiderSellersNow: 3 }, smart: { count: 4 } })], { now: 1000 });
  assert.equal(r.events.length, 0);
  assert.ok(r.next["0xabc"]);
});

test("insiders STARTING to sell fires once, then respects the cooldown", () => {
  const t0 = 1000;
  const s1 = detectEvents({}, [base()], { now: t0 }).next;
  const r = detectEvents(s1, [base({ flags: { ...base().flags, insiderSellersNow: 2, insiderDumpNowPct: 3.1 } })], { now: t0 + 1 });
  assert.equal(r.events.length, 1); assert.equal(r.events[0].kind, "insider-dump"); assert.match(r.events[0].headline, /2 insider wallets/);
  // still selling next cycle → not a NEW transition, no re-fire
  const r2 = detectEvents(r.next, [base({ flags: { ...base().flags, insiderSellersNow: 2 } })], { now: t0 + 2, lastFired: r.lastFired });
  assert.equal(r2.events.length, 0);
  // stops, then starts again inside the cooldown → suppressed
  const r3 = detectEvents(r2.next, [base()], { now: t0 + 3, lastFired: r2.lastFired });
  const r4 = detectEvents(r3.next, [base({ flags: { ...base().flags, insiderSellersNow: 1 } })], { now: t0 + 4, lastFired: r3.lastFired });
  assert.equal(r4.events.length, 0);
  // …but after the cooldown it can fire again
  const r5 = detectEvents(r3.next, [base({ flags: { ...base().flags, insiderSellersNow: 1 } })], { now: t0 + 7 * 3600 * 1000, lastFired: r3.lastFired });
  assert.equal(r5.events.length, 1);
});

test("smart-money convergence fires when the count REACHES 2, not on every cycle", () => {
  const s1 = detectEvents({}, [base({ smart: { count: 1 } })], { now: 1 }).next;
  const r = detectEvents(s1, [base({ smart: { count: 2 } })], { now: 2 });
  assert.equal(r.events.length, 1); assert.equal(r.events[0].kind, "smart-convergence"); assert.equal(r.events[0].sev, "good");
  const r2 = detectEvents(r.next, [base({ smart: { count: 3 } })], { now: 3, lastFired: r.lastFired });
  assert.equal(r2.events.length, 0);
});

test("clean-launch fires when a fresh launch clears the bar; dust and old coins never alert", () => {
  const s1 = detectEvents({}, [base({ ageH: 0.2 })], { now: 1 }).next;       // too young → not clean yet
  const r = detectEvents(s1, [base({ ageH: 1 })], { now: 2 });
  assert.equal(r.events.length, 1); assert.equal(r.events[0].kind, "clean-launch");
  const dust = detectEvents({ "0xabc": { sellers: 0, smart: 0, clean: false } }, [base({ mcapUsd: 100, flags: { ...base().flags, insiderSellersNow: 1 } })], { now: 3 });
  assert.equal(dust.events.length, 0);
  const old = detectEvents({ "0xabc": { sellers: 0, smart: 0, clean: false } }, [base({ ageH: 500, flags: { ...base().flags, insiderSellersNow: 1 } })], { now: 3 });
  assert.equal(old.events.length, 0);
});

test("formatEvent carries the numbers, the link and the honesty line", () => {
  const ev = { kind: "insider-dump", sev: "bad", sym: "TOK", address: "0xabc", mcapUsd: 50000, ageH: 0.5, headline: "2 insider wallets started selling" };
  const s = formatEvent(ev, "https://block0.app");
  assert.match(s, /TOK/); assert.match(s, /\$50k/); assert.match(s, /token\?address=0xabc/); assert.match(s, /Signal, not proof/);
});
