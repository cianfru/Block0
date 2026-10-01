// One freshness policy for board snapshots and the static dossier. Invalid clocks fail closed.
export const LIVE_MIN = 45, MAX_READ_MIN = 180;
export const NOW_FLAGS = ["insiderSellersNow", "insiderDumpNowPct", "earlyMovedOutNow", "earlyMovedOutPct"];
// A visitor's clock can run a few minutes behind the agent's: a read up to SKEW_MS "in the future" is treated as just
// made (age 0) instead of failing closed, which hid every fresh dossier from anyone whose clock was slow. Further
// ahead than that is not skew, and still fails closed.
export const SKEW_MS = 10 * 60e3;
export function readFreshness(readAt, now = Date.now(), { liveMin = LIVE_MIN, maxReadMin = MAX_READ_MIN } = {}) {
  const valid = Number.isFinite(readAt) && readAt > 0 && readAt <= now + SKEW_MS;
  const ageMs = valid ? Math.max(0, now - readAt) : Infinity;
  return { stale: ageMs > liveMin * 60e3, expired: ageMs > maxReadMin * 60e3, ageMs };
}
export function freshFlags(flags, stale) {
  return stale ? { ...flags, ...Object.fromEntries(NOW_FLAGS.map(k => [k, null])) } : flags;
}
export function dossierView(d, now = Date.now()) {
  const freshness = readFreshness(d.readAt, now);
  return { ...d, ...freshness, flags: freshFlags(d.flags || {}, freshness.stale) };
}
