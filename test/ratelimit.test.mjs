import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLimiter, makeCoalescer, makeSemaphore, clientIp } from "../ratelimit.mjs";

test("limiter: burst then refuse with a Retry-After, refills over time", () => {
  let t = 0; const lim = makeLimiter({ capacity: 3, perSec: 1, now: () => t });
  assert.equal(lim.take("ip1").ok, true); assert.equal(lim.take("ip1").ok, true); assert.equal(lim.take("ip1").ok, true);
  const r = lim.take("ip1"); assert.equal(r.ok, false); assert.ok(r.retryAfterSec >= 1);
  assert.equal(lim.take("ip2").ok, true);           // keys are independent
  t = 2000; assert.equal(lim.take("ip1").ok, true);   // ~2 tokens refilled
});

test("limiter: sweeps idle buckets so memory stays bounded", () => {
  let t = 0; const lim = makeLimiter({ capacity: 2, perSec: 1, now: () => t });
  for (let i = 0; i < 100; i++) lim.take("k" + i);
  assert.equal(lim.size(), 100);
  t = 10 * 60 * 1000; lim.take("fresh");          // a sweep runs on the next take after 60s of idle
  assert.ok(lim.size() < 100);
});

test("coalescer: concurrent identical keys share ONE execution", async () => {
  const co = makeCoalescer(); let runs = 0;
  const fn = () => new Promise((r) => setTimeout(() => { runs++; r("v"); }, 20));
  const [a, b, c] = await Promise.all([co.run("x", fn), co.run("x", fn), co.run("x", fn)]);
  assert.deepEqual([a, b, c], ["v", "v", "v"]); assert.equal(runs, 1);
  await co.run("x", fn); assert.equal(runs, 2);   // after settle it runs again
  assert.equal(co.inflight(), 0);
});

test("semaphore: caps concurrency, release frees a slot", () => {
  const s = makeSemaphore(2);
  const r1 = s.tryAcquire(), r2 = s.tryAcquire(); assert.ok(r1 && r2);
  assert.equal(s.tryAcquire(), null);              // full → fast refusal, no queueing onto the RPC
  r1(); r1();                                      // double release is harmless
  assert.equal(s.active(), 1); assert.ok(s.tryAcquire());
});

test("clientIp: first hop of x-forwarded-for, else socket", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, socket: {} }), "1.2.3.4");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "9.9.9.9" } }), "9.9.9.9");
});
