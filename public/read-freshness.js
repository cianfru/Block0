// One freshness policy for board snapshots and the static dossier. Invalid clocks fail closed.
export const LIVE_MIN = 45, MAX_READ_MIN = 180;
export const NOW_FLAGS = ["insiderSellersNow", "insiderDumpNowPct", "earlyMovedOutNow", "earlyMovedOutPct"];
export function readFreshness(readAt, now = Date.now(), { liveMin = LIVE_MIN, maxReadMin = MAX_READ_MIN } = {}) {
  const valid = Number.isFinite(readAt) && readAt > 0 && readAt <= now;
  const ageMs = valid ? now - readAt : Infinity;
  return { stale: ageMs > liveMin * 60e3, expired: ageMs > maxReadMin * 60e3, ageMs };
}
export function freshFlags(flags, stale) {
  return stale ? { ...flags, ...Object.fromEntries(NOW_FLAGS.map(k => [k, null])) } : flags;
}
export function dossierView(d, now = Date.now()) {
  const freshness = readFreshness(d.readAt, now);
  return { ...d, ...freshness, flags: freshFlags(d.flags || {}, freshness.stale) };
}
