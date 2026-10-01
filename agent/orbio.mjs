// Thin Orbio client. Public reads need no key; metered tools need ORBIO_API_KEY and always send max_cost (string,
// $CREDIT) so a single call can never spend more than we said. 401 → bad key, 402 → out of balance, 409 → the social
// account is not connected: all throw a typed OrbioError the tick turns into "stop posting for the day", never a
// retry loop. Response shape (orbio.so/launchpad/docs.md, 2026-10-01): a settled 200 is { id, tool, result,
// cost: { credit } }; a 202 is { status: "running" } and must NOT be resubmitted.
export const ORBIO_API = "https://api.orbio.so";
export const FREE = "0.000000";

export class OrbioError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export function makeOrbio({ apiKey = null, fetch: f = fetch, base = ORBIO_API } = {}) {
  async function publicGet(path) {
    const r = await f(base + path, { headers: { accept: "application/json" } });
    if (!r.ok) throw new OrbioError("http", `GET ${path} → ${r.status}`);
    return r.json();
  }
  // → { result, credit, running }. credit is what the call settled at (null while settling or unknown).
  async function tool(name, args, maxCost) {
    if (!apiKey) throw new OrbioError("nokey", `tool ${name} needs ORBIO_API_KEY`);
    if (maxCost == null) throw new OrbioError("nocap", `tool ${name} called without max_cost`);
    const r = await f(`${base}/api/v1/tools/${name}`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...args, max_cost: String(maxCost) }) });
    const body = await r.json().catch(() => ({}));
    const why = body?.error?.message || body?.error || body?.message || "";
    if (r.status === 401) throw new OrbioError("auth", "Orbio rejected the API key (401)");
    if (r.status === 402) throw new OrbioError("balance", "Orbio balance too low (402)");
    if (r.status === 409) throw new OrbioError("connect", `social account not connected in Orbio (409)${body?.connect_url ? " — " + body.connect_url : ""}`, { connectUrl: body?.connect_url ?? null });
    // Keep a post handle if supplied, but never mistake a tool-execution id for a social post id.
    if (r.status === 202) return { result: body?.result ?? (body?.post_id ? body : null), credit: null, running: true };
    if (!r.ok) throw new OrbioError(r.status === 429 ? "rate" : r.status === 400 ? "args" : "http", `tool ${name} → ${r.status}${why ? ": " + String(why).slice(0, 200) : ""}`);
    const credit = body?.cost?.credit != null ? Number(body.cost.credit) : null;
    return { result: body?.result ?? body, credit, running: false };
  }
  return {
    publicGet, tool,
    // every agent, newest first (the API pages at 200)
    async allAgents() {
      const out = []; let root = null;
      for (let offset = 0; offset < 5000; offset += 200) {
        const d = await publicGet(`/api/protocol/agents?sort=newest&limit=200&offset=${offset}`);
        root ??= d; out.push(...(d.data || []));
        if (!d.data?.length || out.length >= (d.page?.total ?? 0)) break;
      }
      return { agents: out, orbioUsd: root?.orbioMicroUsd != null ? Number(root.orbioMicroUsd) / 1e6 : null, block: root?.block ?? null };
    },
    // the connected X account (free): { platform, username, postsLeft, repliesLeft } or null when none is connected
    async xAccount() {
      const { result } = await tool("social.accounts", {}, FREE);
      const a = (result?.accounts || []).find((x) => /^(twitter|x)$/i.test(x.platform || ""));
      return a ? { platform: a.platform, username: a.username || null, postsLeft: a.today?.posts_left ?? null, repliesLeft: a.today?.replies_left ?? null, connectUrl: result?.connect_url ?? null }
        : { platform: null, connectUrl: result?.connect_url ?? null };
    },
  };
}

// social.post result → what we keep in posted.jsonl
export function postOutcome(result) {
  const p = (result?.platforms || [])[0] || {};
  return { postId: result?.post_id ?? null, status: result?.status ?? null, url: p.platformPostUrl ?? null, xId: p.platformPostId ?? null, error: p.errorMessage ?? null };
}

// social.x.posts result → [{ id, author, text, at }]
export function mentionsOf(result) {
  return (result?.tweets || []).map((t) => ({ id: String(t.id_str ?? t.id ?? ""), author: t.user?.screen_name || "", text: t.full_text || t.text || "",
    at: t.tweet_created_at ? Date.parse(t.tweet_created_at) : null })).filter((t) => t.id);
}
