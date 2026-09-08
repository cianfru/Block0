// All source strings go through textContent. No token-controlled HTML, links or class names.
(() => {
  const $ = (s) => document.querySelector(s), isRecord = document.body.dataset.page === "record";
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const money = (n) => Number.isFinite(n) ? "$" + n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "Unknown";
  const pct = (n) => Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "Unknown";
  const when = (t) => t ? new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "Not yet";
  function metric(value, label) { const n = el("div", null, "metric"); n.append(el("strong", value), el("span", label)); return n; }
  function fields(pairs) { const dl = el("dl"); for (const [k,v] of pairs) { const cell = el("div"); cell.append(el("dt",k),el("dd",v)); dl.append(cell); } return dl; }
  function link(address, sym) { const a = el("a", sym || address.slice(0, 10)); a.href = "/token?address=" + encodeURIComponent(address); return a; }
  const states = new Set(["triggered","building","observing","deteriorating","invalidated","expired","unavailable","unknown","pending","resolved"]);
  function card(row) {
    const outcome = row.outcome || { status: "pending" }, f = row.features || {};
    const state = isRecord ? outcome.status : row.displayState, c = el("article", null, "card " + (states.has(state) ? state : "observing"));
    const h = el("h2"); h.append(link(row.address,row.sym),el("span",state,"badge")); c.append(h);
    if (isRecord) {
      c.append(el("p", row.strategy + " · " + when(row.at)));
      c.append(fields([["Outcome",outcome.reason || outcome.status],["Cost-scenario return",pct(outcome.scenarioReturn)],["Entry observation",when(outcome.entryAt)],["Exit observation",when(outcome.exitAt)]]));
      c.append(el("p", "Indicative prices with 1% per-side costs. Execution, gas and impact unverified."));
    } else {
      const reasons = row.stale ? ["No recent observation; previous setup is not current."] : row.setup?.reasons || ["Waiting for sufficient forward observations."];
      const ul = el("ul"); for (const reason of reasons) ul.append(el("li",reason)); c.append(ul);
      c.append(fields([["Holder growth",pct(f.holderGrowth)],["15m price change",pct(f.momentum15m)],["Observed liquidity",money(row.latest?.liquidityUsd)],["Last observation",when(row.latest?.observedAt)]]));
    }
    const detail = el("details"); detail.append(el("summary", "Evidence and limitations"));
    detail.append(el("p", "Feature version: " + (f.version || "not available") + ". Wallet independence is unverified; Reflex is not connected."));
    for (const q of row.latest?.quality || []) detail.append(el("p",q));
    for (const t of row.transitions || []) detail.append(el("p",when(t.at) + " · " + (t.from || "new") + " → " + t.to));
    if (isRecord) detail.append(el("p", "Decision ID: " + row.id));
    c.append(detail); return c;
  }
  let loading = false;
  async function load() {
    if (loading) return; loading = true; $("#refresh").disabled = true;
    try {
      const state = $("#filter")?.value || "";
      const url = isRecord ? "/api/track-record?calls=200" : "/api/setups?n=100&state=" + encodeURIComponent(state);
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const r = await response.json(), coverage = r.coverage || {};
      const status = $("#status"); status.className = "status" + (r.error ? " error" : "");
      status.textContent = (r.enabled === false ? "Collection disabled. " : "") + (r.error ? "Collection issue: " + r.error + ". " : "") + "Ever eligible: " + (coverage.eligibleTokens || 0) + " of " + (coverage.registrySize || 0) + " registered tokens (budget-dependent" + (coverage.eligibilityLowerBound ? "; lower bound" : "") + "). Tracking " + (coverage.cohortSize || 0) + " tokens; " + (coverage.trackedObservedThisCycle || 0) + " refreshed in the last cycle. Last cycle: " + when(r.updated) + ". Scope: Pons API-visible catalogs; coverage is partial. " + (coverage.dueRemaining ? coverage.dueRemaining + " observations awaiting budget." : "");
      $("#metrics").replaceChildren(...(isRecord ? [metric(r.predicted || 0,"frozen decisions"),metric(r.resolved || 0,"resolved indicative outcomes"),metric(r.unknown || 0,"unknown outcomes")] : [metric(coverage.registrySize || 0,"tokens registered"),metric(coverage.sampledThisCycle || 0,"observed in latest cycle"),metric(coverage.omittedThisCycle || 0,"omitted by registry cap this cycle")]));
      const rows = isRecord ? r.calls || [] : r.rows || [];
      $("#count").textContent = "Showing " + rows.length + (isRecord ? " most recent decisions" : " of " + (r.total || 0) + " matching tokens");
      $("#rows").replaceChildren(...(rows.length ? rows.map(card) : [el("div", isRecord ? "No frozen decisions yet. The record begins when a setup triggers after sufficient forward observations." : "No matching setups. Collection may still be warming up, or the experimental conditions are absent.","empty")]));
    } catch (e) { $("#status").textContent = "Data unavailable: " + e.message + ". Any displayed observations may be stale. Retry with Refresh."; $("#status").className = "status error"; }
    finally { loading = false; $("#refresh").disabled = false; }
  }
  $("#refresh").addEventListener("click",load); $("#filter")?.addEventListener("change",load); load();
  setInterval(() => { if (!document.hidden) load(); },60000);
})();
