// FORENSIC ANALYTICS — first-party visitor + wallet tracking, like the sister site's intel panel. Records who comes
// in, from where (country/city), when, via which referrer, which tokens/pages they open, and — the key signal —
// WALLET CONNECTS (how many wallets, which addresses). Everything lands in the KV store (events list + unique-visitor
// set + rolling aggregates); the /control dashboard reads it. Raw IPs are never stored — only a salted hash.
//
// Geo: prefer an edge header (cf-ipcountry when the site is behind Cloudflare, or x-vercel-ip-country), else a
// best-effort cached IP lookup (one call per new visitor, cached forever — cheap, on-brand with the cost North Star).
import { createHash } from "node:crypto";
import { getJSON, setJSON, lPush, lRange, sAdd, sHas } from "./store/kv.mjs";

const SALT = process.env.INTEL_SALT || "block0-intel";
const AGG = "intel:agg", EVENTS = "intel:events", UNIQ = "intel:uniq";
const GEO_ON = process.env.INTEL_GEO !== "0";
const EVENT_TYPES = new Set(["pageview", "wallet_connect", "token_view", "bubble_open", "leaderboard_view", "scan"]);

function clientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "";
}
const ipHash = (ip) => createHash("sha256").update(ip + SALT).digest("hex").slice(0, 16);

async function geoFor(iph, ip, req) {
  const hdr = (req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || "").toUpperCase();
  const hCity = req.headers["x-vercel-ip-city"] || "";
  if (hdr && hdr !== "XX") return { cc: hdr, city: hCity ? decodeURIComponent(hCity) : "" };
  if (!GEO_ON || !ip) return { cc: "", city: "" };
  const cached = await getJSON(`geo:${iph}`).catch(() => null);
  if (cached) return cached;
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=country_code,city`, { signal: AbortSignal.timeout(2500) }).then((x) => x.json());
    const g = { cc: (r?.country_code || "").toUpperCase(), city: r?.city || "" };
    setJSON(`geo:${iph}`, g).catch(() => {}); // immutable enough → cache forever
    return g;
  } catch { return { cc: "", city: "" }; }
}

const bump = (o, k) => { if (k == null || k === "") return; o[k] = (o[k] || 0) + 1; };

// record one event. `body` = { type, path, ref, wallet? } from the client beacon; `req` gives IP/geo/UA.
export async function track(body, req) {
  const type = EVENT_TYPES.has(body?.type) ? body.type : "pageview";
  const path = String(body?.path || "/").slice(0, 120);
  const ref = String(body?.ref || "").slice(0, 160).replace(/[?#].*$/, "");
  const wallet = /^0x[0-9a-fA-F]{40}$/.test(body?.wallet || "") ? body.wallet.toLowerCase() : null;
  const ip = clientIp(req), iph = ip ? ipHash(ip) : "";
  const geo = await geoFor(iph, ip, req);
  const day = new Date().toISOString().slice(0, 10), hour = new Date().getUTCHours();

  const isNew = iph ? !(await sHas(UNIQ, iph).catch(() => false)) : false;
  if (isNew) sAdd(UNIQ, iph).catch(() => {});

  const agg = (await getJSON(AGG).catch(() => null)) || { total: 0, uniq: 0, wallets: 0, days: {}, hours: {}, countries: {}, cities: {}, pages: {}, refs: {}, types: {}, walletSet: 0 };
  agg.total++; if (isNew) agg.uniq++;
  bump(agg.days, day); bump(agg.hours, hour); bump(agg.countries, geo.cc); if (geo.city) bump(agg.cities, `${geo.city}${geo.cc ? ", " + geo.cc : ""}`);
  bump(agg.pages, path); if (ref && !ref.includes(req.headers.host || "")) bump(agg.refs, ref); bump(agg.types, type);
  if (type === "wallet_connect" && wallet) { agg.wallets++; if (!(await sHas("intel:wallets", wallet).catch(() => false))) { sAdd("intel:wallets", wallet).catch(() => {}); agg.walletSet++; } }
  setJSON(AGG, agg).catch(() => {});

  lPush(EVENTS, { t: Date.now(), type, path, ref: ref || null, cc: geo.cc || null, city: geo.city || null, iph, wallet }, 600).catch(() => {});
  return { ok: true };
}

// dashboard payload: aggregates + recent events + system health
export async function readIntel({ boardAge, provider, kvBackend } = {}) {
  const agg = (await getJSON(AGG).catch(() => null)) || {};
  const events = await lRange(EVENTS, 120).catch(() => []);
  const top = (o, n = 12) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
  const mem = process.memoryUsage();
  return {
    totals: { visits: agg.total || 0, unique: agg.uniq || 0, walletConnects: agg.wallets || 0, uniqueWallets: agg.walletSet || 0 },
    countries: top(agg.countries, 15), cities: top(agg.cities, 12), pages: top(agg.pages, 15), refs: top(agg.refs, 12),
    types: top(agg.types, 10), hours: agg.hours || {}, days: agg.days || {},
    events: events.map((e) => ({ ...e, ago: Math.round((Date.now() - e.t) / 1000) })),
    health: {
      uptimeS: Math.round(process.uptime()), rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576),
      boardAgeS: boardAge == null ? null : Math.round(boardAge / 1000), provider: provider || null, kv: kvBackend || null,
      node: process.version, now: Date.now(),
    },
  };
}
