/* Block0 token-gated access — REAL EVM wallet read (no signing, no custody).
   Connect prompts the wallet only to learn the address (eth_requestAccounts); the balance is read server-side via
   /api/gate against the token's chain, so the check is authoritative and the wallet is never asked to sign anything.
   While no GATE_TOKEN is configured the gate is OPEN (the whole site works) — it activates the moment the owner sets
   the token env on the server. The product pages call mount({gated:true}); the landing calls mount({gated:false}). */
const B0GATE = (() => {
  const KEY = "block0_access", ADDRKEY = "block0_addr";
  let CFG = null;

  async function config() { if (CFG) return CFG; try { CFG = await fetch("/api/gate").then((r) => r.json()); } catch { CFG = { enabled: false }; } return CFG; }
  function granted() { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } }
  function setGranted(v) { try { v ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch { /* */ } }
  function savedAddr() { try { return localStorage.getItem(ADDRKEY) || ""; } catch { return ""; } }

  async function check(address) {
    const r = await fetch("/api/gate?address=" + address).then((x) => x.json()).catch(() => null);
    return r;
  }

  // connect the wallet → get address → server-side balance check. onState(state, data) drives the UI.
  async function connect(onState) {
    const cfg = await config();
    if (!window.ethereum) { onState("nowallet", cfg); return; }
    onState("connecting", cfg);
    let addr;
    try { const acc = await window.ethereum.request({ method: "eth_requestAccounts" }); addr = (acc && acc[0] || "").toLowerCase(); }
    catch { onState("rejected", cfg); return; }
    if (!addr) { onState("rejected", cfg); return; }
    try { localStorage.setItem(ADDRKEY, addr); } catch { /* */ }
    try { if (window.B0T) window.B0T("wallet_connect", { wallet: addr }); } catch { /* */ } // forensic: which wallets connect
    onState("reading", cfg);
    const r = await check(addr);
    if (!r) { onState("error", cfg); return; }
    if (r.ok) { setGranted(true); onState("granted", r); }
    else { setGranted(false); onState("denied", r); }
  }

  const fmt = (n) => n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n));

  // wire the header Connect button + (for product pages) a blocking access overlay
  async function mount({ gated = false } = {}) {
    const cfg = await config();
    const btn = document.getElementById("connect"), bar = document.getElementById("gatebar");
    const setBar = (t) => { if (bar) { bar.hidden = !t; bar.textContent = t || ""; } };
    const label = cfg.enabled ? `${fmt(cfg.threshold)} ${cfg.symbol}` : "";

    const onState = (st, d) => {
      if (!btn) return;
      if (st === "connecting") btn.textContent = "Connecting…";
      else if (st === "reading") btn.textContent = "Reading balance…";
      else if (st === "granted") { btn.textContent = "Access ✓"; btn.style.background = "var(--lime)"; setBar(cfg.enabled ? `Access granted — you hold ${fmt(d.balance)} ${cfg.symbol} (need ${label}). Read-only, no signing.` : "Gate is open — the Block0 token isn't live yet. Read-only, no signing, no custody."); hideOverlay(); }
      else if (st === "denied") { btn.textContent = "Not enough tokens"; setBar(`This wallet holds ${fmt(d.balance)} ${cfg.symbol} — access needs ${label}.${cfg.buyUrl ? " Get the token to unlock." : ""}`); showOverlay(d); }
      else if (st === "nowallet") setBar("No EVM wallet found. Install MetaMask or a compatible wallet, then Connect.");
      else if (st === "rejected") { btn.textContent = "Connect"; setBar("Connection cancelled."); }
      else if (st === "error") { btn.textContent = "Connect"; setBar("Couldn't read balance — try again in a moment."); }
    };

    // overlay (product pages only, and only when a token is actually configured)
    let overlay = null;
    function buildOverlay() {
      overlay = document.createElement("div"); overlay.className = "gate-overlay";
      overlay.innerHTML = `<div class="gate-card panel">
        <p class="micro eye">members access</p>
        <h2>Token-gated<span class="blink" style="color:var(--lime)">_</span></h2>
        <p class="gate-sub">Block0 is gated by its token. Connect an EVM wallet — we read your balance, nothing else. No signing, no transactions, no custody. Hold <b style="color:var(--lime)">${label}</b> to unlock the full board, dossiers, bubble maps and the wallet leaderboard.</p>
        <div class="gate-btns"><button class="btn-lime" id="gateConnect">Connect wallet</button>${cfg.buyUrl ? `<a class="btn-ghost" href="${cfg.buyUrl}" target="_blank" rel="noopener">Get the token</a>` : ""}</div>
        <p class="gate-note" id="gateNote">Read-only balance check on ${cfg.chain}. Your keys never leave your wallet.</p>
        <a class="gate-peek" href="/">← back to the landing</a>
      </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector("#gateConnect").addEventListener("click", () => connect((s, d) => {
        const n = overlay.querySelector("#gateNote");
        if (s === "connecting" || s === "reading") n.textContent = "Reading your balance…";
        else if (s === "denied") n.textContent = `This wallet holds ${fmt(d.balance)} ${cfg.symbol} — need ${label}.`;
        else if (s === "nowallet") n.textContent = "No EVM wallet found — install one and retry.";
        else if (s === "rejected") n.textContent = "Connection cancelled.";
        onState(s, d);
      }));
    }
    function showOverlay(d) { if (!gated || !cfg.enabled) return; if (!overlay) buildOverlay(); overlay.style.display = "flex"; }
    function hideOverlay() { if (overlay) overlay.style.display = "none"; }

    if (btn) btn.addEventListener("click", () => connect(onState));

    // decide initial state
    if (gated && cfg.enabled && !granted()) { buildOverlay(); overlay.style.display = "flex"; }
    else if (granted()) onState("granted", { balance: null });
    return { connect, config, showOverlay, hideOverlay };
  }

  return { config, granted, connect, mount };
})();
