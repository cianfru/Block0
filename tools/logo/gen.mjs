// b0 mark — constructed geometry, no font. The 0 is the atom (a monoline ring); the b is the same ring plus a stem.
// Coordinates in a 200×200 box; the mark is centred by measuring its extents.
const LIME = "#c8ff4d", WHITE = "#ffffff", BG = "#08080b";
export function mark({ zero = "slash", w = 20, r = 24, gap = 12, stemTop = 30, color = { b: WHITE, z: LIME } } = {}) {
  const R = r + w / 2;                       // outer radius
  const base = 160, cy = base - R;           // baseline = bowl outer bottom
  const stemX = 46;                          // stem centreline
  const bowlX = stemX + r;                   // bowl centre (left edge shares the stem)
  const zX = bowlX + R + gap + R;            // zero centre
  const left = stemX - w / 2, right = zX + R, top = stemTop, bottom = base;
  const cx = (left + right) / 2, cyAll = (top + bottom) / 2;
  const dx = 100 - cx, dy = 100 - cyAll;
  const parts = [];
  // b: stem (butt caps) + bowl ring
  parts.push(`<line x1="${stemX}" y1="${stemTop}" x2="${stemX}" y2="${base}" stroke="${color.b}" stroke-width="${w}"/>`);
  parts.push(`<circle cx="${bowlX}" cy="${cy}" r="${r}" fill="none" stroke="${color.b}" stroke-width="${w}"/>`);
  // 0: ring + the "zero" marker
  parts.push(`<circle cx="${zX}" cy="${cy}" r="${r}" fill="none" stroke="${color.z}" stroke-width="${w}"/>`);
  // slash: wall-to-wall through the ring, CLIPPED to the outer circle so it ends flush (round caps would poke "ears" past the ring)
  if (zero === "slash") { const d = r * 0.9, id = "z" + Math.round(zX); parts.push(`<clipPath id="${id}"><circle cx="${zX}" cy="${cy}" r="${R}"/></clipPath><line clip-path="url(#${id})" x1="${zX - d}" y1="${cy + d}" x2="${zX + d}" y2="${cy - d}" stroke="${color.z}" stroke-width="${w * 0.8}" stroke-linecap="round"/>`); }
  if (zero === "block") { const s = Math.max(6, (r - w / 2) * 1.05); parts.push(`<rect x="${zX - s / 2}" y="${cy - s / 2}" width="${s}" height="${s}" fill="${color.z}"/>`); }
  if (zero === "notch") { const d = r * 0.62; parts.push(`<line x1="${zX - d}" y1="${cy + d}" x2="${zX + d}" y2="${cy - d}" stroke="${BG}" stroke-width="${w * 0.55}"/>`); }
  return { inner: `<g transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)})">${parts.join("")}</g>`, width: right - left, height: bottom - top };
}
export const svg = (inner, { size = 200, bg = BG, radius = 0, pad = 0, extra = "" } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="Block0">` +
  (bg ? `<rect width="200" height="200" rx="${radius}" fill="${bg}"/>` : "") + extra +
  (pad ? `<g transform="translate(100 100) scale(${1 - pad}) translate(-100 -100)">${inner}</g>` : inner) + `</svg>`;
