/* Shared renderers for the Block0 pages — the token card (board + landing) and the leaderboard row — so the
   look never drifts between surfaces. Vanilla, no build step. */
const B0 = (() => {
  const HEX = (r) => r >= 66 ? "#ff3b5c" : r >= 45 ? "#ffd23d" : r >= 25 ? "#35e6e0" : "#c8ff4d";
  const mcT = (x) => !x ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "K" : "$" + Math.round(x);
  const usd = (x) => { const n = Math.abs(x); const s = x < 0 ? "-" : ""; return !n ? "$0" : n >= 1e6 ? `${s}$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${s}$${(n / 1e3).toFixed(1)}K` : `${s}$${Math.round(n)}`; };
  const fmtAge = (h) => h == null ? "—" : h < 1 ? Math.round(h * 60) + "m" : h < 48 ? h.toFixed(1) + "h" : Math.round(h / 24) + "d";
  const sev = (v) => v >= 66 ? "#ff3b5c" : v >= 45 ? "#ffd23d" : v >= 25 ? "#35e6e0" : "#c8ff4d";
  const isNew = (r) => r.isNew || (r.firstSeenAt && Date.now() - r.firstSeenAt < 150000);

  function icon(r) {
    const sym = r.sym || "?"; const c = HEX(r.risk);
    const ini = (sym.replace(/[^A-Za-z0-9]/g, "")[0] || "?").toUpperCase();
    const st = `color:${c};background:${c}12`;
    return r.logo ? `<div class="mono-ic" style="${st}"><img src="${r.logo}" alt="" loading="lazy" onerror="this.parentNode.textContent='${ini}'"></div>` : `<div class="mono-ic" style="${st}">${ini}</div>`;
  }
  // a meter with a NEON value line — the fill carries a glow in its own colour
  function meter(lab, v, det) {
    const col = sev(v);
    return `<div class="meter"><div class="mh"><span>${lab}</span><b class="tnum" style="color:${col}">${v}</b></div>` +
      `<div class="track"><div class="fill" style="width:${Math.max(2, Math.min(100, v))}%;background:${col};box-shadow:0 0 9px ${col}99,0 0 2px ${col}"></div></div>` +
      `${det ? `<div class="det">${det}</div>` : ""}</div>`;
  }
  const chip = (txt, color) => `<span class="chip"${color ? ` style="color:${color}"` : ""}>${txt}</span>`;

  function tokenCard(r, i) {
    const f = r.flags || {}, p = r.parts || {}, c = HEX(r.risk), tooEarly = r.ageH < 0.5;
    const meters = [
      meter("Snipers", p.snipers || 0, f.snipers ? `${f.snipers} · ${f.sniperHeldPct}% held` : "none"),
      meter("Bundles", p.bundles || 0, f.bundles ? `${f.bundles} · ${f.bundleHeldPct}% held` : "none"),
      meter("Concentration", p.concentration || 0, `top 10 · ${f.top10Pct}%`),
      meter("Dumping now", p.dumping || 0, f.insiderSellersNow ? `${f.insiderSellersNow} selling` : "none"),
    ].join("");
    const venue = r.venue === "uniswap-v4" ? chip("uniswap-v4", "#ff5cf0") : chip(r.section === "graduated" ? "graduated" : "launchpad · pons", "#35e6e0");
    const CS = { "on-track": "#c8ff4d", "behind": "#ffd23d", "drifting": "#ffd23d", "failing": "#ff3b5c" };
    const bpChips = (r.venue !== "uniswap-v4") ? [
      r.blueprint != null ? chip(`blueprint ${r.blueprint} · ${r.blueprintLabel || ""}`) : "",
      r.corridor ? chip(`corridor ${r.corridor.status}`, CS[r.corridor.status] || "#ffd23d") : "",
    ].join("") : "";
    const curve = (r.progress != null) ? chip(`curve ${r.progress}%`) : "";
    const prec = r.path ? `<div class="precedent tnum">${(f.wallets || f.holders || 0).toLocaleString()} wallets → <b>${mcT(r.path.precedent)}</b> <span class="m">precedent mcap</span></div>` : "";
    const al = r.alert ? `<p class="alert" style="color:${r.alert.tone === "good" ? "#c8ff4d" : r.alert.tone === "warn" ? "#ffd23d" : "#ff3b5c"}">${r.alert.tone === "bad" ? "▼ " : r.alert.tone === "good" ? "✓ " : "! "}${r.alert.text}</p>`
      : f.insiderSellersNow ? `<p class="alert" style="color:#ff3b5c">▼ ${f.insiderSellersNow} insider${f.insiderSellersNow > 1 ? "s" : ""} selling now</p>`
        : (!f.snipers && !f.bundles) ? `<p class="alert" style="color:#c8ff4d">✓ no snipers · no bundles</p>` : "";
    return `<a class="panel panel-hover tcard${isNew(r) ? " new" : ""}" href="/token?address=${r.address}" style="animation-delay:${Math.min(i * 60, 600)}ms">
      <div class="body">
        <div class="top">${icon(r)}
          <div style="min-width:0">
            <div class="tsym">${r.sym || "?"}${isNew(r) ? '<span class="newbadge">NEW</span>' : ""}</div>
            <div class="micro" style="margin-top:3px">${mcT(r.mcapUsd)} mcap · ${fmtAge(r.ageH)} old</div>
          </div>
          <div class="rscore"><span class="n" style="color:${c};text-shadow:0 0 26px ${c}66">${r.risk}</span><span class="l" style="color:${c}">${tooEarly ? "Too early" : r.label}</span></div>
        </div>
        <div class="meters">${meters}</div>
        <div class="chiprow">${venue}${bpChips}${curve}</div>
        ${prec}${al}
      </div></a>`;
  }

  // ---- wallet identity: a clean codename + gradient avatar from the address (never a raw hex string) ----
  const ADJ = ["Silent", "Golden", "Crimson", "Azure", "Feral", "Lucid", "Iron", "Neon", "Velvet", "Rogue", "Amber", "Cobalt", "Onyx", "Solar", "Frost", "Ember"];
  const NOUN = ["Fox", "Whale", "Falcon", "Wolf", "Orca", "Hawk", "Viper", "Lynx", "Raven", "Shark", "Otter", "Puma", "Heron", "Mako", "Koi", "Crane"];
  function hashOf(a) { let h = 0; const s = (a || "").toLowerCase(); for (let i = 2; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function codename(a) { const h = hashOf(a); return `${ADJ[h % ADJ.length]} ${NOUN[(h >> 5) % NOUN.length]}`; }
  function avatar(a, size = 34) {
    const h = hashOf(a); const h1 = h % 360, h2 = (h1 + 60 + (h % 90)) % 360;
    return `<span class="w-av" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,hsl(${h1} 90% 60%),hsl(${h2} 85% 55%))"></span>`;
  }

  // ---- leaderboard row: avatar + codename + big realised PnL + sub-stats, links to Zerion ----
  function leaderRow(w, rank, zerionBase) {
    const up = (w.pnl || w.realized) >= 0;
    const col = up ? "#c8ff4d" : "#ff3b5c";
    const href = zerionBase ? `${zerionBase}/${w.a}` : "#";
    const toks = (w.tokens || []).slice(0, 4).map((t) => `<span class="chip">${t.sym}${t.holding ? " ·hold" : ""}</span>`).join("");
    return `<a class="lb-row panel-hover" href="${href}" target="_blank" rel="noopener">
      <span class="lb-rank">${rank}</span>
      ${avatar(w.a, 38)}
      <span class="lb-id">
        <span class="lb-name">${codename(w.a)}</span>
        <span class="micro">${w.tokensWon} win${w.tokensWon === 1 ? "" : "s"} · ${w.winRate != null ? w.winRate + "% hit" : "—"}${w.holdingAny ? " · holding" : ""}</span>
      </span>
      <span class="lb-toks">${toks}</span>
      <span class="lb-pnl">
        <span class="v tnum" style="color:${col};text-shadow:0 0 20px ${col}55">${up ? "+" : "−"}${usd(Math.abs(w.pnl != null ? w.pnl : w.realized))}</span>
        <span class="micro">realised${w.roi != null ? ` · ${w.roi >= 0 ? "+" : ""}${(w.roi * 100).toFixed(0)}% ROI` : ""}</span>
      </span>
      <span class="lb-go">Zerion ↗</span>
    </a>`;
  }

  return { HEX, mcT, usd, fmtAge, sev, isNew, icon, meter, chip, tokenCard, codename, avatar, leaderRow };
})();
