// The live "bubblemap on a chart": a diverging time-series of wallet trades. X = time, buys bubble UP (green),
// sells bubble DOWN (red), vertical distance & radius ∝ trade size (log), a brand-new wallet gets a white ring
// and a spawn flash. Live events pushed from SSE slide in at the right edge. Pure canvas — fast, dependency-free.
const COL = { bg: "#0a0f0c", grid: "rgba(120,200,150,.10)", axis: "rgba(120,200,150,.28)",
  buy: "#43d17f", sell: "#ff6f6f", txt: "#7d9385", ring: "#ffffff" };

export function mountChart(canvas, tipEl) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = Math.min(devicePixelRatio || 1, 2);
  let bubbles = [];            // {ts, w, amt, side, isNew, born}
  const seen = new Set();      // wallets we've seen (to flag genuinely new ones on the live tail)
  let t0 = 0, t1 = 0, maxAmt = 1, hoverIdx = -1, mx = 0, my = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height; canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function recompute() {
    const ts = bubbles.map((b) => b.ts).filter(Boolean);
    t0 = ts.length ? Math.min(...ts) : Date.now() / 1000 - 3600;
    t1 = Math.max(Date.now() / 1000, ts.length ? Math.max(...ts) : 0);
    maxAmt = Math.max(1, ...bubbles.map((b) => b.amt));
  }
  const padL = 8, padR = 8, padB = 22, padT = 8;
  const xOf = (ts) => padL + ((ts - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const cy = () => (H - padB + padT) / 2;
  const yOf = (b) => { const mag = Math.log10(1 + b.amt) / Math.log10(1 + maxAmt); const half = (H - padB - padT) / 2 - 10;
    return cy() + (b.side === "buy" ? -1 : 1) * (12 + mag * half); };
  const rOf = (b) => { const mag = Math.sqrt(b.amt) / Math.sqrt(maxAmt); return 4 + mag * 26; };

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // center axis + grid
    ctx.strokeStyle = COL.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, cy()); ctx.lineTo(W - padR, cy()); ctx.stroke();
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (let g = 1; g <= 4; g++) { const step = (W - padL - padR) / 4; const x = padL + step * g; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke(); }
    // time ticks
    ctx.fillStyle = COL.txt; ctx.font = "11px 'IBM Plex Mono',monospace"; ctx.textAlign = "center";
    for (let g = 0; g <= 4; g++) { const x = padL + ((W - padL - padR) / 4) * g; const t = t0 + (t1 - t0) * (g / 4);
      const d = new Date(t * 1000); ctx.fillText(d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0"), x, H - 7); }
    ctx.textAlign = "left"; ctx.fillStyle = "rgba(67,209,127,.5)"; ctx.fillText("▲ buys", padL + 2, padT + 12);
    ctx.fillStyle = "rgba(255,111,111,.5)"; ctx.fillText("▼ sells", padL + 2, H - padB - 4);

    const now = performance.now();
    bubbles.forEach((b, i) => {
      if (!b.ts) return;
      const x = xOf(b.ts), y = yOf(b), r = rOf(b);
      const age = b.born ? (now - b.born) / 900 : 1;           // spawn flash 0→1
      const grow = reduce ? 1 : Math.min(1, age);
      const col = b.side === "buy" ? COL.buy : COL.sell;
      ctx.beginPath(); ctx.arc(x, y, r * (0.7 + 0.3 * grow), 0, 7); ctx.fillStyle = col; ctx.globalAlpha = 0.22 + 0.4 * grow; ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = i === hoverIdx ? 2 : 1; ctx.strokeStyle = col; ctx.stroke();
      if (b.isNew) { // white ring + fading halo for a brand-new wallet
        ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 7); ctx.strokeStyle = COL.ring; ctx.globalAlpha = reduce ? 0.9 : Math.max(0.25, 1 - age * 0.5); ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
      }
    });
  }

  let raf = 0;
  function loop() { draw(); raf = requestAnimationFrame(loop); }

  // hit-testing for the tooltip
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect(); mx = e.clientX - rect.left; my = e.clientY - rect.top;
    let best = -1, bd = 16 * 16;
    bubbles.forEach((b, i) => { if (!b.ts) return; const dx = xOf(b.ts) - mx, dy = yOf(b) - my; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } });
    hoverIdx = best;
    if (best >= 0) { const b = bubbles[best];
      tipEl.style.display = "block"; tipEl.style.left = Math.min(mx + 12, W - 150) + "px"; tipEl.style.top = (my + 12) + "px";
      const amt = b.amt >= 1e6 ? (b.amt / 1e6).toFixed(2) + "M" : b.amt >= 1e3 ? (b.amt / 1e3).toFixed(1) + "k" : b.amt.toFixed(0);
      tipEl.innerHTML = `<b class="${b.side === "sell" ? "s-sell" : ""}">${b.side.toUpperCase()} ${amt}</b><br>${b.w.slice(0, 6)}…${b.w.slice(-4)}${b.isNew ? " · new" : ""}<br>${b.ts ? new Date(b.ts * 1000).toLocaleTimeString() : ""}`;
    } else tipEl.style.display = "none";
  });
  canvas.addEventListener("pointerleave", () => { hoverIdx = -1; tipEl.style.display = "none"; });

  const api = {
    load(events) {
      bubbles = (events || []).filter((e) => e.side === "buy" || e.side === "sell").map((e) => ({ ...e, born: 0, isNew: false }));
      seen.clear(); for (const b of bubbles) seen.add(b.w);
      recompute(); resize();
      if (!raf) loop();
    },
    push(e) { // a live tx from SSE
      const isNew = !seen.has(e.w); seen.add(e.w);
      bubbles.push({ ts: e.ts || Date.now() / 1000, w: e.w, amt: e.amt, side: e.side, isNew, born: performance.now() });
      if (bubbles.length > 1200) bubbles.splice(0, bubbles.length - 1200);
      recompute();
    },
    resize() { resize(); },
  };
  resize();
  return api;
}

export function renderChart() { /* reserved for a static server-side render path */ }
