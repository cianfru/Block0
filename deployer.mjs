// DEPLOYER REPUTATION — the serial-operator signal. The launchpad gives every token its deployer wallet (no RPC), so
// we can ask the hardest-to-fake forensic question there is: what ELSE has this hand launched, and what happened to
// it? A prior GRADUATION is a genuine positive. Several launches with none — especially ones that faded to dust — is
// the same operator, again. Pure over the launchpad list; used by the board card AND the dossier so they can't drift.
const FADED_MCAP = 5000;   // a prior launch that never graduated and sits under this is "faded to dust"
export function deployerReputation(all, meta, { fadedMcap = FADED_MCAP } = {}) {
  const dep = (meta?.deployer || "").toLowerCase();
  if (!dep || /^0x0+$/.test(dep)) return null;
  const me = (meta.address || "").toLowerCase();
  const mine = (all || []).filter((t) => (t.deployer || "").toLowerCase() === dep);
  const others = mine.filter((t) => (t.address || "").toLowerCase() !== me);
  const isFaded = (t) => !t.graduated && (t.mcapUsd || 0) < fadedMcap;
  const graduated = mine.filter((t) => t.graduated).length;
  const faded = others.filter(isFaded).length;
  const launched = mine.length;
  // a prior graduation is a genuine positive; many launches with none is a caution
  const reputation = graduated >= 1 ? "proven" : launched >= 3 ? "serial" : launched >= 2 ? "repeat" : "first";
  return { address: dep, launched, graduated, faded, reputation,
    others: others.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, 8)
      .map((t) => ({ sym: t.sym, address: t.address, mcapUsd: Math.round(t.mcapUsd || 0), graduated: !!t.graduated, faded: isFaded(t) })) };
}
// the card-sized version (no list) attached to every board verdict
export const compactRep = (r) => r ? { address: r.address, launched: r.launched, graduated: r.graduated, faded: r.faded, reputation: r.reputation } : null;
