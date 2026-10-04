// THE DAILY DIGEST — one post a day summing up the last 24 h of launches on the chain. Pure. Counts only, from the
// agent's own record (the events it detected, the launch lists it read); no ranking beyond "most holders", which is a
// count, and never a word about what to buy. Posted once per UTC day at or after HOUR_UTC.
import { lint, symTag } from "./format.mjs";

export const HOUR_UTC = 17;
const day = (now) => new Date(now).toISOString().slice(0, 10);

export const digestDue = (lastDay, now, hour = HOUR_UTC) => new Date(now).getUTCHours() >= hour && lastDay !== day(now);

// remember the events of the last 24 h (state.recent): enough to count, small enough to keep in state
export function remember(recent, events, now) {
  const keep = (recent || []).filter((e) => now - e.at < 86400e3);
  for (const e of events || []) keep.push({ at: e.at ?? now, kind: e.kind, address: e.address, posted: e.fate === "posted" || e.fate === "dry-run" });
  return keep;
}

// → { launches, orbio, graduated, sells, sellTokens, serial, top: {sym, holders} | null }
export function digestStats({ recent = [], launches = [], reads = [], now = Date.now() } = {}) {
  const r = recent.filter((e) => now - e.at < 86400e3), tokens = (k) => new Set(r.filter((e) => e.kind === k).map((e) => e.address)).size;
  const fresh = launches.filter((t) => t.ageH != null && t.ageH >= 0 && t.ageH < 24);
  // a launch nobody holds yet is not "most holders" (the 2026-10-03 digest read "$ORA (0)")
  const top = reads.filter((t) => t.ageH != null && t.ageH < 24 && (t.flags?.holders ?? 0) >= 5).sort((a, b) => b.flags.holders - a.flags.holders)[0];
  return { launches: fresh.length, orbio: fresh.filter((t) => t.orbio).length, graduated: tokens("graduated"),
    sells: r.filter((e) => e.kind === "insider-dump").length, sellTokens: tokens("insider-dump"), serial: tokens("serial-owner"),
    top: top ? { sym: top.sym, holders: top.flags.holders, address: top.address } : null };
}

export function formatDigest(s) {
  const pl = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const lines = ["Robinhood Chain launches, last 24h",
    `${pl(s.launches, "new launch", "new launches")}${s.orbio ? ` (${pl(s.orbio, "Orbio agent")})` : ""} · ${s.graduated} graduated`,
    `${pl(s.sells, "early-wallet sell-off")} on ${pl(s.sellTokens, "launch", "launches")} · ${pl(s.serial, "launch", "launches")} by repeat owners, none graduated`,
    s.top ? `Most holders: ${symTag(s.top.sym)} (${s.top.holders.toLocaleString("en-US")})` : null,
    s.top ? s.top.address : null,
    "Counts from Block0's reads. Facts, not advice."].filter(Boolean);
  const text = lines.join("\n");
  return lint(text).length ? lines.filter((l) => l !== s.top?.address && !/^Most holders/.test(l)).join("\n") : text;
}
