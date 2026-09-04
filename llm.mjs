// OpenRouter LLM client — dependency-light, free-model-first, soft-failing.
//
// The one LLM touchpoint in Block0. It does LANGUAGE ONLY over facts we already computed on-chain — it never
// fetches or invents a number (honest numbers are the moat). Callers pass a fully-formed message list and get back
// text; if there's no key, or every model is rate-limited/dead, chat() throws a tagged error and the caller falls
// back to a deterministic result. Nothing here can block the product.
//
// Free models churn and pool-429 constantly (a hard-coded list rots), so we DISCOVER live free models from
// OpenRouter's public /models endpoint (no key needed), order them by context length, and try them in turn with a
// seed/fallback list as anchors. Pin with OPENROUTER_MODEL (one) or OPENROUTER_MODELS (comma list) to skip discovery.

const OR = "https://openrouter.ai/api/v1";
// Seed/fallback free models — anchors in case discovery is unavailable. `:free` endpoints cost nothing.
export const FREE_FALLBACKS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "deepseek/deepseek-chat:free",
  "qwen/qwen-2.5-72b-instruct:free",
];

let _cache = { at: 0, models: null };

// Discover currently-live free chat models, longest-context first. Pure aside from the injected fetch; cached ~10m.
export async function resolveModels(fetchImpl = fetch, { now = Date.now() } = {}) {
  const pin = process.env.OPENROUTER_MODEL;
  if (pin) return [pin];
  const chain = (process.env.OPENROUTER_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (chain.length) return chain;
  if (_cache.models && now - _cache.at < 10 * 60 * 1000) return _cache.models;
  let discovered = [];
  try {
    const r = await fetchImpl(`${OR}/models`, { headers: { "content-type": "application/json" } });
    if (r && r.ok) {
      const j = await r.json();
      discovered = (j.data || [])
        .filter((m) => typeof m.id === "string" && m.id.endsWith(":free"))
        .filter((m) => { const mod = m.architecture?.modality || ""; return !mod || mod.includes("text->text") || mod.includes("text+"); })
        .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
        .map((m) => m.id);
    }
  } catch { /* discovery is best-effort; fall back to the seed list */ }
  // seeds first (known-good), then any freshly discovered ones not already listed
  const seen = new Set(FREE_FALLBACKS);
  const models = [...FREE_FALLBACKS, ...discovered.filter((m) => !seen.has(m))];
  _cache = { at: now, models };
  return models;
}

// Strip inline reasoning some models leak (<think>…</think>) so it never reaches output/validation.
export const stripReasoning = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();

// Run a chat completion. Tries free models in order; skips 404/429 (dead/rate-limited), stops on 401/403 (bad key).
// Returns { text, model }. Throws a tagged Error ("no_key" / "no_model") the caller treats as "use the fallback".
export async function chat(messages, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const key = opts.apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) { const e = new Error("no OPENROUTER_API_KEY"); e.code = "no_key"; throw e; }
  const models = opts.models || await resolveModels(fetchImpl);
  if (!models.length) { const e = new Error("no free models available"); e.code = "no_model"; throw e; }
  const body = {
    messages,
    max_tokens: opts.maxTokens || 700,
    temperature: opts.temperature ?? 0.4,
    reasoning: { effort: "low", exclude: true },        // keep reasoning out of the response (and the bill)
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  };
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}`,
    "http-referer": process.env.PUBLIC_URL || "https://block0.app", "x-title": "Block0" };
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await fetchImpl(`${OR}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...body, model }) });
      if (r.status === 401 || r.status === 403) { const e = new Error(`auth ${r.status}`); e.code = "auth"; throw e; }
      if (!r.ok) { lastErr = new Error(`${model} → ${r.status}`); continue; }   // 404 gone / 429 pooled-limit → next model
      const j = await r.json();
      const text = stripReasoning(j?.choices?.[0]?.message?.content || "");
      if (text) return { text, model };
      lastErr = new Error(`${model} → empty`);
    } catch (e) { if (e.code === "auth") throw e; lastErr = e; }
  }
  const e = new Error(`all models failed: ${lastErr ? lastErr.message : "unknown"}`); e.code = "no_model"; throw e;
}

export const hasKey = () => !!process.env.OPENROUTER_API_KEY;
