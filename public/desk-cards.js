/* Block0 post-card renderer — shared by /desk and /post. Draws a card object (from /api/cards) onto a
   1080×1080 canvas, colourful and on-brand, using the page's loaded brand fonts. window.B0DESK.draw(canvas, card). */
(function () {
  const A = { lime: "#c8ff4d", cyan: "#35e6e0", magenta: "#ff5cf0", amber: "#ffd23d", coral: "#ff3b5c", dim: "#b6b6bd", mute: "#7f7f88", bg: "#08080b" };
  const SERIF = '"Instrument Serif",Georgia,serif';
  const SANS = '"Inter",system-ui,sans-serif';
  const MONO = "ui-monospace,Menlo,monospace";

  function drawCard(cv, c) {
    const g = cv.getContext("2d"); const W = 1080, H = 1080, M = 84, acc = c.accent || A.lime;
    g.fillStyle = A.bg; g.fillRect(0, 0, W, H);
    let rg = g.createRadialGradient(W - 140, 120, 40, W - 140, 120, 760); rg.addColorStop(0, hexa(acc, .18)); rg.addColorStop(1, hexa(acc, 0));
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,255,255,.035)"; g.lineWidth = 1;
    for (let x = M; x < W; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 64; y < H; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    let hl = g.createLinearGradient(0, 0, W, 0); hl.addColorStop(0, A.lime); hl.addColorStop(.5, A.cyan); hl.addColorStop(1, A.magenta);
    g.fillStyle = hl; g.fillRect(0, 0, W, 7);

    g.textBaseline = "alphabetic"; g.textAlign = "left";
    g.font = `44px ${SERIF}`; g.fillStyle = "#fff"; g.fillText("block", M, 132);
    const bw = g.measureText("block").width; g.fillStyle = A.lime; g.fillText("0", M + bw + 1, 132);
    g.textAlign = "right"; g.font = `22px ${MONO}`; g.fillStyle = A.mute; g.fillText("the launch scanner", W - M, 126); g.textAlign = "left";

    spacedCaps(g, (c.eyebrow || "").toUpperCase(), M, 210, `600 24px ${SANS}`, acc, 4);

    const LX = M, colR = 700;
    let hy = 400;
    const hpx = fit(g, c.hero || "", colR - LX - 30, 190, SERIF);
    g.font = `${hpx}px ${SERIF}`; g.textAlign = "left";
    g.save(); g.shadowColor = hexa(acc, .55); g.shadowBlur = 34; g.fillStyle = acc; g.fillText(c.hero || "", LX, hy); g.restore();
    g.font = `30px ${SANS}`; g.fillStyle = A.dim; wrapText(g, c.heroSub || "", LX, hy + 46, colR - LX - 20, 36);
    let ty = hy + 150;
    g.fillStyle = "#fff"; ty = wrapText(g, c.title || "", LX, ty, W - M - LX, 64, `58px ${SERIF}`);
    let ly = ty + 64;
    (c.lines || []).slice(0, 3).forEach((ln) => {
      g.fillStyle = acc; roundRect(g, LX, ly - 15, 11, 11, 3); g.fill();
      g.fillStyle = A.dim; ly = wrapText(g, ln, LX + 30, ly, colR - LX - 40, 40, `28px ${SANS}`) + 48;
    });

    drawViz(g, c, { cx: 864, cy: 360, r: 150, acc });

    g.fillStyle = hl; g.fillRect(0, H - 7, W, 7);
    g.textBaseline = "alphabetic";
    spacedCaps(g, "SIGNAL, NOT PROOF", M, H - 46, `22px ${MONO}`, A.mute, 3);
    g.textAlign = "right"; g.font = `22px ${MONO}`; g.fillStyle = A.mute; g.fillText("block0 · robinhood chain", W - M, H - 46); g.textAlign = "left";
  }

  function drawViz(g, c, o) {
    const v = c.viz; if (!v) { target(g, o.cx, o.cy, o.r, o.acc); return; }
    if (v.type === "ring") ring(g, o.cx, o.cy, o.r, (v.pct || 0) / 100, v.color || o.acc, (v.pct || 0) + "%");
    else if (v.type === "gauge") gauge(g, o.cx, o.cy, o.r, clamp(v.value || 0, 0, 1), clamp(v.base || 0, 0, 1), v.color || o.acc);
    else if (v.type === "bars") vbars(g, o.cx, o.cy, o.r, v.segs || []);
    else if (v.type === "dots") dots(g, o.cx, o.cy, o.r, v.n || 0, v.color || o.acc);
    else target(g, o.cx, o.cy, o.r, o.acc);
  }

  function ring(g, cx, cy, r, frac, col, label) {
    g.lineWidth = 42; g.lineCap = "round";
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.strokeStyle = "rgba(255,255,255,.08)"; g.stroke();
    g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(frac, 0, 1)); g.strokeStyle = col;
    g.save(); g.shadowColor = hexa(col, .6); g.shadowBlur = 26; g.stroke(); g.restore();
    g.lineCap = "butt";
    g.textAlign = "center"; g.fillStyle = "#fff"; g.font = `92px ${SERIF}`; g.fillText(label || "", cx, cy + 30); g.textAlign = "left";
  }
  function gauge(g, cx, cy, r, val, base, col) {
    const w = 40, a0 = Math.PI * 0.9, a1 = Math.PI * 2.1;
    g.lineWidth = w; g.lineCap = "round";
    g.beginPath(); g.arc(cx, cy, r, a0, a1); g.strokeStyle = "rgba(255,255,255,.08)"; g.stroke();
    g.beginPath(); g.arc(cx, cy, r, a0, a0 + (a1 - a0) * clamp(val, 0, 1)); g.strokeStyle = col;
    g.save(); g.shadowColor = hexa(col, .55); g.shadowBlur = 22; g.stroke(); g.restore();
    if (base > 0) { const a = a0 + (a1 - a0) * clamp(base, 0, 1); g.strokeStyle = "rgba(255,255,255,.7)"; g.lineWidth = 4;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * (r - w / 2 - 4), cy + Math.sin(a) * (r - w / 2 - 4)); g.lineTo(cx + Math.cos(a) * (r + w / 2 + 4), cy + Math.sin(a) * (r + w / 2 + 4)); g.stroke(); }
    g.lineCap = "butt";
    g.textAlign = "center"; g.fillStyle = "#fff"; g.font = `72px ${SERIF}`; g.fillText(Math.round(val * 100) + "%", cx, cy + 18);
    if (base > 0) { g.font = `20px ${MONO}`; g.fillStyle = A.mute; g.fillText("base " + Math.round(base * 100) + "%", cx, cy + 52); }
    g.textAlign = "left";
  }
  function vbars(g, cx, cy, r, segs) {
    const max = Math.max(1, ...segs.map((s) => s.v || 0)); const bw = r * 1.7, x0 = cx - bw / 2; let y = cy - r + 30;
    g.textAlign = "left";
    segs.forEach((s) => {
      g.font = `22px ${MONO}`; g.fillStyle = A.dim; g.fillText(s.label, x0, y - 8);
      g.textAlign = "right"; g.fillStyle = "#fff"; g.fillText(String(s.v), x0 + bw, y - 8); g.textAlign = "left";
      roundRect(g, x0, y, bw, 20, 10); g.fillStyle = "rgba(255,255,255,.08)"; g.fill();
      const w = Math.max(20, bw * ((s.v || 0) / max)); roundRect(g, x0, y, w, 20, 10); g.fillStyle = s.color; g.save(); g.shadowColor = hexa(s.color, .5); g.shadowBlur = 14; g.fill(); g.restore();
      y += 86;
    });
  }
  function dots(g, cx, cy, r, n, col) {
    const cols = 6, gap = 44, r0 = 11; const rows = Math.ceil(n / cols);
    const x0 = cx - ((cols - 1) * gap) / 2, y0 = cy - ((rows - 1) * gap) / 2;
    for (let i = 0; i < n; i++) { const x = x0 + (i % cols) * gap, y = y0 + Math.floor(i / cols) * gap;
      g.beginPath(); g.arc(x, y, r0, 0, 7); g.fillStyle = col; g.save(); g.shadowColor = hexa(col, .6); g.shadowBlur = 12; g.fill(); g.restore(); }
  }
  function target(g, cx, cy, r, col) {
    for (let i = 3; i >= 1; i--) { g.beginPath(); g.arc(cx, cy, r * i / 3, 0, 7); g.strokeStyle = hexa(col, .25 + i * .12); g.lineWidth = i === 1 ? 0 : 6; if (i > 1) g.stroke(); }
    g.beginPath(); g.arc(cx, cy, 16, 0, 7); g.fillStyle = col; g.save(); g.shadowColor = hexa(col, .6); g.shadowBlur = 20; g.fill(); g.restore();
    g.strokeStyle = hexa(col, .5); g.lineWidth = 4;
    [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => { g.beginPath(); g.moveTo(cx + dx * (r + 6), cy + dy * (r + 6)); g.lineTo(cx + dx * (r + 30), cy + dy * (r + 30)); g.stroke(); });
  }

  function fit(g, txt, maxW, startPx, font) { let px = startPx; do { g.font = `${px}px ${font}`; if (g.measureText(txt).width <= maxW) break; px -= 6; } while (px > 60); return px; }
  function wrapText(g, txt, x, y, maxW, lh, font) { if (font) g.font = font; const words = String(txt).split(/\s+/); let line = "", yy = y;
    for (const w of words) { const t = line ? line + " " + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, yy); yy += lh; line = w; } else line = t; }
    if (line) g.fillText(line, x, yy); return yy; }
  function spacedCaps(g, txt, x, y, font, col, sp) { g.font = font; g.fillStyle = col; g.textAlign = "left"; let xx = x;
    for (const ch of txt) { g.fillText(ch, xx, y); xx += g.measureText(ch).width + sp; } }
  function roundRect(g, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function hexa(hex, a) { const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  window.B0DESK = { draw: drawCard, A };
})();
