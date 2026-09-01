// Pons launchpad data source — the source of truth for the Robinhood-Chain launch universe.
// One same-origin Next.js API backs the launchpad's Explore grid: it returns the ACTIVE (pre-graduation)
// set and the GRADUATED set with real USD market caps, logos (ipfs CID), pool, deployer, and graduation
// progress. This replaces our on-chain discovery/MC/stock heuristics with Pons's own data; the verdict
// engine then adds the forensic layer (snipers/bundles/dumping) on top.
const BASE = "https://www.ponsfamily.com";
const HDR = { "user-agent": "Mozilla/5.0 (compatible; Block0/1.0) curl/8.5.0", "referer": BASE + "/launchpad", "accept": "application/json" };

// ipfs://<cid> → the launchpad's own gateway route (same route the site uses to render icons)
export const logoUrl = (logo) => !logo ? null : logo.startsWith("ipfs://") ? BASE + "/api/ipfs/content/" + logo.slice(7) : logo;

function norm(t) {
  return {
    address: (t.token || "").toLowerCase(), sym: t.symbol || "?", name: t.name || "",
    logo: logoUrl(t.logo), mcapUsd: Number(t.marketCapUsd || 0), priceUsd: Number(t.priceUsd || 0),
    pool: (t.pool || "").toLowerCase(), pairToken: (t.pairToken || "").toLowerCase(), deployer: (t.deployer || "").toLowerCase(),
    launchedAt: t.launchedAt || null, latestBuyAt: t.latestBuyAt || null,
    graduated: !!t.graduated, progress: Math.round(Number(t.graduationProgressPct || 0)),
    factory: (t.factory || "").toLowerCase(), version: t.version || null,
  };
}

async function j(url) { const r = await fetch(url, { headers: HDR }); if (!r.ok) throw new Error("pons " + r.status); return r.json(); }

// active (pre-graduation) universe. sort: marketCap | newest | oldest | volume | recentBuys ; age: all|24h|7d
export async function fetchActive({ sort = "marketCap", age = "all", pageSize = 40 } = {}) {
  const u = `${BASE}/api/pons-launches?explore=1&sort=${sort}&age=${age}&page=1&pageSize=${pageSize}&includeGraduated=0&v=22`;
  const d = await j(u);
  return { items: (d.active?.items || []).map(norm), total: d.activeTotal ?? d.active?.total ?? 0, launchTotal: d.launchTotal || 0 };
}

// graduated universe (the ~510 that completed the bonding curve) — lean catalog endpoint
export async function fetchGraduated() {
  const d = await j(`${BASE}/api/pons-launches/graduations?catalog=1&v=12`);
  const arr = Array.isArray(d) ? d : (d.items || d.graduated?.items || []);
  return { items: arr.map(norm), total: arr.length };
}
