// @mention parsing — pure. A mention asks about one token: by address (exact) or by $SYMBOL (resolved against the
// launch lists; ambiguous symbols get a reply asking for the address — copycat tickers are common: two live "TANK"s).
const ADDR = /0x[a-fA-F0-9]{40}\b/;
const SYM = /\$([A-Za-z][A-Za-z0-9]{0,15})\b/;

export function parseMention(text, { selfHandle = "" } = {}) {
  const t = String(text || "");
  const a = t.match(ADDR);
  if (a) return { address: a[0].toLowerCase() };
  const s = t.match(SYM);
  if (s) return { symbol: s[1].toUpperCase() };
  void selfHandle;
  return null;
}

// symbol → { address } | { ambiguous: [..] } | null. `universe` = [{ address, sym, mcapUsd }]
export function resolveSymbol(symbol, universe) {
  const hits = (universe || []).filter((u) => String(u.sym || "").toUpperCase() === symbol);
  if (hits.length === 1) return { address: hits[0].address };
  if (hits.length > 1) return { ambiguous: hits.sort((x, y) => (y.mcapUsd || 0) - (x.mcapUsd || 0)).slice(0, 3).map((h) => h.address) };
  return null;
}

// which mentions to answer: not ours, not answered yet, not from someone already answered 3× this hour
export function selectMentions(posts, { selfHandle, answered = {}, now = Date.now() } = {}) {
  const self = String(selfHandle || "").replace(/^@/, "").toLowerCase();
  const perAuthor = {};
  for (const a of Object.values(answered)) if (now - a.at < 3600e3) perAuthor[a.author] = (perAuthor[a.author] || 0) + 1;
  const out = [];
  for (const p of posts || []) {
    const author = String(p.author || "").replace(/^@/, "").toLowerCase();
    if (!p.id || answered[p.id] || author === self) continue;
    if ((perAuthor[author] || 0) >= 3) continue;
    perAuthor[author] = (perAuthor[author] || 0) + 1;
    out.push(p);
  }
  return out;
}
