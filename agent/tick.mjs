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
import { digestDue, remember, digestStats, formatDigest } from "./digest.mjs";
import { notMaterial } from "./materiality.mjs";
import { openFollowUps, watchList, writeFollowUp, formatFollowUp, followUpEntry } from "./followups.mjs";
import { plan, record, canReply, canSpend, settle, freshBudget, POST_MAX_COST, MENTION_MAX_COST } from "./budget.mjs";
import { parseMention, resolveSymbol, selectMentions } from "./mentions.mjs";
import { OrbioError, FREE, postOutcome, mentionsOf } from "./orbio.mjs";
import { deployerReputation, compactRep } from "../deployer.mjs";

// maxProfiles is a ceiling, not the working limit — the time budget is. A token's FIRST read is a full history pull
// (a busy 2-day-old token: 36 s, 226 eth_getLogs on the free node); every later read is a delta (0.1 s, 1 call), and the
// store now survives between jobs (PR #25: 150 warm reads in ~54 s). At 150 the cap starved every plain Pons launch:
// ~575 Orbio agents were eligible and went first, so graduating Pons launches were never read once (2026-10-06).
export const DEFAULTS = { maxAgeH: 72, minMcap: 5000, maxProfiles: 800, timeBudgetMs: 8 * 60e3, concurrency: 3, keepDays: 7 };

export function emptyState() {
  return { prevAgents: {}, lastFiredAgents: {}, prevBoard: {}, lastFiredBoard: {}, profiledAt: {}, perToken: {}, budget: null, answered: {}, replyAttempts: {}, stoppedDay: null, follow: {} };
}

export async function runTick(deps) {
  const { orbio, pons, readToken, now = Date.now(), dryRun = true, forwardN = null, caps = {}, log = () => {} } = deps;
  const o = { ...DEFAULTS, ...(deps.opts || {}) };
  const state = { ...emptyState(), ...(deps.state || {}) };
  const out = { posted: [], dryRun: [], logged: [], held: [], replies: [], errors: [], tokens: [], stats: null, account: null, events: [], followUps: [] };
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

  // 3 · candidates: young, not dust; launches with a follow-up due within the hour first (it needs their wallets'
  //     balances), then the least recently read across BOTH venues (never-read first), Orbio vs Pons only as a tiebreak
  const watch = watchList(state.follow, now);
  const cands = [...universe.values()].filter((t) => { const h = ageH(t); return watch[t.address] || (h != null && h >= 0 && h <= o.maxAgeH && (t.mcapUsd || 0) >= o.minMcap); })
    .sort((x, y) => (!!watch[y.address] - !!watch[x.address]) || ((state.profiledAt[x.address] || 0) - (state.profiledAt[y.address] || 0)) || (agentByToken.has(y.address) - agentByToken.has(x.address)) || (y.mcapUsd || 0) - (x.mcapUsd || 0))
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
        const r = await readToken(t, watch[t.address] ? { watch: watch[t.address] } : undefined);
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

  // 4b · graduation: a launch seen on the bonding curve and now listed graduated. A cold start (no memory of which
  //      launches were on the curve) only learns, so a backlog of old graduations can never fire.
  const ge = [], cold = state.ungrad == null, ungrad = { ...(state.ungrad || {}) };
  for (const t of universe.values()) {
    if (!t.address) continue;
    if (!t.graduated) { ungrad[t.address] = now; continue; }
    if (ungrad[t.address] && !cold) {
      // launches graduate within hours, often before this cycle reached them: fall back to the agent's last read
      const r = tokens.find((x) => x.address === t.address) || deps.lastRead?.(t.address) || null, f = r?.flags || {}, h = ageH(t);
      const facts = [h != null && `${h < 48 ? Math.round(h) + "h" : Math.round(h / 24) + "d"} after launch`, f.holders != null && `${f.holders.toLocaleString("en-US")} holders`,
        f.top10Pct != null && `top 10 wallets hold ${Math.round(f.top10Pct)}%`, f.sniperHeldPct != null && `early wallets hold ${Math.round(f.sniperHeldPct)}%`].filter(Boolean);
      ge.push({ id: `graduated:${t.address}:${now}`, kind: "graduated", sev: "info", at: now, address: t.address, sym: t.sym ?? r?.sym ?? null,
        mcapUsd: t.mcapUsd ?? null, ageH: h, holders: f.holders ?? null, risk: r?.risk ?? null, venue: agentByToken.has(t.address) ? "orbio-agent" : "pons",
        detail: { holders: f.holders ?? null, top10Pct: f.top10Pct ?? null, earlyHeldPct: f.sniperHeldPct ?? null, bundles: f.bundles ?? null },
        headline: `left the bonding curve${facts.length ? " · " + facts.join(" · ") : " and now trades on the AMM pool"}` });
    }
    delete ungrad[t.address];
  }
  for (const [a, at] of Object.entries(ungrad)) if (now - at > o.keepDays * 86400e3) delete ungrad[a];
  state.ungrad = ungrad;

  // 5 · gate: unvalidated kinds are logged only; the rest go through caps + lint
  const all = [...be.events, ...ae.events, ...ge];
  // every detected event, with the numbers and evidence it fired on; `fate` (what the agent did with it) is set below
  out.events = all.map((e) => ({ id: e.id, at: now, kind: e.kind, address: e.address, sym: e.sym ?? null, headline: e.headline ?? null,
    validated: !UNVALIDATED.has(e.kind), mcapUsd: e.mcapUsd ?? null, holders: e.holders ?? null, risk: e.risk ?? null, ageH: e.ageH ?? null,
    owner: e.owner ?? null, agentId: e.agentId ?? null, detail: e.detail ?? null, material: !UNVALIDATED.has(e.kind) && !notMaterial(e), fate: null, why: null }));
  for (const e of all.filter((x) => UNVALIDATED.has(x.kind))) out.logged.push({ ...e, why: "unvalidated kind — logged, not posted" });
  // everything goes on the timeline; only material events are offered to the posting gate
  const offer = [];
  for (const e of all.filter((x) => !UNVALIDATED.has(x.kind))) { const why = notMaterial(e); if (why) out.logged.push({ ...e, why }); else offer.push(e); }
  const stopped = state.stoppedDay === new Date(now).toISOString().slice(0, 10);
  const { post, hold } = plan(offer, state.budget, { now, caps, perToken: state.perToken });
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
  // Reconcile pending replies with a known post id; never resubmit an uncertain send.
  if (!dryRun && deps.apiKey && state.stoppedDay !== new Date(now).toISOString().slice(0, 10)) {
    // Bound the new free-read fan-out and rotate checks. Old unresolved sends need human reconciliation.
    const pending = Object.entries(state.replyAttempts).filter(([, a]) => a.status === "pending" && a.postId)
      .sort(([, a], [, b]) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, 20);
    for (const [id, a] of pending) {
      if (now - a.at > 86400e3) { a.status = "needs-review"; continue; }
      a.checkedAt = now;
      try {
        const o = postOutcome((await orbio.tool("social.post.status", { post_id: a.postId }, FREE)).result);
        if (o.status === "published") {
          a.status = "published"; state.answered[id] = { at: now, author: a.author };
          out.replies.push({ at: now, replyTo: id, text: a.text, ...o });
        } else if (o.status === "failed") { a.status = "failed"; a.nextRetryAt = now + 15 * 60e3; }
      } catch (e) { stopDay(e); out.errors.push("reply status: " + e.message); }
      if (state.stoppedDay === new Date(now).toISOString().slice(0, 10)) break;
    }
  }

  // 7 · publish (or record the dry run)
  let sent = 0;
  for (const ev of post) {
    const text = formatPost(ev, { forwardN }), problems = lint(text);
    if (problems.length) { out.held.push({ ...ev, text, why: "lint: " + problems.join(", ") }); continue; }
    if (dryRun) { out.dryRun.push({ at: now, id: ev.id, kind: ev.kind, address: ev.address, text }); state.budget = record(state.budget, { now, credit: 0, address: ev.address }); state.perToken[ev.address] = now; continue; }
    const block = stopped || state.stoppedDay === new Date(now).toISOString().slice(0, 10) ? "posting stopped for today (balance/auth/connection)"
      : !platform ? "no X account connected in Orbio" : acct.postsLeft != null && sent >= acct.postsLeft ? "platform allowance"
      : !canSpend(state.budget, POST_MAX_COST, { now, caps }) ? "credit ceiling" : null;
    if (block) { out.held.push({ ...ev, text, why: block }); continue; }
    try {
      sent++;
      state.budget = record(state.budget, { now, credit: POST_MAX_COST, address: ev.address });
      state.perToken[ev.address] = now;
      const r = await orbio.tool("social.post", { platforms: [platform], text }, String(POST_MAX_COST));
      state.budget = settle(state.budget, POST_MAX_COST, r, now);
      let o = postOutcome(r.result);
      if (o.postId && !o.url && o.status !== "failed") { try { o = { ...o, ...postOutcome((await orbio.tool("social.post.status", { post_id: o.postId }, FREE)).result) }; } catch { /* the post stands; the link is a nicety */ } }
      if (o.status === "failed") { out.held.push({ ...ev, text, why: "post failed: " + (o.error || "refused") }); continue; }
      out.posted.push({ at: now, id: ev.id, kind: ev.kind, address: ev.address, text, ...o, running: r.running || undefined });
    } catch (e) {
      stopDay(e);
      out.errors.push("post: " + e.message); out.held.push({ ...ev, text, why: "post failed" });
    }
  }

  // what happened to each event: posted, a dry-run post, held (with why), or logged only (unvalidated kind)
  const fate = new Map();
  for (const e of out.logged) fate.set(e.id, ["logged", e.why]);
  for (const e of out.held) fate.set(e.id, ["held", e.why]);
  for (const e of out.dryRun) if (e.id) fate.set(e.id, ["dry-run", null]);
  for (const e of out.posted) fate.set(e.id, ["posted", e.url || null]);
  for (const e of out.events) [e.fate, e.why] = fate.get(e.id) || ["held", null];

  // 7b · follow-ups: open one for each material event; write (and thread) the ones that are due
  state.follow = openFollowUps(state.follow, out.events, { now, posted: Object.fromEntries(out.posted.filter((p) => p.postId).map((p) => [p.id, p.postId])) });
  for (const f of Object.values(state.follow).filter((x) => x.due <= now).sort((a, b) => a.due - b.due)) {
    const read = tokens.find((x) => x.address === f.address), u = universe.get(f.address), ag = agentByToken.get(f.address);
    const mine = ag?.owner ? agents.filter((x) => x.owner === ag.owner) : null;
    const cur = { mcapUsd: u?.mcapUsd ?? ag?.mcapUsd ?? read?.mcapUsd ?? null, holders: read?.flags?.holders ?? null,
      graduated: u?.graduated ?? ag?.graduated ?? null, watched: read?.watched ?? null,
      ownerLaunched: mine ? mine.length : null, ownerGraduated: mine ? mine.filter((x) => x.graduated).length : null };
    const w = writeFollowUp(f, cur, { now });
    if (w.wait) continue;
    delete state.follow[f.id];
    if (!w.headline) { out.errors.push(`follow-up ${f.sym || f.address}: ${w.why}`); continue; }
    const text = formatFollowUp(f, w.headline);
    const fu = { ...followUpEntry(f, w.headline, cur, now), address: f.address, sym: f.sym, text, posted: null };
    out.followUps.push(fu);
    // threaded under the original: only when the original went out (or would have, in dry run)
    if (lint(text).length || !(f.fate === "posted" || (dryRun && f.fate === "dry-run"))) continue;
    if (dryRun) { out.dryRun.push({ at: now, kind: "follow-up", replyTo: f.id, address: f.address, text }); state.budget = record(state.budget, { now, kind: "reply", credit: 0 }); continue; }
    if (!f.postId || !platform || !canReply(state.budget, { now, caps }) || state.stoppedDay === new Date(now).toISOString().slice(0, 10)) continue;
    try {
      state.budget = record(state.budget, { now, kind: "reply", credit: POST_MAX_COST });
      const r = await orbio.tool("social.post", { platforms: [platform], text, reply_to: f.postId }, String(POST_MAX_COST));
      state.budget = settle(state.budget, POST_MAX_COST, r, now);
      const o = postOutcome(r.result);
      if (o.status !== "failed") { fu.posted = o.url || o.postId || "pending"; out.posted.push({ at: now, id: fu.id, kind: "follow-up", address: f.address, text, ...o }); }
    } catch (e) { stopDay(e); out.errors.push("follow-up post: " + e.message); }
  }
  for (const [id, f] of Object.entries(state.follow)) if (now - f.due > 3 * 86400e3) delete state.follow[id];

  // 7c · the daily digest: counts over the last 24 h, once per UTC day
  state.recent = remember(state.recent, out.events, now);
  if (digestDue(state.digestDay, now)) {
    state.digestDay = new Date(now).toISOString().slice(0, 10);
    const s = digestStats({ recent: state.recent, now, reads: tokens,
      launches: [...universe.values()].map((t) => ({ ageH: ageH(t), orbio: agentByToken.has(t.address) })) });
    const text = formatDigest(s);
    out.digest = { at: now, stats: s, text };
    if (dryRun) { out.dryRun.push({ at: now, kind: "digest", text }); state.budget = record(state.budget, { now, credit: 0 }); }
    else if (platform && !lint(text).length && canSpend(state.budget, POST_MAX_COST, { now, caps }) && state.stoppedDay !== state.digestDay) {
      try {
        state.budget = record(state.budget, { now, credit: POST_MAX_COST });
        const r = await orbio.tool("social.post", { platforms: [platform], text }, String(POST_MAX_COST));
        state.budget = settle(state.budget, POST_MAX_COST, r, now);
        const o = postOutcome(r.result);
        if (o.status !== "failed") out.posted.push({ at: now, kind: "digest", text, ...o });
      } catch (e) { stopDay(e); out.errors.push("digest post: " + e.message); }
    }
  }

  // 8 · mentions — a metered read (≈0.00022 CREDIT per post returned), so only with a key, a connected handle and room
  //     under the daily ceiling. Only mentions from the last 24 h are answered (a first run never replies to a backlog).
  if (handle && deps.apiKey && state.stoppedDay !== new Date(now).toISOString().slice(0, 10) && canSpend(state.budget, MENTION_MAX_COST, { now, caps })) {
    try {
      state.budget = record(state.budget, { now, kind: "read", credit: MENTION_MAX_COST });
      const d = await orbio.tool("social.x.posts", { mentions_of: handle, limit: 20 }, String(MENTION_MAX_COST));
      state.budget = settle(state.budget, MENTION_MAX_COST, d, now);
      const posts = mentionsOf(d.result).filter((p) => p.at == null || now - p.at < 86400e3);
      const blocked = { ...state.answered };
      for (const [id, a] of Object.entries(state.replyAttempts)) {
        if (a.status !== "failed" || a.attempts >= 3 || now < a.nextRetryAt) blocked[id] = a;
      }
      let replyCalls = 0;
      for (const p of selectMentions(posts, { selfHandle: handle, answered: blocked, now })) {
        if (!canReply(state.budget, { now, caps })) break;
        if (!dryRun && acct?.repliesLeft != null && replyCalls >= acct.repliesLeft) break;
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
        if (dryRun) {
          out.dryRun.push({ at: now, kind: "reply", replyTo: p.id, text });
          state.budget = record(state.budget, { now, kind: "reply", credit: 0 });
          state.answered[p.id] = { at: now, author: p.author };
        }
        else if (!platform) break;
        else {
          const a = state.replyAttempts[p.id] = { at: now, author: p.author, text, status: "pending", attempts: (state.replyAttempts[p.id]?.attempts || 0) + 1 };
          replyCalls++;
          state.budget = record(state.budget, { now, kind: "reply", credit: POST_MAX_COST });
          const r = await orbio.tool("social.post", { platforms: [platform], text, reply_to: p.id }, String(POST_MAX_COST));
          state.budget = settle(state.budget, POST_MAX_COST, r, now);
          const o = postOutcome(r.result); a.postId = o.postId;
          if (!r.running && o.status === "published") {
            a.status = "published";
            out.replies.push({ at: now, replyTo: p.id, text, ...o });
            state.answered[p.id] = { at: now, author: p.author };
          } else if (!r.running && o.status === "failed") {
            a.status = "failed"; a.nextRetryAt = now + 15 * 60e3;
            out.errors.push("reply failed: " + (o.error || "refused"));
          }
        }
      }
    } catch (e) {
      stopDay(e);
      out.errors.push("mentions: " + e.message);
      state.orbio = { ...(state.orbio || {}), mentionsError: `${e.code || "error"}: ${e.message}`, mentionsErrorAt: now };
    }
  }
  for (const [id, a] of Object.entries(state.answered)) if (now - a.at > 7 * 86400e3) delete state.answered[id];
  for (const [id, a] of Object.entries(state.replyAttempts)) if (["published", "failed"].includes(a.status) && now - a.at > 7 * 86400e3) delete state.replyAttempts[id];
  state.budget = freshBudget(state.budget, now);

  out.tokens = tokens;
  log(`agents ${agents.length} · candidates ${cands.length} · read ${tokens.length} · events ${all.length} · ${dryRun ? "dry-run" : "posted"} ${dryRun ? out.dryRun.length : out.posted.length} · held ${out.held.length} · logged ${out.logged.length} · errors ${out.errors.length}`);
  return { state, out };
}
