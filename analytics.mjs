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
const EVENT_TYPES = new Set(["pageview", "wallet_connect", "token_view", "bubble_open", "leaderboard_view", "scan",
  "feedback", "evidence_open"]);
// PILOT COHORT. An invited tester arrives on a link carrying ?p=<code>; the code is remembered client-side and
// attached to every later beacon, so their usage is separable from passing traffic without an account, a login
// or anything that identifies a person. The two questions the pilot has to answer are DEPTH (did they look at
// more than one token) and RETURN (did they come back on another day), so both are counted per cohort.
const PILOT = /^[a-z0-9_-]{2,24}$/i;

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

  const pilot = PILOT.test(body?.pilot || "") ? String(body.pilot).toLowerCase() : null;
  const token = /^0x[0-9a-fA-F]{40}$/.test(body?.token || "") ? body.token.toLowerCase() : null;
  const answer = typeof body?.answer === "string" ? body.answer.slice(0, 12) : null;
  const note = typeof body?.note === "string" ? body.note.slice(0, 400) : null;

  const isNew = iph ? !(await sHas(UNIQ, iph).catch(() => false)) : false;
  if (isNew) sAdd(UNIQ, iph).catch(() => {});

  // Depth and return, per visitor. Both are sets, so a reload cannot inflate either — the questions are "how
  // many DISTINCT tokens" and "how many DISTINCT days", and a set is the only honest way to count them.
  if (iph && token) sAdd(`intel:seen:${iph}`, token).catch(() => {});
  if (iph) sAdd(`intel:days:${iph}`, day).catch(() => {});

  const agg = (await getJSON(AGG).catch(() => null)) || { total: 0, uniq: 0, wallets: 0, days: {}, hours: {}, countries: {}, cities: {}, pages: {}, refs: {}, types: {}, walletSet: 0 };
  agg.total++; if (isNew) agg.uniq++;
  bump(agg.days, day); bump(agg.hours, hour); bump(agg.countries, geo.cc); if (geo.city) bump(agg.cities, `${geo.city}${geo.cc ? ", " + geo.cc : ""}`);
  bump(agg.pages, path); if (ref && !ref.includes(req.headers.host || "")) bump(agg.refs, ref); bump(agg.types, type);
  if (type === "wallet_connect" && wallet) { agg.wallets++; if (!(await sHas("intel:wallets", wallet).catch(() => false))) { sAdd("intel:wallets", wallet).catch(() => {}); agg.walletSet++; } }
  if (pilot) { agg.pilots ||= {}; bump(agg.pilots, pilot); if (iph) sAdd(`intel:pilot:${pilot}`, iph).catch(() => {}); }
  setJSON(AGG, agg).catch(() => {});

  // Feedback is kept in its own list: it is the only qualitative record the pilot produces, and it must not be
  // trimmed away by ordinary pageview traffic sharing the same capped list.
  if (type === "feedback") lPush("intel:feedback",
    { t: Date.now(), pilot, token, answer, note, cc: geo.cc || null, iph }, 400).catch(() => {});

  lPush(EVENTS, { t: Date.now(), type, path, ref: ref || null, cc: geo.cc || null, city: geo.city || null,
    iph, wallet, pilot, token }, 600).catch(() => {});
  return { ok: true };
}

// dashboard payload: aggregates + recent events + system health
export async function readIntel({ boardAge, provider, kvBackend } = {}) {
  const agg = (await getJSON(AGG).catch(() => null)) || {};
  const events = await lRange(EVENTS, 120).catch(() => []);
  const feedback = await lRange("intel:feedback", 60).catch(() => []);
  const top = (o, n = 12) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));

  // ── THE PILOT READ ─────────────────────────────────────────────────────────────────────────────────────
  // Two numbers decide whether the dossier is worth building on, and neither is traffic: did a tester look at
  // more than one token, and did they come back on another day. Both are computed from the recent event
  // window, so they are a floor rather than a full history — stated here so nobody reads them as complete.
  const byVisitor = new Map();
  for (const e of events) {
    if (!e.iph) continue;
    const v = byVisitor.get(e.iph) || { tokens: new Set(), days: new Set(), pilot: null };
    if (e.token) v.tokens.add(e.token);
    v.days.add(new Date(e.t).toISOString().slice(0, 10));
    if (e.pilot) v.pilot = e.pilot;
    byVisitor.set(e.iph, v);
  }
  const visitors = [...byVisitor.values()];
  const pilotV = visitors.filter((v) => v.pilot);
  const answers = {};
  for (const f of feedback) if (f.answer) answers[f.answer] = (answers[f.answer] || 0) + 1;
  const mem = process.memoryUsage();
  return {
    totals: { visits: agg.total || 0, unique: agg.uniq || 0, walletConnects: agg.wallets || 0, uniqueWallets: agg.walletSet || 0 },
    countries: top(agg.countries, 15), cities: top(agg.cities, 12), pages: top(agg.pages, 15), refs: top(agg.refs, 12),
    types: top(agg.types, 10), hours: agg.hours || {}, days: agg.days || {},
    pilot: {
      cohorts: top(agg.pilots, 10),
      testers: pilotV.length,
      readMoreThanOne: pilotV.filter((v) => v.tokens.size > 1).length,
      returnedAnotherDay: pilotV.filter((v) => v.days.size > 1).length,
      medianTokensRead: pilotV.length
        ? [...pilotV].map((v) => v.tokens.size).sort((a, b) => a - b)[Math.floor(pilotV.length / 2)] : null,
      answers,
      replies: feedback.slice(0, 25).map((f) => ({ ...f, ago: Math.round((Date.now() - f.t) / 1000) })),
      note: "Depth and return are computed from the recent event window, so both are a floor, not a full history.",
    },
    events: events.map((e) => ({ ...e, ago: Math.round((Date.now() - e.t) / 1000) })),
    health: {
      uptimeS: Math.round(process.uptime()), rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576),
      boardAgeS: boardAge == null ? null : Math.round(boardAge / 1000), provider: provider || null, kv: kvBackend || null,
      node: process.version, now: Date.now(),
    },
  };
}
