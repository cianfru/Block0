import { mark, svg } from "./gen.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
const BG = "#08080b", INK = "#0b0b0e";
const P = { zero: "slash", w: 17, r: 29, gap: 12, stemTop: 22 };
const dark = mark(P).inner, light = mark({ ...P, color: { b: INK, z: "#c8ff4d" } }).inner;
// the 0 alone = the atom (favicon fallback at the tiniest sizes could use it; also a standalone glyph)
const OUT = process.argv[2] || "public"; mkdirSync(OUT, { recursive: true });
const files = {
  "favicon.svg": svg(dark, { bg: BG, radius: 40, pad: 0.14 }),                      // rounded square, dark
  "b0-logo.svg": svg(dark, { bg: null, pad: 0 }),                                    // mark only, transparent (for dark grounds)
  "b0-logo-on-light.svg": svg(light, { bg: null, pad: 0 }),                          // mark only, black b (for light grounds)
  "b0-square.svg": svg(dark, { bg: BG, radius: 0, pad: 0.16 }),                      // full-bleed square (iOS masks its own corners)
};
for (const [n, s] of Object.entries(files)) writeFileSync(OUT + "/" + n, s);
// PNG exports via headless chromium: each is an exact-size SVG page, screenshot at 1× (no resampling)
const br = await chromium.launch(); const pg = await br.newPage();
async function png(name, svgText, size) {
  await pg.setViewportSize({ width: size, height: size });
  await pg.setContent(`<style>html,body{margin:0;background:transparent}</style>${svgText.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}`);
  const buf = await pg.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(OUT + "/" + name, buf); return buf;
}
const sq = files["b0-square.svg"], rq = files["favicon.svg"];
const icoSizes = [16, 32, 48], icoBufs = [];
for (const s of icoSizes) icoBufs.push(await png(`favicon-${s}.png`, rq, s));
await png("apple-touch-icon.png", sq, 180);
await png("icon-192.png", rq, 192); await png("icon-512.png", rq, 512);
await png("b0-avatar.png", svg(dark, { bg: BG, radius: 0, pad: 0.22 }), 1024);      // X / Telegram avatar (they crop a circle — extra pad)
await png("b0-avatar-light.png", svg(light, { bg: "#ffffff", radius: 0, pad: 0.22 }), 1024);
// ICO container with embedded PNGs (Vista+; every modern browser)
const dir = Buffer.alloc(6 + 16 * icoBufs.length); dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(icoBufs.length, 4);
let off = dir.length; icoBufs.forEach((b, i) => { const s = icoSizes[i], o = 6 + 16 * i; dir[o] = s === 256 ? 0 : s; dir[o + 1] = s === 256 ? 0 : s; dir[o + 2] = 0; dir[o + 3] = 0; dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(b.length, o + 8); dir.writeUInt32LE(off, o + 12); off += b.length; });
writeFileSync(OUT + "/favicon.ico", Buffer.concat([dir, ...icoBufs]));
// final review sheet: the chosen mark at real sizes on both grounds + the avatar crop
const cell = (s, size) => `<img src="data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}" width="${size}" height="${size}">`;
const circ = (p, size) => `<div style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;display:inline-block"><img src="${p}" width="${size}" height="${size}"></div>`;
await pg.setViewportSize({ width: 980, height: 560 });
await pg.setContent(`<style>body{margin:0;background:#1a1a1f;padding:22px;font:13px Inter,system-ui;color:#bbb}.row{display:flex;gap:24px;align-items:flex-end;margin:0 0 22px}.lbl{width:150px}</style>
<div class="row"><div class="lbl">favicon · 256/64/32/16</div>${cell(rq, 256)}${cell(rq, 64)}${cell(rq, 32)}${cell(rq, 16)}<div style="width:30px"></div><div class="lbl">tab strip (16 real)</div><div style="background:#2b2b2f;padding:6px 10px;border-radius:6px;color:#eee;display:flex;gap:8px;align-items:center">${cell(rq, 16)} block0 · board</div></div>
<div class="row"><div class="lbl">socials avatar (circle crop)</div>${circ(OUT + "/b0-avatar.png", 220)}${circ(OUT + "/b0-avatar.png", 96)}${circ(OUT + "/b0-avatar.png", 48)}${circ(OUT + "/b0-avatar-light.png", 220)}${circ(OUT + "/b0-avatar-light.png", 96)}${circ(OUT + "/b0-avatar-light.png", 48)}</div>
<div class="row"><div class="lbl">mark on light / dark</div><div style="background:#fff;padding:24px;border-radius:12px">${cell(files["b0-logo-on-light.svg"], 160)}</div><div style="background:#08080b;padding:24px;border-radius:12px">${cell(files["b0-logo.svg"], 160)}</div></div>`, { waitUntil: "load" });
await pg.screenshot({ path: "final.png", fullPage: true }); await br.close();
console.log("exported:", Object.keys(files).join(", "), "+ favicon.ico, favicon-16/32/48.png, apple-touch-icon.png, icon-192/512.png, b0-avatar.png, b0-avatar-light.png");
