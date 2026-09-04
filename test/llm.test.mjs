import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, resolveModels, stripReasoning, FREE_FALLBACKS } from "../llm.mjs";

const okResp = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const errResp = (status) => ({ ok: false, status, json: async () => ({}) });

test("stripReasoning removes leaked <think> blocks", () => {
  assert.equal(stripReasoning("<think>hmm</think>answer"), "answer");
  assert.equal(stripReasoning("plain"), "plain");
});

test("resolveModels honours a pinned model and a pinned chain", async () => {
  process.env.OPENROUTER_MODEL = "pinned/one:free";
  assert.deepEqual(await resolveModels(async () => okResp("")), ["pinned/one:free"]);
  delete process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_MODELS = "a:free, b:free";
  assert.deepEqual(await resolveModels(async () => okResp("")), ["a:free", "b:free"]);
  delete process.env.OPENROUTER_MODELS;
});

test("resolveModels discovers free chat models and puts seeds first", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [
    { id: "paid/model", context_length: 99999 },
    { id: "disco/big:free", context_length: 40000, architecture: { modality: "text->text" } },
    { id: "disco/small:free", context_length: 8000, architecture: { modality: "text->text" } },
  ] }) });
  const models = await resolveModels(fetchImpl, { now: Date.now() + 999_999_999 });   // bypass cache
  assert.ok(models.slice(0, FREE_FALLBACKS.length).every((m, i) => m === FREE_FALLBACKS[i]));  // seeds anchor
  assert.ok(models.includes("disco/big:free") && models.includes("disco/small:free"));
  assert.ok(!models.includes("paid/model"));                                          // non-free excluded
});

test("chat throws no_key when there is no API key", async () => {
  const prev = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(() => chat([{ role: "user", content: "hi" }], { fetch: async () => okResp("x") }), (e) => e.code === "no_key");
  if (prev) process.env.OPENROUTER_API_KEY = prev;
});

test("chat returns text + model on success", async () => {
  const r = await chat([{ role: "user", content: "hi" }], { apiKey: "k", models: ["m/x:free"], fetch: async () => okResp("<think>x</think>hello") });
  assert.equal(r.text, "hello");
  assert.equal(r.model, "m/x:free");
});

test("chat skips a rate-limited model and uses the next", async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? errResp(429) : okResp("second model answered"));
  const r = await chat([{ role: "user", content: "hi" }], { apiKey: "k", models: ["a:free", "b:free"], fetch: fetchImpl });
  assert.equal(r.text, "second model answered");
  assert.equal(r.model, "b:free");
});

test("chat stops immediately on an auth error", async () => {
  await assert.rejects(() => chat([{ role: "user", content: "hi" }], { apiKey: "bad", models: ["a:free", "b:free"], fetch: async () => errResp(401) }), (e) => e.code === "auth");
});
