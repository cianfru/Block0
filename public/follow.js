/* FOLLOW A LAUNCH — the watchlist, kept in this browser only (no account, nothing leaves the device).
   { address: { sym, since, seenAt } } in localStorage. The dossier marks a launch seen when it is opened; the live
   feed shows each followed launch's changes since then first. Storage can be unavailable (private mode, blocked
   site data): every call degrades to "not following" rather than throwing. */
(function () {
  const KEY = "b0.follow", MAX = 30;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; } };
  const write = (m) => { try { localStorage.setItem(KEY, JSON.stringify(m)); return true; } catch { return false; } };
  const norm = (a) => String(a || "").toLowerCase();
  const B0F = {
    list: () => Object.entries(read()).map(([address, v]) => ({ address, ...v })).sort((a, b) => (b.since || 0) - (a.since || 0)),
    has: (a) => !!read()[norm(a)],
    toggle(a, sym) {
      const m = read(), k = norm(a);
      if (m[k]) delete m[k];
      else { if (Object.keys(m).length >= MAX) return { ok: false, why: `You can follow up to ${MAX} launches.` }; m[k] = { sym: sym || null, since: Date.now(), seenAt: Date.now() }; }
      return { ok: write(m), following: !!m[k] };
    },
    seen(a, sym) { const m = read(), k = norm(a); if (!m[k]) return; m[k].seenAt = Date.now(); if (sym) m[k].sym = sym; write(m); },
    // a button that keeps its own label in sync; `cls` lets each page style it
    button(a, sym, cls = "followbtn") {
      const on = B0F.has(a);
      return `<button class="${cls}${on ? " on" : ""}" data-follow="${norm(a)}" data-sym="${String(sym || "").replace(/[^\w$.-]/g, "")}" aria-pressed="${on}">${on ? "★ Following" : "☆ Follow"}</button>`;
    },
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-follow]"); if (!b) return;
    const r = B0F.toggle(b.dataset.follow, b.dataset.sym);
    if (!r.ok) { b.textContent = r.why || "Your browser blocked saving this"; return; }
    b.classList.toggle("on", r.following); b.setAttribute("aria-pressed", r.following);
    b.textContent = r.following ? "★ Following" : "☆ Follow";
    window.B0T && window.B0T(r.following ? "follow" : "unfollow", { token: b.dataset.follow });
    document.dispatchEvent(new CustomEvent("b0follow", { detail: { address: b.dataset.follow, following: r.following } }));
  });
  window.B0F = B0F;
})();
