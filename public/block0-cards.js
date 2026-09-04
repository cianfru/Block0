/* Shared renderers for the Block0 pages — the token card (board + landing) and the leaderboard row — so the
   look never drifts between surfaces. Vanilla, no build step. */
const B0 = (() => {
  const HEX = (r) => r >= 66 ? "#ff3b5c" : r >= 45 ? "#ffd23d" : r >= 25 ? "#35e6e0" : "#c8ff4d";
  const mcT = (x) => !x ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "K" : "$" + Math.round(x);
  const usd = (x) => { const n = Math.abs(x); const s = x < 0 ? "-" : ""; return !n ? "$0" : n >= 1e6 ? `${s}$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${s}$${(n / 1e3).toFixed(1)}K` : `${s}$${Math.round(n)}`; };
  const fmtAge = (h) => h == null ? "—" : h < 1 ? Math.round(h * 60) + "m" : h < 48 ? h.toFixed(1) + "h" : Math.round(h / 24) + "d";
  const sev = (v) => v >= 66 ? "#ff3b5c" : v >= 45 ? "#ffd23d" : v >= 25 ? "#35e6e0" : "#c8ff4d";
  const isNew = (r) => r.isNew || (r.firstSeenAt && Date.now() - r.firstSeenAt < 150000);
  // HTML-escape — token symbols/names come from on-chain metadata (permissionless), so they are attacker-controlled
  // and MUST be escaped anywhere they land in innerHTML. Shared as B0.esc so every page uses the same guard.
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

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

  // ── polished monoline icon set (currentColor, 1em, rounded) — replaces cheap emoji everywhere ──────────────────
  const ICONS = {
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
    radar: '<circle cx="12" cy="12" r="9" opacity=".45"/><circle cx="12" cy="12" r="5.4" opacity=".75"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><path d="M12 12 19 6"/>',
    sliders: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2.3" fill="var(--bg,#08080b)"/><circle cx="15" cy="12" r="2.3" fill="var(--bg,#08080b)"/><circle cx="8" cy="17" r="2.3" fill="var(--bg,#08080b)"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9z"/>',
    bolt: '<path d="M13 2 5 13h5l-1 9 10-13h-5l1-7z" stroke-linejoin="round"/>',
    warn: '<path d="M12 3.2 22 20H2z" stroke-linejoin="round"/><path d="M12 9v5"/><circle cx="12" cy="17.4" r=".65" fill="currentColor" stroke="none"/>',
    trend: '<path d="M3 16.5 9.5 10l4 3.5L21 6"/><path d="M15.5 6H21v5.5"/>',
    check: '<path d="M4 12.5 9.5 18 20 5.5"/>',
  };
  const ico = (name, cls = "") => {
    const p = ICONS[name]; if (!p) return "";
    return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">${p}</svg>`;
  };

  function tokenCard(r, i) {
    const f = r.flags || {}, p = r.parts || {}, c = HEX(r.risk), tooEarly = r.ageH < 0.5;
    const meters = [
      meter("Snipers", p.snipers || 0, f.snipers ? `${f.snipers} · ${f.sniperHeldPct}% held` : "none"),
      meter("Bundles", p.bundles || 0, f.bundles ? `${f.bundles} · ${f.bundleHeldPct}% held` : "none"),
      meter("Concentration", p.concentration || 0, `top 10 · ${f.top10Pct}%`),
      meter("Dumping now", p.dumping || 0, f.insiderSellersNow ? `${f.insiderSellersNow} selling` : "none"),
    ].join("");
    // DEX-discovered tokens carry a real venue (uniswap-v2/v3/v4 or a factory label); Pons tokens don't.
    const DEXVEN = { "uniswap-v4": "#ff5cf0", "uniswap-v3": "#7aa2ff", "uniswap-v2": "#ffd23d" };
    const isDex = r.section === "dex" || (!!r.venue && r.venue !== "pons");
    const venue = isDex
      ? `<span class="chip" style="color:${DEXVEN[r.venue] || "#c8ff4d"}"${r.factory ? ` title="factory ${r.factory}"` : ""}>${r.venue || "dex"}</span>`
        + ((r.venues && r.venues.length > 1) ? `<span class="chip" style="color:var(--mute)" title="also on ${r.venues.join(", ")}">+${r.venues.length - 1}</span>` : "")
      : chip(r.section === "graduated" ? "graduated" : "launchpad · pons", "#35e6e0");
    const CS = { "on-track": "#c8ff4d", "behind": "#ffd23d", "drifting": "#ffd23d", "failing": "#ff3b5c" };
    const bpChips = !isDex ? [
      r.blueprint != null ? chip(`blueprint ${r.blueprint} · ${r.blueprintLabel || ""}`) : "",
      r.corridor ? chip(`corridor ${r.corridor.status}`, CS[r.corridor.status] || "#ffd23d") : "",
    ].join("") : "";
    const curve = (r.progress != null) ? chip(`curve ${r.progress}%`) : "";
    const prec = r.path ? `<div class="precedent tnum">${(f.wallets || f.holders || 0).toLocaleString()} wallets → <b>${mcT(r.path.precedent)}</b> <span class="m">precedent mcap</span></div>` : "";
    const al = r.alert ? `<p class="alert" style="color:${r.alert.tone === "good" ? "#c8ff4d" : r.alert.tone === "warn" ? "#ffd23d" : "#ff3b5c"}">${r.alert.tone === "bad" ? "▼ " : r.alert.tone === "good" ? "✓ " : "! "}${esc(r.alert.text)}</p>`
      : f.insiderSellersNow ? `<p class="alert" style="color:#ff3b5c">▼ ${f.insiderSellersNow} insider${f.insiderSellersNow > 1 ? "s" : ""} selling now</p>`
        : (!f.snipers && !f.bundles) ? `<p class="alert" style="color:#c8ff4d">✓ no snipers · no bundles</p>` : "";
    // BUNDLES are the loudest red flag on a launch — one actor wearing many wallets. Flag it hard, up top.
    const bundleFlag = f.bundles ? `<div class="bundleflag">${ico("warn")}<span><b>${f.bundles} bundle${f.bundles > 1 ? "s" : ""} detected</b>${f.bundleHeldPct ? ` — ${f.bundleHeldPct}% of supply bought as one` : " — coordinated same-block buys"}</span></div>` : "";
    const liveDanger = (r.alert && r.alert.tone === "bad") || f.insiderSellersNow;   // actively being dumped → the card buzzes
    const sm = r.smart && r.smart.count ? r.smart : null;
    const smBreak = sm && sm.riding ? ` <span class="smb">${sm.proven} proven · ${sm.riding} riding</span>` : "";
    const smartRow = sm ? `<div class="smart${sm.count >= 2 ? " conv" : ""}" title="${sm.wallets.map((w) => codename(w.a) + (w.kind ? " (" + w.kind + ")" : "") + (w.tokensWon ? " · " + w.tokensWon + " wins" : "")).join("\n")}">${ico("target")} <b>${sm.count}</b> smart-money wallet${sm.count > 1 ? "s" : ""} holding${sm.count >= 2 ? " · converging" : ""}${smBreak}</div>` : "";
    return `<a class="panel panel-hover tcard${isNew(r) ? " new" : ""}${liveDanger ? " live" : ""}${f.bundles ? " bundled" : ""}${sm && sm.count >= 2 ? " smartconv" : ""}" href="/token?address=${r.address}" style="animation-delay:${Math.min(i * 60, 600)}ms">
      <div class="body">
        <div class="top">${icon(r)}
          <div style="min-width:0">
            <div class="tsym">${esc(r.sym || "?")}${isNew(r) ? '<span class="newbadge">NEW</span>' : ""}</div>
            <div class="micro" style="margin-top:3px">${mcT(r.mcapUsd)} mcap · ${fmtAge(r.ageH)} old</div>
          </div>
          <div class="rscore"><span class="n" style="color:${c};text-shadow:0 0 26px ${c}66">${r.risk}</span><span class="l" style="color:${c}">${tooEarly ? "Too early" : r.label}</span></div>
        </div>
        ${bundleFlag}
        <div class="meters">${meters}</div>
        <div class="chiprow">${venue}${bpChips}${curve}</div>
        ${smartRow}${prec}${al}
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

  // ---- leaderboard row: avatar + codename + big realised PnL (our engine) + sub-stats. The whole row opens OUR
  //      per-wallet PnL page (/wallet?a=) — our own reconstruction, not a third-party portfolio service. ----
  function leaderRow(w, rank /* explorerBase kept for signature compat, unused */) {
    const up = (w.pnl || w.realized) >= 0;
    const col = up ? "#c8ff4d" : "#ff3b5c";
    const toks = (w.tokens || []).slice(0, 4).map((t) => `<span class="chip">${esc(t.sym)}${t.holding ? " ·hold" : ""}</span>`).join("");
    return `<a class="lb-row panel-hover" href="/wallet?a=${w.a}">
      <span class="lb-rank">${rank}</span>
      ${avatar(w.a, 38)}
      <span class="lb-id">
        <span class="lb-name">${codename(w.a)}${w.contract ? ' <span class="ctag">contract</span>' : ""}</span>
        <span class="micro">${w.tokensWon} win${w.tokensWon === 1 ? "" : "s"} · ${w.winRate != null ? w.winRate + "% hit" : "—"}${w.holdingAny ? " · holding" : ""}</span>
      </span>
      <span class="lb-toks">${toks}</span>
      <span class="lb-pnl">
        <span class="v tnum" style="color:${col};text-shadow:0 0 20px ${col}55">${up ? "+" : "−"}${usd(Math.abs(w.pnl != null ? w.pnl : w.realized))}</span>
        <span class="micro">realised${w.roi != null ? ` · ${w.roi >= 0 ? "+" : ""}${(w.roi * 100).toFixed(0)}% ROI` : ""}</span>
      </span>
      <span class="lb-go">PnL →</span>
    </a>`;
  }

  return { HEX, mcT, usd, fmtAge, sev, isNew, icon, ico, meter, chip, tokenCard, codename, avatar, leaderRow, esc };
})();
