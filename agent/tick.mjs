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
import { plan, record, canReply, freshBudget } from "./budget.mjs";
import { parseMention, resolveSymbol, selectMentions } from "./mentions.mjs";
import { OrbioError } from "./orbio.mjs";

// maxProfiles is a ceiling, not the working limit — the time budget is. A token's FIRST read in a process is a full
// history pull (a busy 2-day-old token: 36 s, 226 eth_getLogs on the free node); every later read is a delta
// (0.1 s, 1 call). So a long-lived --watch process converges to re-reading every live candidate each cycle.
export const DEFAULTS = { maxAgeH: 72, minMcap: 5000, maxProfiles: 150, timeBudgetMs: 8 * 60e3, concurrency: 3, keepDays: 7 };

export function emptyState() {
  return { prevAgents: {}, lastFiredAgents: {}, prevBoard: {}, lastFiredBoard: {}, profiledAt: {}, perToken: {}, budget: null, answered: {}, mentionCursor: null, stoppedDay: null };
}

export async function runTick(deps) {
  const { orbio, pons, readToken, now = Date.now(), dryRun = true, publicUrl = "", forwardN = null, handle = "",
    caps = {}, log = () => {} } = deps;
  const o = { ...DEFAULTS, ...(deps.opts || {}) };
  const state = { ...emptyState(), ...(deps.state || {}) };
  const out = { posted: [], dryRun: [], logged: [], held: [], replies: [], errors: [], tokens: [], stats: null };
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
          graduated: t.graduated ?? r.graduated, progress: t.progress ?? null });
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
  for (const e of all.filter((x) => UNVALIDATED.has(x.kind))) out.logged.push({ ...e, why: "unvalidated kind — logged, not posted" });
  const stopped = state.stoppedDay === new Date(now).toISOString().slice(0, 10);
  const { post, hold } = plan(all.filter((x) => !UNVALIDATED.has(x.kind)), state.budget, { now, caps, perToken: state.perToken });
  out.held.push(...hold.map((h) => ({ ...h.ev, why: h.why })));

  // 6 · publish (or record the dry run)
  for (const ev of post) {
    const text = formatPost(ev, { publicUrl, forwardN }), problems = lint(text);
    if (problems.length) { out.held.push({ ...ev, text, why: "lint: " + problems.join(", ") }); continue; }
    if (dryRun) { out.dryRun.push({ at: now, kind: ev.kind, address: ev.address, text }); state.budget = record(state.budget, { now, credit: 0, address: ev.address }); state.perToken[ev.address] = now; continue; }
    if (stopped) { out.held.push({ ...ev, text, why: "posting stopped for today (balance/auth)" }); continue; }
    try {
      const r = await orbio.tool("social.post", { platforms: ["x"], text }, "0.02");
      state.budget = record(state.budget, { now, credit: 0.0187, address: ev.address }); state.perToken[ev.address] = now;
      out.posted.push({ at: now, kind: ev.kind, address: ev.address, text, id: r?.id ?? r?.data?.id ?? null, url: r?.url ?? r?.data?.url ?? null });
    } catch (e) {
      if (e instanceof OrbioError && (e.code === "balance" || e.code === "auth")) state.stoppedDay = new Date(now).toISOString().slice(0, 10);
      out.errors.push("post: " + e.message); out.held.push({ ...ev, text, why: "post failed" });
    }
  }

  // 7 · mentions (metered read → only with a key and a handle; never in dry run without a key)
  if (handle && deps.apiKey && !stopped) {
    try {
      const d = await orbio.tool("social.x.posts", { handle, mentions_of: handle, limit: 20, ...(state.mentionCursor ? { since_id: state.mentionCursor } : {}) }, "0.005");
      const posts = (d?.posts || d?.data || []).map((p) => ({ id: String(p.id), author: p.author?.username || p.author || p.username || "", text: p.text || "" }));
      if (posts.length) state.mentionCursor = posts.map((p) => p.id).sort().at(-1);
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
            ownerRep: prior ? { launched: prior.length, graduated: prior.filter((x) => x.graduated).length } : null }, { publicUrl });
        }
        if (!text || lint(text).length) { state.answered[p.id] = { at: now, author: p.author, skipped: true }; continue; }
        if (dryRun) out.dryRun.push({ at: now, kind: "reply", replyTo: p.id, text });
        else { await orbio.tool("social.post", { platforms: ["x"], text, reply_to: p.id }, "0.02"); out.replies.push({ at: now, replyTo: p.id, text }); }
        state.budget = record(state.budget, { now, kind: "reply", credit: dryRun ? 0 : 0.0187 });
        state.answered[p.id] = { at: now, author: p.author };
      }
    } catch (e) {
      if (e instanceof OrbioError && (e.code === "balance" || e.code === "auth")) state.stoppedDay = new Date(now).toISOString().slice(0, 10);
      out.errors.push("mentions: " + e.message);
    }
  }
  for (const [id, a] of Object.entries(state.answered)) if (now - a.at > 7 * 86400e3) delete state.answered[id];
  state.budget = freshBudget(state.budget, now);

  out.tokens = tokens;
  log(`agents ${agents.length} · candidates ${cands.length} · read ${tokens.length} · events ${all.length} · ${dryRun ? "dry-run" : "posted"} ${dryRun ? out.dryRun.length : out.posted.length} · held ${out.held.length} · logged ${out.logged.length} · errors ${out.errors.length}`);
  return { state, out };
}
