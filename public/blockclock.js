/* Live block-clock — fills every `.blockclock` with "block N · HH:MM:SS UTC" to show the scanner is watching the
   chain in real time. UTC ticks locally every second; the chain head refreshes from /api/head every ~15s (server
   caches it ~10s, so many visitors don't mean many RPC calls). Exposes window.B0CLOCK.paint() for freshly-rendered
   nodes (e.g. the hero card re-render). */
(function () {
  let block = 0;
  const p2 = (n) => String(n).padStart(2, "0");
  function utc() { const d = new Date(); return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + ":" + p2(d.getUTCSeconds()) + " UTC"; }
  function text() { return (block ? "block " + block.toLocaleString() + " · " : "") + utc(); }
  function paint() { const s = text(); const els = document.querySelectorAll(".blockclock"); for (const el of els) el.textContent = s; }
  async function head() { try { const d = await fetch("/api/head").then((r) => r.json()); if (d && d.block) block = d.block; } catch (e) { /* keep last */ } paint(); }
  window.B0CLOCK = { paint, text };
  paint(); head();
  setInterval(paint, 1000);
  setInterval(head, 15000);
  // refresh the block sooner when the tab regains focus (it may have been asleep)
  document.addEventListener("visibilitychange", () => { if (!document.hidden) head(); });
})();
