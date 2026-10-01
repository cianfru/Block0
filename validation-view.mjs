// What /api/validation serves: study/validation.json enriched from study/cohort.json with the build progress, the
// winner roll (every token that closed above $1M for a day, biggest first, with its durability fate) and the launch
// funnel. Pure — shared by server.mjs (live) and tools/export-static.mjs (the static site's copy), so they can't drift.
export function composeValidation(v, c) {
  if (!c) return v;
  if (c.run) v.progress = { ...c.run, generatedAt: c.generatedAt || v.generatedAt };
  const T = c.tokens || [];
  const roll = T.filter((t) => (t.heldPeak || 0) >= 1e6)
    .sort((a, b) => (b.heldPeak || 0) - (a.heldPeak || 0))
    .map((t) => ({ sym: t.sym || t.name || null, addr: t.addr, tier: t.label, heldPeak: t.heldPeak || null,
      curMcap: t.curMcap ?? null, sustainedH: t.sustainedH || null, holders: t.holders || null, peakHolders: t.peakHolders || null, graduated: !!t.graduated }));
  if (roll.length) v.winnerRoll = roll;
  if (!v.funnel || !v.cohort?.funnel) { const touched = T.filter((t) => (t.peakMcap || 0) >= 1e6).length, reached = roll.length, sustained = T.filter((t) => t.label === "major" || t.label === "runner").length;
    v.funnel = v.funnel || v.cohort?.funnel || { launched: T.length, touched, reached, sustained, pctTouched: T.length ? +(touched / T.length * 100).toFixed(1) : null, pctReached: T.length ? +(reached / T.length * 100).toFixed(1) : null, pctSustained: T.length ? +(sustained / T.length * 100).toFixed(1) : null }; }
  else v.funnel = v.funnel || v.cohort.funnel;
  return v;
}
