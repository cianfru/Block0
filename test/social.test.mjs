import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, applySocial, cadence } from "../social.mjs";

const item = (uid, extra = {}) => ({ uid, kind: "fade", tweet: "hi", ...extra });

test("queue then unqueue", () => {
  let s = emptyState();
  s = applySocial(s, { type: "queue", item: item("a") });
  s = applySocial(s, { type: "queue", item: item("b") });
  assert.deepEqual(s.queue.map((x) => x.uid), ["a", "b"]);
  s = applySocial(s, { type: "unqueue", uid: "a" });
  assert.deepEqual(s.queue.map((x) => x.uid), ["b"]);
});

test("queue ignores an item with no uid (server mints ids)", () => {
  const s = applySocial(emptyState(), { type: "queue", item: { tweet: "x" } });
  assert.equal(s.queue.length, 0);
});

test("move reorders, clamped at the ends", () => {
  let s = { queue: [item("a"), item("b"), item("c")], log: [] };
  s = applySocial(s, { type: "move", uid: "c", dir: -1 });
  assert.deepEqual(s.queue.map((x) => x.uid), ["a", "c", "b"]);
  s = applySocial(s, { type: "move", uid: "a", dir: -1 }); // already top → no-op
  assert.deepEqual(s.queue.map((x) => x.uid), ["a", "c", "b"]);
});

test("posted from queue removes it and logs it newest-first with a timestamp", () => {
  let s = { queue: [item("a"), item("b")], log: [] };
  s = applySocial(s, { type: "posted", uid: "a", now: 1000, url: "http://x" });
  assert.deepEqual(s.queue.map((x) => x.uid), ["b"]);
  assert.equal(s.log[0].uid, "a");
  assert.equal(s.log[0].postedAt, 1000);
  assert.equal(s.log[0].url, "http://x");
});

test("posted ad-hoc (not in queue) still logs", () => {
  const s = applySocial(emptyState(), { type: "posted", item: item("z"), now: 5 });
  assert.equal(s.log[0].uid, "z");
  assert.equal(s.queue.length, 0);
});

test("unpost moves a log entry back to the queue, stripping post metadata", () => {
  let s = { queue: [], log: [{ ...item("a"), postedAt: 5, url: "u" }] };
  s = applySocial(s, { type: "unpost", uid: "a" });
  assert.equal(s.log.length, 0);
  assert.equal(s.queue[0].uid, "a");
  assert.equal(s.queue[0].postedAt, undefined);
  assert.equal(s.queue[0].url, undefined);
});

test("log is capped at 200 newest-first", () => {
  let s = emptyState();
  for (let i = 0; i < 210; i++) s = applySocial(s, { type: "posted", item: item("u" + i), now: i });
  assert.equal(s.log.length, 200);
  assert.equal(s.log[0].uid, "u209"); // newest first
});

test("cadence summarises queue depth + weekly/last posted", () => {
  const now = 10 * 864e5;
  const s = { queue: [item("q")], log: [
    { uid: "a", postedAt: now - 2 * 864e5 },   // 2 days ago (this week)
    { uid: "b", postedAt: now - 9 * 864e5 },   // 9 days ago (not this week)
  ] };
  const c = cadence(s, now);
  assert.equal(c.queued, 1);
  assert.equal(c.posted, 2);
  assert.equal(c.week, 1);
  assert.equal(c.last, now - 2 * 864e5);
  assert.equal(c.lastAgoH, 48);
});

test("reducer is pure — input state is not mutated", () => {
  const s0 = { queue: [item("a")], log: [] };
  const s1 = applySocial(s0, { type: "unqueue", uid: "a" });
  assert.equal(s0.queue.length, 1); // original untouched
  assert.equal(s1.queue.length, 0);
});
