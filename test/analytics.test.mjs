// The pilot's measurements have to survive contact with a browser: reloads, retries and hostile query strings.
// These pin the two questions the pilot exists to answer — DEPTH (distinct tokens) and RETURN (distinct days) —
// and the sanitisation that keeps an address or a cohort code from becoming an injection surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { track } from "../analytics.mjs";
import { getJSON, sHas } from "../store/kv.mjs";
import { createHash } from "node:crypto";

// the store key is salted-hashed by ip, exactly as analytics.mjs derives it — raw ips are never stored
const iphOf = (ip) => createHash("sha256").update(ip + (process.env.INTEL_SALT || "block0-intel")).digest("hex").slice(0, 16);

process.env.INTEL_GEO = "0";                       // no outbound lookup in tests
const req = (ip = "203.0.113.7") => ({ headers: { "x-forwarded-for": ip, host: "block0.app" }, socket: {} });
const agg = () => getJSON("intel:agg");

test("a token view records the token, and a reload cannot inflate the depth count", async () => {
  const T = "0x" + "a".repeat(40);
  await track({ type: "token_view", path: "/token", token: T, pilot: "alpha" }, req("198.51.100.1"));
  await track({ type: "token_view", path: "/token", token: T, pilot: "alpha" }, req("198.51.100.1"));
  const ev = (await getJSON("intel:events")) || [];
  const mine = ev.filter((e) => e.token === T);
  assert.ok(mine.length >= 2, "both views are logged as events");
  assert.equal(mine[0].pilot, "alpha");
  // DEPTH is a set of tokens per visitor, so two views of one token is still one token
  const iph = iphOf("198.51.100.1");
  assert.equal(await sHas(`intel:seen:${iph}`, T), true);
  assert.equal(((await getJSON(`intel:seen:${iph}`)) || []).length, 1, "a reload does not add depth");

  // ...and a second, different token does
  const U = "0x" + "d".repeat(40);
  await track({ type: "token_view", path: "/token", token: U, pilot: "alpha" }, req("198.51.100.1"));
  assert.equal(((await getJSON(`intel:seen:${iph}`)) || []).length, 2);

  // RETURN is a set of days, so repeat visits on one day count once
  assert.equal(((await getJSON(`intel:days:${iph}`)) || []).length, 1);
});

test("a cohort code is accepted only in a safe shape", async () => {
  await track({ type: "pageview", path: "/token", pilot: "<script>" }, req("198.51.100.2"));
  await track({ type: "pageview", path: "/token", pilot: "beta-2" }, req("198.51.100.3"));
  const a = await agg();
  assert.ok(a.pilots && a.pilots["beta-2"] >= 1, "a well-formed code is counted");
  assert.ok(!a.pilots["<script>"], "a malformed code is dropped, not stored");
});

test("a malformed token address is dropped rather than stored", async () => {
  await track({ type: "token_view", path: "/token", token: "not-an-address" }, req("198.51.100.4"));
  const ev = (await getJSON("intel:events")) || [];
  assert.ok(!ev.some((e) => e.token === "not-an-address"));
});

test("feedback lands in its own list so pageview traffic cannot trim it away", async () => {
  const T = "0x" + "b".repeat(40);
  await track({ type: "feedback", path: "/token", token: T, answer: "no", note: "wanted holder history" }, req("198.51.100.5"));
  const fb = (await getJSON("intel:feedback")) || [];
  const mine = fb.find((f) => f.token === T);
  assert.ok(mine, "the reply is recorded");
  assert.equal(mine.answer, "no");
  assert.equal(mine.note, "wanted holder history");
});

test("an unknown event type degrades to a pageview rather than being stored verbatim", async () => {
  await track({ type: "../../etc/passwd", path: "/token" }, req("198.51.100.6"));
  const ev = (await getJSON("intel:events")) || [];
  assert.ok(!ev.some((e) => e.type === "../../etc/passwd"));
});

test("a note is bounded, so one reply cannot fill the store", async () => {
  const T = "0x" + "c".repeat(40);
  await track({ type: "feedback", path: "/token", token: T, answer: "yes", note: "x".repeat(5000) }, req("198.51.100.7"));
  const fb = (await getJSON("intel:feedback")) || [];
  assert.ok(fb.find((f) => f.token === T).note.length <= 400);
});
