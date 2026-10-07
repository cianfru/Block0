// OWNER TRACK RECORDS — who launched a launch, and what became of everything else they launched. Pure.
// One file per owner wallet on agent-data (owners/<address>.json, served at /api/owner/<address>), written by
// tools/agent-tick.mjs for the owners of the launches read each cycle:
//   • record   — the complete count from the launchpad itself: every Orbio agent the wallet owns (Orbio's list), or
//                every Pons launch it deployed (Pons's /api/deployers). Never our partial view.
//   • launches — the owner's launches Block0 knows: for an Orbio owner the whole agent list; for a Pons deployer the
//                ones that came through the agent's reads (accumulated, newest first).
// Facts about a wallet's past launches, stated as counts — never a judgement of the person behind it.
export const MAX_LAUNCHES = 60, KEEP_DAYS = 60;

const launchOf = (l) => ({ address: l.address, sym: l.sym ?? null, at: l.at ?? null, graduated: !!l.graduated, mcapUsd: l.mcapUsd == null ? null : Math.round(l.mcapUsd) });

// prev file (or null) + what this cycle learned → the new file, or null when nothing changed (so nothing is rewritten)
export function mergeOwner(prev, { address, venue, record, launches = [] }, { now = Date.now() } = {}) {
  const byAddr = new Map(((prev && prev.launches) || []).map((l) => [l.address, l]));
  for (const l of launches) if (l?.address) byAddr.set(l.address, { ...byAddr.get(l.address), ...launchOf(l) });
  const list = [...byAddr.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_LAUNCHES);
  const next = { address, venue: venue || prev?.venue || null, record: record ?? prev?.record ?? null, launches: list };
  const same = prev && JSON.stringify({ ...prev, seenAt: undefined }) === JSON.stringify({ ...next, seenAt: undefined });
  return same ? null : { ...next, seenAt: now };
}

// a one-line summary for pages and posts: "launched 37 · 0 graduated"
export function ownerLine(rec) {
  if (!rec || rec.launched == null) return null;
  return `launched ${rec.launched.toLocaleString("en-US")} · ${rec.graduated ?? 0} graduated`;
}
