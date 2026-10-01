// ONE AGENT CYCLE — discover → read → detect → gate → format → publish (or log, in dry run) → mentions.
// Every dependency is injected (Orbio client, Pons list readers, the token reader, the clock), so the tick is tested
// without a network and the CLI (tools/agent-tick.mjs) is only wiring.
//
// House rules this file enforces (CLAUDE.md):
//   • it never touches the parked board (no board.mjs import, no refreshBoard/ensureFresh, no BACKGROUND_ON);
//   • token reads go through computeIntel on the FREE native node — there is no metered fallback here at all;
//   • unvalidated signal kinds (smart-convergence, clean-launch) are logged, never posted;
//   • dry run is the default — only AGENT_DRY_RUN=0 publishes.
import { detectEvents } from "../alert-events.mjs";
import { normAgent, agentEvents } from "./agent-events.mjs";
import { formatPost, formatReply, lint, UNVALIDATED } from "./format.mjs";
import { plan, record, canReply, freshBudget, DEFAULT_CAPS } from "./budget.mjs";
import { parseMention, resolveSymbol, selectMentions } from "./mentions.mjs";
import { OrbioError, FREE, postOutcome, mentionsOf } from "./orbio.mjs";
import { deployerReputation, compactRep } from "../deployer.mjs";

// maxProfiles is a ceiling, not the working limit — the time budget is. A token's FIRST read in a process is a full
// history pull (a busy 2-day-old token: 36 s, 226 eth_getLogs on the free node); every later read is a delta
// (0.1 s, 1 call). So a long-lived --watch process converges to re-reading every live candidate each cycle.
export const DEFAULTS = { maxAgeH: 72, minMcap: 5000, maxProfiles: 150, timeBudgetMs: 8 * 60e3, concurrency: 3, keepDays: 7 };

export function emptyState() {
  return { prevAgents: {}, lastFiredAgents: {}, prevBoard: {}, lastFiredBoard: {}, profiledAt: {}, perToken: {}, budget: null, answered: {}, stoppedDay: null };
}

export async function runTick(deps) {
  const { orbio, pons, readToken, now = Date.now(), dryRun = true, forwardN = null, caps = {}, log = () => {} } = deps;
  const o = { ...DEFAULTS, ...(deps.opts || {}) };
  const state = { ...emptyState(), ...(deps.state || {}) };
  const out = { posted: [], dryRun: [], logged: [], held: [], replies: [], errors: [], tokens: [], stats: null, account: null, events: [] };
  const started = Date.now();

  // 1 · Orbio agents (free) → economics events
  let agents = [], orbioUsd = null;
  try { const r = await orbio.allAgents(); orbioUsd = r.orbioUsd; agents = r.agents.map((x) => normAgent(x, now)); }
  catch (e) { out.errors.push("orbio agents: " + e.message); }
  const ae = agentEvents(state.prevAgents, agents, { now, orbioUsd, lastFired: state.lastFiredAgents });
  if (agents.length) { state.prevAgents = ae.next; state.lastFiredAgents = ae.lastFired; }
  const agentByToken = new Map(agents.map((a) => [a.address, a]));

  // 2 · launch universe (free): Pons active (newest) + graduated, tagged with Orbio membership
  const universe = new Map();
  try {
    const [act, grad] = await Promise.all([pons.fetchActive({ pageSize: 100, sort: "newest", age: "7d" }), pons.fetchGraduated()]);
    for (const t of [...act.items, ...grad.items]) if (t.address) universe.set(t.address, t);
    out.stats = { launchTotal: act.launchTotal || null, graduatedTotal: grad.items.length || null };
  } catch (e) { out.errors.push("pons: " + e.message); }
  for (const a of agents) if (!universe.has(a.address)) universe.set(a.address, { address: a.address, sym: a.sym, mcapUsd: a.mcapUsd, launchedAt: a.launchedAt ? new Date(a.launchedAt * 1000).toISOString() : null, graduated: a.graduated });
  const ageH = (t) => (t.launchedAt ? (now - Date.parse(t.launchedAt)) / 3.6e6 : null);
  // who launched it, and what else they launched. An Orbio agent's owner is checked against EVERY agent (complete);
  // a Pons deployer only against the launches in view (latest 100 of the last 7 days + every graduated token).
  const launchList = [...universe.values()];
  const deployerOf = (t) => {
    const ag = agentByToken.get(t.address);
    if (ag?.owner) { const prior = agents.filter((x) => x.owner === ag.owner);
      return { address: ag.owner, launched: prior.length, graduated: prior.filter((x) => x.graduated).length, faded: null, scope: "every Orbio agent" }; }
    const r = compactRep(deployerReputation(launchList, t));
    return r ? { ...r, scope: "the latest 100 Pons launches (7 days) and every graduated token" } : null;
  };

  // 3 · candidates: young, not dust; Orbio agents first, then the least recently read (rotation under the cap)
  const cands = [...universe.values()].filter((t) => { const h = ageH(t); return h != null && h >= 0 && h <= o.maxAgeH && (t.mcapUsd || 0) >= o.minMcap; })
    .sort((x, y) => (agentByToken.has(y.address) - agentByToken.has(x.address)) || ((state.profiledAt[x.address] || 0) - (state.profiledAt[y.address] || 0)) || (y.mcapUsd || 0) - (x.mcapUsd || 0))
    .slice(0, o.maxProfiles);

  // 4 · read candidates (computeIntel on the free node), `concurrency` at a time; stop starting new reads at the
  //     time budget (reads already in flight finish)
  const tokens = [], queue = [...cands];
  let budgetHit = false;
  const worker = async () => {
    while (queue.length) {
      if (Date.now() - started > o.timeBudgetMs) { budgetHit = true; return; }
      const t = queue.shift();
      try {
        const r = await readToken(t);
        state.profiledAt[t.address] = now;
        tokens.push({ ...r, address: t.address, sym: t.sym || r.sym, mcapUsd: t.mcapUsd ?? r.mcapUsd, ageH: ageH(t), venue: agentByToken.has(t.address) ? "orbio-agent" : "pons",
          graduated: t.graduated ?? r.graduated, progress: t.progress ?? null, name: t.name || null, logo: t.logo || null, deployer: deployerOf(t) });
      } catch (e) { out.errors.push(`read ${t.sym || t.address}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  if (budgetHit) out.errors.push(`time budget hit after ${tokens.length}/${cands.length} reads`);
  const be = detectEvents(state.prevBoard, tokens, { now, lastFired: state.lastFiredBoard, maxAgeH: o.maxAgeH, minMcap: o.minMcap });
  state.prevBoard = { ...state.prevBoard, ...be.next }; state.lastFiredBoard = be.lastFired;
  for (const e of be.events) { const t = tokens.find((x) => x.address === e.address); if (t) e.venue = t.venue; }
  // forget tokens not read for a week (state stays small)
  for (const a of Object.keys(state.profiledAt)) if (now - state.profiledAt[a] > o.keepDays * 86400e3) { delete state.profiledAt[a]; delete state.prevBoard[a]; }

  // 5 · gate: unvalidated kinds are logged only; the rest go through caps + lint
  const all = [...be.events, ...ae.events];
  out.events = all.map((e) => ({ at: now, kind: e.kind, address: e.address, sym: e.sym ?? null, headline: e.headline ?? null, validated: !UNVALIDATED.has(e.kind) }));
  for (const e of all.filter((x) => UNVALIDATED.has(x.kind))) out.logged.push({ ...e, why: "unvalidated kind — logged, not posted" });
  const stopped = state.stoppedDay === new Date(now).toISOString().slice(0, 10);
  const { post, hold } = plan(all.filter((x) => !UNVALIDATED.has(x.kind)), state.budget, { now, caps, perToken: state.perToken });
  out.held.push(...hold.map((h) => ({ ...h.ev, why: h.why })));

  // 6 · the connected X account (free read; only with a key). Gives the platform name social.post wants, the handle
  //     whose mentions we read, and today's remaining allowance. Logged every cycle, so the dry run doubles as the
  //     connection check.
  const stopDay = (e) => { if (e instanceof OrbioError && ["balance", "auth", "connect"].includes(e.code)) { state.stoppedDay = new Date(now).toISOString().slice(0, 10); state.stoppedWhy = `${e.code}: ${e.message}`; } };
  let acct = null;
  // The result is also kept in state.orbio (public on the agent-data branch), so the connection can be checked without
  // reading job logs.
  if (deps.apiKey) {
    try {
      acct = await orbio.xAccount(); out.account = acct;
      state.orbio = { checkedAt: now, platform: acct.platform, username: acct.username ?? null, postsLeft: acct.postsLeft ?? null, repliesLeft: acct.repliesLeft ?? null, error: null };
      log(acct.platform ? `X account @${acct.username} (${acct.platform}) · ${acct.postsLeft ?? "?"} posts / ${acct.repliesLeft ?? "?"} replies left today` : `no X account connected in Orbio${acct.connectUrl ? " — connect at " + acct.connectUrl : ""}`);
    } catch (e) { stopDay(e); out.errors.push("orbio accounts: " + e.message); state.orbio = { checkedAt: now, error: `${e.code || "error"}: ${e.message}` }; }
  } else state.orbio = { checkedAt: now, error: "no ORBIO_API_KEY" };
  const handle = (deps.handle || acct?.username || "").replace(/^@/, "");
  const platform = acct?.platform || null;
  const ceiling = caps.maxCreditPerDay ?? DEFAULT_CAPS.maxCreditPerDay;

  // 7 · publish (or record the dry run)
  let sent = 0;
  for (const ev of post) {
    const text = formatPost(ev, { forwardN }), problems = lint(text);
    if (problems.length) { out.held.push({ ...ev, text, why: "lint: " + problems.join(", ") }); continue; }
    if (dryRun) { out.dryRun.push({ at: now, kind: ev.kind, address: ev.address, text }); state.budget = record(state.budget, { now, credit: 0, address: ev.address }); state.perToken[ev.address] = now; continue; }
    const block = stopped || state.stoppedDay === new Date(now).toISOString().slice(0, 10) ? "posting stopped for today (balance/auth/connection)"
      : !platform ? "no X account connected in Orbio" : acct.postsLeft != null && sent >= acct.postsLeft ? "platform allowance" : null;
    if (block) { out.held.push({ ...ev, text, why: block }); continue; }
    try {
      const r = await orbio.tool("social.post", { platforms: [platform], text }, "0.02");
      let o = postOutcome(r.result);
      if (o.postId && !o.url && o.status !== "failed") { try { o = { ...o, ...postOutcome((await orbio.tool("social.post.status", { post_id: o.postId }, FREE)).result) }; } catch { /* the post stands; the link is a nicety */ } }
      if (o.status === "failed") { out.held.push({ ...ev, text, why: "post failed: " + (o.error || "refused") }); continue; }
      sent++;
      state.budget = record(state.budget, { now, credit: r.credit ?? 0.0187, address: ev.address }); state.perToken[ev.address] = now;
      out.posted.push({ at: now, kind: ev.kind, address: ev.address, text, ...o, running: r.running || undefined });
    } catch (e) {
      stopDay(e);
      out.errors.push("post: " + e.message); out.held.push({ ...ev, text, why: "post failed" });
    }
  }

  // 8 · mentions — a metered read (≈0.00022 CREDIT per post returned), so only with a key, a connected handle and room
  //     under the daily ceiling. Only mentions from the last 24 h are answered (a first run never replies to a backlog).
  if (handle && deps.apiKey && state.stoppedDay !== new Date(now).toISOString().slice(0, 10) && freshBudget(state.budget, now).credit + 0.005 <= ceiling) {
    try {
      const d = await orbio.tool("social.x.posts", { mentions_of: handle, limit: 20 }, "0.005");
      state.budget = record(state.budget, { now, kind: "read", credit: d.credit ?? 0.005 });   // unsettled → count the cap
      const posts = mentionsOf(d.result).filter((p) => p.at == null || now - p.at < 86400e3);
      for (const p of selectMentions(posts, { selfHandle: handle, answered: state.answered, now })) {
        if (!canReply(state.budget, { now, caps })) break;
        const ask = parseMention(p.text);
        let text = null;
        if (ask?.symbol) {
          const hit = resolveSymbol(ask.symbol, [...universe.values()]);
          if (hit?.ambiguous) text = `More than one $${ask.symbol} is live — reply with the contract address and I'll read it.`;
          else if (hit) ask.address = hit.address;
        }
        if (!text && ask?.address) {
          const t = universe.get(ask.address) || { address: ask.address };
          const r = await readToken(t);
          const ag = agentByToken.get(ask.address);
          const prior = ag ? agents.filter((x) => x.owner === ag.owner) : null;
          text = formatReply({ ...r, address: ask.address, sym: t.sym || r.sym, mcapUsd: t.mcapUsd ?? r.mcapUsd, ageH: ageH(t),
            ownerRep: prior ? { launched: prior.length, graduated: prior.filter((x) => x.graduated).length } : null });
        }
        if (!text || lint(text).length) { state.answered[p.id] = { at: now, author: p.author, skipped: true }; continue; }
        let credit = 0;
        if (dryRun) out.dryRun.push({ at: now, kind: "reply", replyTo: p.id, text });
        else if (!platform) break;
        else { const r = await orbio.tool("social.post", { platforms: [platform], text, reply_to: p.id }, "0.02"); credit = r.credit ?? 0.0187; out.replies.push({ at: now, replyTo: p.id, text, ...postOutcome(r.result) }); }
        state.budget = record(state.budget, { now, kind: "reply", credit });
        state.answered[p.id] = { at: now, author: p.author };
      }
    } catch (e) {
      stopDay(e);
      out.errors.push("mentions: " + e.message);
      state.orbio = { ...(state.orbio || {}), mentionsError: `${e.code || "error"}: ${e.message}`, mentionsErrorAt: now };
    }
  }
  for (const [id, a] of Object.entries(state.answered)) if (now - a.at > 7 * 86400e3) delete state.answered[id];
  state.budget = freshBudget(state.budget, now);

  out.tokens = tokens;
  log(`agents ${agents.length} · candidates ${cands.length} · read ${tokens.length} · events ${all.length} · ${dryRun ? "dry-run" : "posted"} ${dryRun ? out.dryRun.length : out.posted.length} · held ${out.held.length} · logged ${out.logged.length} · errors ${out.errors.length}`);
  return { state, out };
}
