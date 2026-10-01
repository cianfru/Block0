import { test } from "node:test";
import assert from "node:assert/strict";
import { runTick } from "../agent/tick.mjs";
import { makeOrbio } from "../agent/orbio.mjs";
import { canSpend, settle, record, POST_MAX_COST } from "../agent/budget.mjs";
import { dossierView, readFreshness } from "../public/read-freshness.js";
import { boardSnapshot } from "../agent/board-snapshot.mjs";

const NOW = Date.UTC(2026, 9, 1, 12), A = n => "0x" + String(n).padStart(40, "c");
const active = [1, 2].map(n => ({ address: A(n), sym: `T${n}`, mcapUsd: 80000, launchedAt: new Date(NOW - 5 * 3600e3).toISOString() }));
const tweet = { id_str: "m1", full_text: `@block0app ${A(1)}?`, user: { screen_name: "fan" }, tweet_created_at: new Date(NOW).toISOString() };
const published = { result: { status: "published", post_id: "p1", platforms: [{ platformPostUrl: "https://example.invalid/mock" }] }, credit: 0.02 };
const world = (sellers, tool, extra = {}) => ({
  now: NOW, dryRun: false, apiKey: "mock-only",
  orbio: { allAgents: async () => ({ agents: [] }), xAccount: async () => ({ platform: "twitter", username: "block0app", postsLeft: 50, repliesLeft: 100 }), tool },
  pons: { fetchActive: async () => ({ items: active }), fetchGraduated: async () => ({ items: [] }) },
  readToken: async t => ({ sym: t.sym, risk: 30, flags: { insiderSellersNow: sellers, insiderDumpNowPct: 4.1, top10Pct: 38, holders: 300, bundles: 0 } }), ...extra,
});
const noMentions = { result: { tweets: [] }, credit: 0 };

test("budget: two 0.02 posts cannot spend through a 0.038 ceiling", async () => {
  let sends = 0;
  const tool = async name => { if (name === "social.x.posts") return noMentions; sends++; return published; };
  const seed = await runTick(world(0, tool));
  const r = await runTick(world(2, tool, { state: seed.state, now: NOW + 900e3, caps: { maxCreditPerDay: 0.038, postCost: 0 } }));
  assert.equal(sends, 1);
  assert.equal(r.state.budget.credit, 0.02);
  assert.ok(r.out.held.some(x => x.why === "credit ceiling"));
});

test("budget: reservations survive failure/async/invalid settlement; known costs refund only the excess", () => {
  const s = record(null, { now: NOW, credit: POST_MAX_COST });
  for (const r of [{}, { credit: null }, { credit: NaN }, { credit: -1 }, { credit: 1 }, { credit: 0, running: true }])
    assert.equal(settle(s, POST_MAX_COST, r, NOW).credit, 0.02);
  assert.equal(settle(s, POST_MAX_COST, { credit: 0.0187 }, NOW).credit, 0.0187);
  assert.equal(canSpend(s, 0.02, { now: NOW, caps: { maxCreditPerDay: 0.0399 } }), false);
  assert.equal(canSpend(s, 0.02, { now: NOW, caps: { maxCreditPerDay: 0.04 } }), true);
});

test("budget: thrown and failed post requests still consume their reserved or settled credit", async () => {
  for (const throws of [true, false]) {
    let sends = 0;
    const tool = async name => {
      if (name === "social.x.posts") return noMentions;
      sends++;
      if (throws) throw new Error("ambiguous timeout");
      return { result: { status: "failed" }, credit: 0.02 };
    };
    const seed = await runTick(world(0, tool));
    const r = await runTick(world(2, tool, { state: seed.state, now: NOW + 900e3, caps: { maxCreditPerDay: 0.04 } }));
    assert.equal(sends, 2);
    assert.equal(r.state.budget.credit, 0.04);
    assert.equal(r.out.posted.length, 0);
  }
});

test("reply: confirmed failure retries after 15min, at most three attempts; never marked answered", async () => {
  let sends = 0;
  const tool = async name => {
    if (name === "social.x.posts") return { result: { tweets: [tweet] }, credit: 0 };
    sends++; return { result: { status: "failed", post_id: "failed" }, credit: 0 };
  };
  let state;
  for (const minutes of [0, 1, 15, 30, 45]) {
    const r = await runTick(world(0, tool, { state, now: NOW + minutes * 60e3 }));
    state = r.state;
    assert.equal(state.answered.m1, undefined);
    assert.equal(r.out.replies.length, 0);
  }
  assert.equal(sends, 3);
  assert.equal(state.replyAttempts.m1.status, "failed");
});

test("reply: pending send is reconciled by status, not resent", async () => {
  let sends = 0, statuses = 0;
  const tool = async name => {
    if (name === "social.x.posts") return { result: { tweets: [tweet] }, credit: 0 };
    if (name === "social.post.status") { statuses++; return published; }
    sends++; return { result: { status: "pending", post_id: "p1" }, credit: null, running: true };
  };
  const first = await runTick(world(0, tool));
  assert.equal(first.state.answered.m1, undefined);
  assert.equal(first.state.budget.credit, 0.02);
  const next = await runTick(world(0, tool, { state: first.state, now: NOW + 900e3 }));
  assert.equal(sends, 1); assert.equal(statuses, 1);
  assert.ok(next.state.answered.m1);
  assert.equal(next.out.replies.length, 1);
});

test("reply: timeout or async send without an id stays pending and is not duplicated", async () => {
  for (const throws of [true, false]) {
    let sends = 0;
    const tool = async name => {
      if (name === "social.x.posts") return { result: { tweets: [tweet] }, credit: 0 };
      sends++;
      if (throws) throw new Error("timeout");
      return { result: null, running: true, credit: null };
    };
    const first = await runTick(world(0, tool));
    const next = await runTick(world(0, tool, { state: first.state, now: NOW + 900e3 }));
    assert.equal(sends, 1);
    assert.equal(next.state.replyAttempts.m1.status, "pending");
    assert.equal(next.state.answered.m1, undefined);
    assert.equal(next.state.budget.credit, 0.02);
  }
});

test("client: async post handles survive; execution ids are never used as post ids", async () => {
  for (const body of [{ id: "execution", status: "running" }, { result: { post_id: "post", status: "pending" } }, { post_id: "post", status: "pending" }]) {
    const client = makeOrbio({ apiKey: "mock", fetch: async () => ({ status: 202, json: async () => body }) });
    const r = await client.tool("social.post", {}, "0.02");
    assert.equal(r.running, true);
    assert.equal(r.result?.post_id ?? null, body.id ? null : "post");
  }
});

test("reply: reconciliation is bounded and rotates; old uncertain replies need review", async () => {
  let checks = 0;
  const tool = async name => {
    if (name === "social.x.posts") return noMentions;
    checks++; return { result: { status: "pending" }, credit: 0 };
  };
  const replyAttempts = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), { status: "pending", postId: "p" + i, at: NOW, attempts: 1 }]));
  const first = await runTick(world(0, tool, { state: { replyAttempts } }));
  assert.equal(checks, 20);
  assert.equal(first.state.replyAttempts[24].checkedAt, undefined);
  const next = await runTick(world(0, tool, { state: first.state, now: NOW + 900e3 }));
  assert.equal(next.state.replyAttempts[24].checkedAt, NOW + 900e3);
  const old = await runTick(world(0, tool, { state: next.state, now: NOW + 2 * 86400e3 }));
  assert.ok(Object.values(old.state.replyAttempts).some(a => a.status === "needs-review"));
  assert.equal(checks, 40); // no status calls for expired attempts
});

test("reply: budget includes mention read cap and respects platform replies left", async () => {
  let sends = 0;
  const tool = async name => {
    if (name === "social.x.posts") return { result: { tweets: [tweet] }, credit: 0.005 };
    sends++; return published;
  };
  await runTick(world(0, tool, { caps: { maxCreditPerDay: 0.024 } }));
  const w = world(0, tool);
  w.orbio.xAccount = async () => ({ platform: "twitter", username: "block0app", repliesLeft: 0 });
  await runTick(w);
  assert.equal(sends, 0);
});

test("freshness: board and dossier agree at 45min and 3h; missing/future clocks fail closed", () => {
  const token = { address: A(1), readAt: NOW, flags: { insiderSellersNow: 2, insiderDumpNowPct: 4, earlyMovedOutNow: 1, earlyMovedOutPct: 2, holders: 300 } };
  for (const ageMs of [0, 45 * 60e3, 45 * 60e3 + 1, 180 * 60e3, 180 * 60e3 + 1]) {
    const d = dossierView(token, NOW + ageMs);
    const b = boardSnapshot({ a: token }, null, { now: NOW + ageMs }).cooking[0];
    if (d.expired) assert.equal(b, undefined);
    else { assert.equal(d.stale, b.stale); assert.deepEqual(d.flags, b.flags); }
    assert.equal(d.flags.insiderSellersNow, d.stale ? null : 2);
  }
  assert.equal(token.flags.insiderSellersNow, 2);
  for (const readAt of [undefined, null, 0, NaN, Infinity, NOW + 1]) assert.equal(readFreshness(readAt, NOW).expired, true);
});
