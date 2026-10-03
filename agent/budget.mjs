// Posting gate — pure. Caps per hour / UTC day, one post per token per 6h, a daily $CREDIT ceiling, and a fixed
// priority order when more events want to go out than the caps allow. State is plain JSON the caller persists.
export const PRIORITY = ["insider-dump", "serial-owner", "graduated", "principal-withdrawn", "smart-convergence", "clean-launch", "cliff-24h", "credit-idle", "first-harvest"];
export const POST_MAX_COST = 0.02, MENTION_MAX_COST = 0.005;
export const DEFAULT_CAPS = { originalsPerDay: 15, originalsPerHour: 3, repliesPerDay: 40, perTokenMs: 6 * 3600e3, maxCreditPerDay: 1.5, postCost: POST_MAX_COST };

export function canSpend(state, cost, { now = Date.now(), caps = {} } = {}) {
  const ceiling = caps.maxCreditPerDay ?? DEFAULT_CAPS.maxCreditPerDay;
  return Number.isFinite(ceiling) && cost >= 0 && Math.round((freshBudget(state, now).credit + cost) * 1e6) <= Math.floor(ceiling * 1e6);
}

// Reserve the request cap BEFORE I/O. Unknown/async/invalid settlements keep the reservation.
export function settle(state, reserved, response, now) {
  const actual = response?.credit;
  if (response?.running || !Number.isFinite(actual) || actual < 0 || actual > reserved) return state;
  return record(state, { now, kind: "read", credit: actual - reserved });
}

const day = (now) => new Date(now).toISOString().slice(0, 10);

export function freshBudget(state, now) {
  const s = state && state.day === day(now) ? state : { day: day(now), originals: [], replies: 0, credit: 0 };
  return { ...s, originals: (s.originals || []).filter((o) => now - o.at < 86400e3) };
}

// events → { post: [...ordered, within caps], hold: [{ ev, why }] }
export function plan(events, state, { now = Date.now(), caps = {}, remaining = null, perToken = {} } = {}) {
  const c = { ...DEFAULT_CAPS, ...caps, postCost: POST_MAX_COST }, s = freshBudget(state, now);
  const rank = (k) => { const i = PRIORITY.indexOf(k); return i < 0 ? PRIORITY.length : i; };
  const ordered = [...events].sort((a, b) => rank(a.kind) - rank(b.kind) || (b.mcapUsd || 0) - (a.mcapUsd || 0));
  let day_ = s.originals.length, hour = s.originals.filter((o) => now - o.at < 3600e3).length, credit = s.credit;
  const post = [], hold = [], seen = new Set();
  for (const ev of ordered) {
    const last = perToken[ev.address];
    const why = seen.has(ev.address) || (last && now - last < c.perTokenMs) ? "token posted within 6h"
      : day_ >= c.originalsPerDay ? "daily cap" : hour >= c.originalsPerHour ? "hourly cap"
      : remaining != null && day_ >= remaining ? "platform allowance" : !canSpend({ ...s, credit }, c.postCost, { now, caps }) ? "credit ceiling" : null;
    if (why) { hold.push({ ev, why }); continue; }
    post.push(ev); seen.add(ev.address); day_++; hour++; credit += c.postCost;
  }
  return { post, hold };
}

export function canReply(state, { now = Date.now(), caps = {} } = {}) {
  const c = { ...DEFAULT_CAPS, ...caps }, s = freshBudget(state, now);
  return s.replies < c.repliesPerDay && canSpend(s, POST_MAX_COST, { now, caps });
}

// Record reservations/attempts and settlement adjustments (dry-run records too, at zero cost).
export function record(state, { now = Date.now(), kind = "original", credit = 0, address = null } = {}) {
  const s = freshBudget(state, now);
  return { ...s, originals: kind === "original" ? [...s.originals, { at: now, address }] : s.originals,
    replies: s.replies + (kind === "reply" ? 1 : 0), credit: +(s.credit + credit).toFixed(6) };
}
