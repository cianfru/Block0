// Thin Orbio client. Public reads need no key; metered tools need ORBIO_API_KEY and always send max_cost (string,
// $CREDIT) so a single call can never spend more than we said. 401 → bad key, 402 → out of balance: both throw a
// typed OrbioError the tick turns into "stop posting for the day", never a retry loop.
export const ORBIO_API = "https://api.orbio.so";

export class OrbioError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function makeOrbio({ apiKey = null, fetch: f = fetch, base = ORBIO_API } = {}) {
  async function publicGet(path) {
    const r = await f(base + path, { headers: { accept: "application/json" } });
    if (!r.ok) throw new OrbioError("http", `GET ${path} → ${r.status}`);
    return r.json();
  }
  return {
    publicGet,
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
    async tool(name, args, maxCost) {
      if (!apiKey) throw new OrbioError("nokey", `tool ${name} needs ORBIO_API_KEY`);
      if (maxCost == null) throw new OrbioError("nocap", `tool ${name} called without max_cost`);
      const r = await f(`${base}/api/v1/tools/${name}`, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ ...args, max_cost: String(maxCost) }) });
      if (r.status === 401) throw new OrbioError("auth", "Orbio rejected the API key (401)");
      if (r.status === 402) throw new OrbioError("balance", "Orbio balance too low (402)");
      if (!r.ok) throw new OrbioError("http", `tool ${name} → ${r.status}`);
      return r.json();
    },
  };
}
