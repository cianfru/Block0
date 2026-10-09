import { test } from "node:test";
import assert from "node:assert/strict";
import { normAgent, agentEvents } from "../agent/agent-events.mjs";
import { formatPost, formatReply, lint, footer, cleanSym, MAX_LEN } from "../agent/format.mjs";
import { plan, record, canReply, freshBudget } from "../agent/budget.mjs";
import { parseMention, resolveSymbol, selectMentions } from "../agent/mentions.mjs";
import { makeOrbio, OrbioError, postOutcome, mentionsOf } from "../agent/orbio.mjs";
import { runTick } from "../agent/tick.mjs";

const NOW = Date.UTC(2026, 9, 1, 12), S = NOW / 1000, E18 = 10n ** 18n;
const A = (n) => "0x" + String(n).padStart(40, "c");
const raw = (id, o = {}) => ({ agentId: String(id), token: A(id), symbol: "T" + id, owner: o.owner || A(900 + id), launchedAt: String(o.launchedAt ?? S - 2 * 86400),
  price: { graduated: !!o.graduated, marketCapMicroUsd: String((o.mcap ?? 50000) * 1e6) },
  stake: { stakedWei: String((o.staked ?? 1000n) * E18), withdrawnWei: o.withdrawn == null ? "0" : String(o.withdrawn * E18) },
  converted: { usdgAtoms: o.usdg === null ? null : String((o.usdg ?? 0) * 1e6) }, credit: { activatedAtoms: o.activated ?? "0" },
  cliff: { unlocksAt: String(o.unlocksAt ?? S + 5 * 86400), locked: o.locked ?? true } });
const run = (prev, rows, extra = {}) => agentEvents(prev, rows.map((r) => normAgent(r, NOW)), { now: NOW, orbioUsd: 0.1, ...extra });

test("agent events: cold start seeds and never fires, even for an imminent cliff", () => {
  const r = run({}, [raw(1, { unlocksAt: S + 3600 }), raw(2, { withdrawn: 5n })]);
  assert.equal(r.events.length, 0);
  assert.equal(r.next["1"].cliffDone, true);                     // already inside the window at seed → never announced late
});

test("agent events: withdrawal, cliff, first harvest each fire once on the transition", () => {
  const seed = run({}, [raw(1), raw(2), raw(3, { usdg: 50 })]).next;
  const r = run(seed, [raw(1, { withdrawn: 400n }), raw(2, { unlocksAt: S + 5 * 3600 }), raw(3, { usdg: 120 })]);
  assert.deepEqual(r.events.map((e) => e.kind).sort(), ["cliff-24h", "first-harvest", "principal-withdrawn"]);
  assert.match(r.events.find((e) => e.kind === "principal-withdrawn").headline, /withdrew 400 staked ORBIO \(≈\$40\)/);
  assert.match(r.events.find((e) => e.kind === "cliff-24h").headline, /lock ends in 5h · 1,000 ORBIO staked/);
  const again = run(r.next, [raw(1, { withdrawn: 400n }), raw(2, { unlocksAt: S + 4 * 3600 }), raw(3, { usdg: 130 })], { lastFired: r.lastFired });
  assert.equal(again.events.length, 0);
});

test("agent events: a small extra withdrawal (<10%) is noise; a new agent from a serial owner fires", () => {
  const owner = A(777);
  const base = [raw(1, { withdrawn: 100n }), raw(2, { owner, launchedAt: S - 9e4 }), raw(3, { owner, launchedAt: S - 8e4 }), raw(4, { owner, launchedAt: S - 7e4 })];
  const seed = run({}, base).next;
  const r = run(seed, [raw(1, { withdrawn: 105n }), ...base.slice(1), raw(5, { owner, launchedAt: S - 100 })]);
  assert.deepEqual(r.events.map((e) => e.kind), ["serial-owner"]);
  assert.match(r.events[0].headline, /launched 3 agents before this one · 0 graduated/);
  const g = run(seed, [raw(1, { withdrawn: 100n }), raw(2, { owner, graduated: true }), ...base.slice(2), raw(5, { owner, launchedAt: S - 100 })]);
  assert.equal(g.events.length, 0);                              // a graduated prior launch means not "0 graduated"
});

test("agent events: idle credit needs ≥7d, ≥$500 and nothing activated; null never fires", () => {
  const old = S - 8 * 86400;
  const seed = run({}, [raw(1, { launchedAt: old, usdg: 600 }), raw(2, { launchedAt: old, usdg: null }), raw(3, { launchedAt: old, usdg: 900, activated: "5" })]).next;
  const r = run(seed, [raw(1, { launchedAt: old, usdg: 600 }), raw(2, { launchedAt: old, usdg: null }), raw(3, { launchedAt: old, usdg: 900, activated: "5" })]);
  assert.deepEqual(r.events.map((e) => [e.kind, e.agentId]), [["credit-idle", "1"]]);
  assert.match(r.events[0].headline, /spending is not/);
});

test("format: ≤280 chars, address + footer always present, no link, unvalidated kinds say so", () => {
  const ev = { kind: "insider-dump", sym: "PEPE", address: A(1), mcapUsd: 212000, ageH: 5, venue: "orbio-agent", headline: "3 insider wallets started selling · 4.1% of supply moving" };
  const t = formatPost(ev);
  assert.ok(t.length <= MAX_LEN);
  assert.match(t, /^▼ \$PEPE — early wallets selling\n/);
  assert.match(t, /\$212k mcap · 5h old · Orbio agent/);
  assert.match(t, new RegExp(`\\n${A(1)}\\n`));
  assert.match(t, /On-chain facts, not advice\.$/);
  assert.deepEqual(lint(t), []);                                 // Orbio refuses X posts with links: none, ever
  assert.equal(footer("smart-convergence", { forwardN: 12 }), "Not validated (forward test n=12). Facts, not advice.");
  const long = formatPost({ ...ev, headline: "x".repeat(400) });
  assert.ok(long.length <= MAX_LEN && long.endsWith("not advice.") && long.includes(A(1)));
});

test("format: lint rejects calls, hype and accusations; symbols are sanitised", () => {
  for (const bad of ["this will pump", "buy now", "Sell now!", "next gem", "classic rug", "looks like a scam", "100x likely", "price target"]) assert.ok(lint(bad).length, bad);
  for (const ok of ["3 early wallets started selling", "creator withdrew 400 staked ORBIO", "4.1% of supply · $1.50M mcap · Facts, not advice."]) assert.deepEqual(lint(ok), [], ok);
  for (const link of ["see https://block0.app/token", "block0.app", "www.x.com", "read it on pump.fun"]) assert.match(lint(link).join(), /link/, link);
  assert.equal(cleanSym("@elon\nhttps://x.co"), "elonhttpsxco");                // no "." → a symbol can never become a domain
  assert.ok(lint("a".repeat(281)).length);
});

test("format: mention reply carries the facts, the address and the footer", () => {
  const r = formatReply({ sym: "ABC", address: A(2), mcapUsd: 48000, ageH: 30, risk: 22, flags: { holders: 512, top10Pct: 31.4, bundles: 0, snipers: 2, insiderSellersNow: 0 },
    ownerRep: { launched: 4, graduated: 0 } });
  assert.match(r, new RegExp(`^\\$ABC · \\$48k mcap · 30h old\\nrisk 22/100 · 512 holders · top10 31% · no bundles · 2 snipers\\nowner: 4 launches, 0 graduated\\n${A(2)}\\nFacts, not advice\\.$`));
  assert.deepEqual(lint(r), []);
});

test("budget: priority under caps, hourly cap, one post per token, credit ceiling, UTC rollover", () => {
  const ev = (kind, address, mcapUsd = 1) => ({ kind, address, mcapUsd });
  const evs = [ev("first-harvest", "a"), ev("insider-dump", "b"), ev("serial-owner", "c"), ev("insider-dump", "b"), ev("cliff-24h", "d")];
  const p = plan(evs, null, { now: NOW });
  assert.deepEqual(p.post.map((e) => e.kind), ["insider-dump", "serial-owner", "cliff-24h"]);   // 3/hour cap
  assert.ok(p.hold.some((h) => h.why === "token posted within 6h") && p.hold.some((h) => h.why === "hourly cap"));
  let s = null; for (let i = 0; i < 15; i++) s = record(s, { now: NOW - 2 * 3600e3, credit: 0.0187 });
  assert.equal(plan([ev("insider-dump", "z")], s, { now: NOW }).hold[0].why, "daily cap");
  assert.equal(plan([ev("insider-dump", "z")], { day: "2026-10-01", originals: [], replies: 0, credit: 1.49 }, { now: NOW }).hold[0].why, "credit ceiling");
  assert.equal(plan([ev("insider-dump", "z")], null, { now: NOW, perToken: { z: NOW - 3600e3 } }).hold[0].why, "token posted within 6h");
  assert.equal(freshBudget({ day: "2026-09-30", originals: [{ at: NOW - 30 * 3600e3 }], replies: 40, credit: 1.5 }, NOW).replies, 0);
  assert.equal(canReply({ day: "2026-10-01", originals: [], replies: 40, credit: 0 }, { now: NOW }), false);
});

test("mentions: address beats symbol, symbols resolve or ask, self and spammy authors skipped", () => {
  assert.deepEqual(parseMention(`@block0 check 0x${"Ab".repeat(20)} pls`), { address: "0x" + "ab".repeat(20) });
  assert.deepEqual(parseMention("@block0 what about $tank?"), { symbol: "TANK" });
  assert.equal(parseMention("gm"), null);
  const uni = [{ address: A(1), sym: "TANK", mcapUsd: 600000 }, { address: A(2), sym: "TANK", mcapUsd: 50000 }, { address: A(3), sym: "ERRAND" }];
  assert.deepEqual(resolveSymbol("ERRAND", uni), { address: A(3) });
  assert.deepEqual(resolveSymbol("TANK", uni), { ambiguous: [A(1), A(2)] });
  assert.equal(resolveSymbol("NOPE", uni), null);
  const answered = { x1: { at: NOW - 600e3, author: "spam" }, x2: { at: NOW - 600e3, author: "spam" }, x3: { at: NOW - 600e3, author: "spam" } };
  const sel = selectMentions([{ id: "1", author: "@Block0" }, { id: "2", author: "spam" }, { id: "x1", author: "a" }, { id: "3", author: "fan" }], { selfHandle: "@block0", answered, now: NOW });
  assert.deepEqual(sel.map((p) => p.id), ["3"]);
});

test("orbio client: max_cost always sent, result unwrapped, 401/402/409 typed, no key = no metered call", async () => {
  const calls = [];
  const codes = { 402: 402, 401: 401, 409: 409, 202: 202 };
  const f = async (url, init) => { calls.push({ url, init }); const st = codes[JSON.parse(init.body).text] || 200;
    return { ok: st < 300, status: st, json: async () => (st === 409 ? { connect_url: "https://orbio.so/dashboard#tools" } : st === 202 ? { status: "running" }
      : { id: "c1", tool: "social.post", result: { post_id: "p1", status: "published", platforms: [{ platform: "twitter", platformPostId: "99", platformPostUrl: "https://x.com/b/status/99" }] }, cost: { credit: "0.018700" } }) }; };
  const o = makeOrbio({ apiKey: "k", fetch: f });
  const r = await o.tool("social.post", { text: "hi" }, 0.02);
  assert.equal(calls[0].url, "https://api.orbio.so/api/v1/tools/social.post");
  assert.equal(JSON.parse(calls[0].init.body).max_cost, "0.02");
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
  assert.equal(r.credit, 0.0187);
  assert.deepEqual(postOutcome(r.result), { postId: "p1", status: "published", url: "https://x.com/b/status/99", xId: "99", error: null });
  assert.deepEqual(await o.tool("social.post", { text: "202" }, "0.02"), { result: null, credit: null, running: true });   // never resubmitted
  await assert.rejects(o.tool("social.post", { text: "402" }, "0.02"), (e) => e instanceof OrbioError && e.code === "balance");
  await assert.rejects(o.tool("social.post", { text: "401" }, "0.02"), (e) => e.code === "auth");
  await assert.rejects(o.tool("social.post", { text: "409" }, "0.02"), (e) => e.code === "connect" && e.connectUrl === "https://orbio.so/dashboard#tools");
  await assert.rejects(o.tool("social.post", { text: "x" }), (e) => e.code === "nocap");
  await assert.rejects(makeOrbio({ fetch: f }).tool("social.post", {}, "0.02"), (e) => e.code === "nokey");
});

test("orbio client: social.accounts → the connected X account; mentions parsed from the tweets shape", async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ result: { accounts: [{ platform: "instagram", username: "ig" }, { platform: "twitter", username: "block0app", today: { posts_left: 47, replies_left: 100 } }], connect_url: "u" }, cost: { credit: "0" } }) });
  assert.deepEqual(await makeOrbio({ apiKey: "k", fetch: f }).xAccount(), { platform: "twitter", username: "block0app", postsLeft: 47, repliesLeft: 100, connectUrl: "u" });
  const none = async () => ({ ok: true, status: 200, json: async () => ({ result: { accounts: [], connect_url: "u" } }) });
  assert.deepEqual(await makeOrbio({ apiKey: "k", fetch: none }).xAccount(), { platform: null, connectUrl: "u" });
  assert.deepEqual(mentionsOf({ tweets: [{ id_str: "5", full_text: "@block0app $TANK?", tweet_created_at: "2026-10-01T11:00:00Z", user: { screen_name: "fan" } }] }),
    [{ id: "5", author: "fan", text: "@block0app $TANK?", at: Date.UTC(2026, 9, 1, 11) }]);
});

// stubbed world for the tick
function world({ sellers = 0, withdrawn = 0n, posted = [], account = { platform: "twitter", username: "block0app", postsLeft: 50, repliesLeft: 100 } } = {}) {
  const launchedAt = new Date(NOW - 5 * 3600e3).toISOString();
  return {
    orbio: { allAgents: async () => ({ agents: [raw(1, { withdrawn })], orbioUsd: 0.1 }), xAccount: async () => account,
      tool: async (name, args) => { posted.push({ name, args }); return name === "social.x.posts" ? { result: { tweets: [] }, credit: 0 }
        : { result: { post_id: "p" + posted.length, status: "published", platforms: [{ platformPostUrl: "https://x.com/b/status/1" }] }, credit: 0.0187 }; } },
    pons: { fetchActive: async () => ({ items: [{ address: A(1), sym: "T1", mcapUsd: 80000, launchedAt }, { address: A(2), sym: "OLD", mcapUsd: 90000, launchedAt: new Date(NOW - 9 * 86400e3).toISOString() }] }), fetchGraduated: async () => ({ items: [] }) },
    readToken: async (t) => ({ sym: t.sym, risk: 30, flags: { insiderSellersNow: sellers, insiderDumpNowPct: 4.1, top10Pct: 38, holders: 300, bundles: 0 } }),
  };
}

test("tick: dry run records posts, publishes nothing, and never touches the parked board", async () => {
  const board = await import("../board.mjs").catch(() => null);
  const standbyBefore = board?.STANDBY;
  const posted = [];
  const t1 = await runTick({ ...world({ posted }), now: NOW, dryRun: true });          // seed
  assert.equal(t1.out.dryRun.length, 0);
  const t2 = await runTick({ ...world({ sellers: 2, withdrawn: 300n, posted }), state: t1.state, now: NOW + 900e3, dryRun: true });
  assert.deepEqual(t2.out.dryRun.map((r) => r.kind).sort(), ["insider-dump"]);
  // routine fee-stake withdrawal: on the timeline, never offered for posting (agent/materiality.mjs)
  assert.ok(t2.out.logged.some((h) => h.kind === "principal-withdrawn" && /timeline only/.test(h.why)));
  assert.deepEqual(t2.out.events.map((e) => [e.kind, e.fate]).sort(), [["insider-dump", "dry-run"], ["principal-withdrawn", "logged"]]);
  assert.equal(posted.length, 0);                                                        // nothing reached Orbio
  assert.equal(t2.state.profiledAt[A(2)], undefined);                                     // 9-day-old token never read
  if (board) assert.equal(board.STANDBY, standbyBefore);
});

test("tick: live mode posts to the connected platform with max_cost; a 402 stops posting for the day", async () => {
  const posted = [];
  const t1 = await runTick({ ...world({ posted }), apiKey: "k", now: NOW, dryRun: false });
  const t2 = await runTick({ ...world({ sellers: 2, posted }), apiKey: "k", state: t1.state, now: NOW + 900e3, dryRun: false });
  const posts = posted.filter((p) => p.name === "social.post");
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].args.platforms, ["twitter"]);    // the name social.accounts gave
  assert.ok(!/https?:/.test(posts[0].args.text));
  assert.deepEqual(posted.filter((p) => p.name === "social.x.posts").map((p) => p.args), [{ mentions_of: "block0app", limit: 20 }, { mentions_of: "block0app", limit: 20 }]);
  assert.equal(t2.out.posted[0].url, "https://x.com/b/status/1");
  assert.deepEqual([t2.state.orbio.platform, t2.state.orbio.username, t2.state.orbio.error], ["twitter", "block0app", null]);   // the connection check, kept
  const quiet = await runTick({ ...world({ sellers: 0, posted: [] }), apiKey: "k", state: t2.state, now: NOW + 6.75 * 3600e3, dryRun: false });
  const w = world({ sellers: 2 });
  w.orbio.tool = async () => { throw new OrbioError("balance", "402"); };
  const t3 = await runTick({ ...w, apiKey: "k", state: quiet.state, now: NOW + 7 * 3600e3, dryRun: false });
  assert.equal(t3.state.stoppedDay, "2026-10-01");
  assert.match(t3.state.stoppedWhy, /^balance/);
  assert.ok(t3.out.held.some((h) => h.why === "post failed"));
});

test("tick: live mode with no connected X account holds every post and calls nothing metered", async () => {
  const posted = [];
  const w = (o) => world({ ...o, posted, account: { platform: null, connectUrl: "u" } });
  const t1 = await runTick({ ...w({}), apiKey: "k", now: NOW, dryRun: false });
  const t2 = await runTick({ ...w({ sellers: 2 }), apiKey: "k", state: t1.state, now: NOW + 900e3, dryRun: false });
  assert.equal(posted.length, 0);
  assert.ok(t2.out.held.some((h) => h.why === "no X account connected in Orbio"));
});

test("tick: mentions — only the last 24 h, replies carry the address, dry run never posts", async () => {
  const posted = [];
  const w = world({ posted });
  const tweets = [{ id_str: "10", full_text: `@block0app what about ${A(1)}`, tweet_created_at: new Date(NOW - 3600e3).toISOString(), user: { screen_name: "fan" } },
    { id_str: "11", full_text: `@block0app ${A(1)}?`, tweet_created_at: new Date(NOW - 3 * 86400e3).toISOString(), user: { screen_name: "old" } }];
  w.orbio.tool = async (name, args) => { posted.push({ name, args }); return { result: { tweets }, credit: 0.00044 }; };
  const t = await runTick({ ...w, apiKey: "k", now: NOW, dryRun: true });
  const replies = t.out.dryRun.filter((r) => r.kind === "reply");
  assert.deepEqual(replies.map((r) => r.replyTo), ["10"]);
  assert.match(replies[0].text, new RegExp(A(1)));
  assert.ok(!posted.some((p) => p.name === "social.post"));
  assert.equal(t.state.budget.credit, 0.00044);                   // the metered read is counted against the ceiling
});

test("board snapshot: latest read per token, slim fields, aged-out tokens dropped, /api/board shape", async () => {
  const { mergeReads, boardSnapshot } = await import("../agent/board-snapshot.mjs");
  const t = (a, o = {}) => ({ address: a, sym: "S" + a.slice(-2), mcapUsd: 1000, ageH: 2, risk: 30, label: "CLEAN", graduated: false,
    flags: { snipers: 1, bundles: 0, top10Pct: 40, holders: 300, coordPct: 9, insiderSellersNow: 0 }, whales: [1, 2], ...o });
  let r = mergeReads({}, [t(A(1)), t(A(2), { graduated: true, mcapUsd: 9000 }), t(A(3), { risk: null }), t(A(4), { flags: { holders: 0 } })], { now: NOW });
  assert.deepEqual(Object.keys(r).sort(), [A(1), A(2)]);                       // unread (risk null) and untraded (0 holders) skipped
  assert.equal(r[A(1)].flags.coordPct, undefined); assert.equal(r[A(1)].whales, undefined);   // slim
  r = mergeReads(r, [t(A(1), { risk: 70 })], { now: NOW + 3600e3 });
  assert.equal(r[A(1)].risk, 70);                                              // latest read wins
  const b = boardSnapshot(r, { launchTotal: 5, graduatedTotal: 2 }, { now: NOW + 3600e3 });
  assert.deepEqual([b.cooking.length, b.graduated.length, b.dex.length, b.stats.launchTotal], [1, 1, 0, 5]);
  assert.equal(b.graduated[0].section, "graduated"); assert.equal(b.cooking[0].ageH, 2); assert.equal(b.graduated[0].ageH, 3);   // age = launch age at read + time since
  assert.deepEqual(Object.keys(mergeReads(r, [], { now: NOW + 80 * 3600e3 })), []);   // past 72h → dropped
  const stale = { ...r, [A(9)]: { ...r[A(1)], address: A(9), flags: { holders: 0 } } };          // carried over from older state
  assert.equal(mergeReads(stale, [], { now: NOW + 3600e3 })[A(9)], undefined);
});

test("board snapshot: every row carries its read time; old reads lose the 'now' fields, older ones leave the board", async () => {
  const { mergeReads, boardSnapshot } = await import("../agent/board-snapshot.mjs");
  const t = (a, o = {}) => ({ address: a, sym: "S", mcapUsd: 1000, ageH: 2, risk: 30, flags: { holders: 300, insiderSellersNow: 2, insiderDumpNowPct: 3.1, top10Pct: 40 }, ...o });
  let r = mergeReads({}, [t(A(1)), t(A(2)), t(A(3))], { now: NOW });
  r = mergeReads(r, [t(A(1))], { now: NOW + 60 * 60e3 });                       // A(1) re-read an hour later
  r[A(3)].readAt = NOW - 3 * 3600e3;                                              // A(3) last read 4 h before the board
  const b = boardSnapshot(r, {}, { now: NOW + 60 * 60e3 });
  const row = (a) => b.cooking.find((x) => x.address === a);
  assert.deepEqual([row(A(1)).stale, row(A(1)).flags.insiderSellersNow, row(A(1)).readAt], [false, 2, NOW + 60 * 60e3]);
  assert.deepEqual([row(A(2)).stale, row(A(2)).flags.insiderSellersNow, row(A(2)).flags.top10Pct], [true, null, 40]);   // 60 min old: "now" blanked
  assert.equal(row(A(3)), undefined);                                             // past 3 h: off the board
  assert.equal(b.observedAt, NOW + 60 * 60e3);
});

test("format: a reply that is too long drops facts, never the address or footer", () => {
  const r = formatReply({ sym: "LONGNAMETOKEN123", address: A(2), mcapUsd: 4.8e6, ageH: 30, risk: 22,
    flags: { holders: 51234, top10Pct: 31.4, bundles: 12, snipers: 233, insiderSellersNow: 45 }, ownerRep: { launched: 400, graduated: 0 } });
  assert.ok(r.length <= MAX_LEN, r.length);
  assert.ok(r.includes(A(2)) && r.endsWith("Facts, not advice."));
});

test("dossier: the /api/token fields the page reads, bounded, movers split by net flow; unread tokens get none", async () => {
  const { dossierOf } = await import("../agent/board-snapshot.mjs");
  const whales = Array.from({ length: 60 }, (_, i) => ({ a: A(100 + i), bal: 1000 - i, first: 1e9 + i, bought: 1000, sold: 0, net: i % 3 === 0 ? 5 : i % 3 === 1 ? -5 - i : 0, sniper: i < 2 }));
  const d = dossierOf({ address: A(1), sym: "T", risk: 40, label: "MIXED", parts: { snipe: 3 }, flags: { holders: 300 }, ageH: 5.04, venue: "orbio-agent",
    whales, bundles: Array.from({ length: 9 }, (_, i) => ({ blk: i, n: 2, wallets: [A(1), A(2)], held: 1 })), deployer: { address: A(9), launched: 3, graduated: 0, scope: "every Orbio agent" } }, { now: NOW });
  assert.equal(d.whales.length, 40); assert.equal(d.bundles.length, 6); assert.equal(d.topHolders.length, 12);
  assert.ok(d.buyers.every((w) => w.net > 0) && d.sellers.every((w) => w.net < 0));
  assert.equal(d.sellers[0].net, Math.min(...d.whales.map((w) => w.net)));           // biggest seller first
  assert.deepEqual([d.ageH, d.readAt, d.static, d.deployer.launched], [5, NOW, true, 3]);
  assert.equal(dossierOf({ address: A(1), risk: null }), null);
});

test("alerts feed: newest first, capped, severity + label from the kind tables, unvalidated marked", async () => {
  const { alertsFeed } = await import("../agent/board-snapshot.mjs");
  const ev = (kind, at) => ({ at, kind, address: A(1), sym: "T", headline: "h", validated: kind !== "smart-convergence" });
  let f = alertsFeed(null, [ev("insider-dump", 1), ev("smart-convergence", 1)]);
  assert.deepEqual(f.events.map((e) => [e.kind, e.sev, e.validated]), [["insider-dump", "bad", true], ["smart-convergence", "good", false]]);
  f = alertsFeed(f, [ev("principal-withdrawn", 2)], { limit: 2 });
  assert.deepEqual(f.events.map((e) => e.kind), ["principal-withdrawn", "insider-dump"]);
  assert.equal(f.events[0].label, "creator withdrew unlocked fee stake");
});

test("materiality: small sales, short owner histories and routine fee withdrawals stay on the timeline", async () => {
  const { notMaterial } = await import("../agent/materiality.mjs");
  const dump = (o) => ({ kind: "insider-dump", mcapUsd: 80000, detail: { sellers: 1, pct: 0.5 }, ...o });
  assert.match(notMaterial(dump()), /1 wallet/);
  assert.equal(notMaterial(dump({ detail: { sellers: 2, pct: 0.5 } })), null);
  assert.equal(notMaterial(dump({ detail: { sellers: 1, pct: 12 } })), null);
  assert.match(notMaterial(dump({ mcapUsd: 9000, detail: { sellers: 4, pct: 30 } })), /posting floor/);
  assert.match(notMaterial({ kind: "serial-owner", detail: { prior: 3 } }), /fewer than 5/);
  assert.equal(notMaterial({ kind: "serial-owner", detail: { prior: 11 } }), null);
  for (const k of ["principal-withdrawn", "cliff-24h", "first-harvest", "credit-idle"]) assert.match(notMaterial({ kind: k }), /timeline only/);
});

test("follow-ups: a material sale is re-checked 24 h later — which wallets sold out, mcap then → now — threaded in dry run", async () => {
  const seller = "0x" + "e".repeat(40);
  const w = (o) => {
    const x = world(o);
    x.readToken = async (t, opt = {}) => ({ sym: t.sym, risk: 30, earlySellersNow: o.sellers ? [{ a: seller, amt: 900, block: 7, bal: 100 }] : [],
      watched: opt.watch ? Object.fromEntries(opt.watch.map((a) => [a, 0])) : undefined,
      flags: { insiderSellersNow: o.sellers, insiderDumpNowPct: 6, top10Pct: 38, holders: o.holders ?? 300, bundles: 0 } });
    return x;
  };
  const t1 = await runTick({ ...w({ sellers: 0 }), now: NOW, dryRun: true });
  const t2 = await runTick({ ...w({ sellers: 2 }), state: t1.state, now: NOW + 900e3, dryRun: true });
  const ev = t2.out.events.find((e) => e.kind === "insider-dump");
  assert.equal(ev.fate, "dry-run");
  assert.ok(t2.state.follow[ev.id]);
  assert.equal(t2.state.follow[ev.id].wallets[0], seller);
  const early = await runTick({ ...w({ sellers: 2 }), state: t2.state, now: NOW + 3 * 3600e3, dryRun: true });
  assert.equal(early.out.followUps.length, 0);                                      // not due
  const t3 = await runTick({ ...w({ sellers: 0, holders: 250 }), state: early.state, now: NOW + 900e3 + 24 * 3600e3, dryRun: true });
  assert.equal(t3.out.followUps.length, 1);
  const fu = t3.out.followUps[0];
  assert.match(fu.headline, /the early wallet that sold has since sold out/);
  assert.match(fu.headline, /market cap \$80k → \$80k · holders 300 → 250/);
  assert.equal(fu.ref, ev.id);
  const reply = t3.out.dryRun.find((r) => r.kind === "follow-up");
  assert.equal(reply.replyTo, ev.id);
  assert.match(reply.text, /^↻ \$T1 — 24h later/);
  assert.deepEqual(lint(reply.text), []);
  assert.equal(t3.state.follow[ev.id], undefined);                                  // closed once written
});

test("graduation: fires once when a launch seen on the curve is listed graduated; a cold start only learns", async () => {
  const w = (graduated) => { const x = world(); const fa = x.pons.fetchActive;
    x.pons.fetchActive = async (...a) => { const r = await fa(...a); return { ...r, items: r.items.map((t) => ({ ...t, graduated: t.address === A(1) ? graduated : false })) }; };
    return x; };
  const cold = await runTick({ ...w(true), now: NOW, dryRun: true });
  assert.ok(!cold.out.events.some((e) => e.kind === "graduated"));                  // never seen on the curve: no backlog
  const t1 = await runTick({ ...w(false), now: NOW, dryRun: true });
  const t2 = await runTick({ ...w(true), state: t1.state, now: NOW + 900e3, dryRun: true });
  const g = t2.out.events.find((e) => e.kind === "graduated");
  assert.ok(g);
  assert.match(g.headline, /^left the bonding curve · 5h after launch · 300 holders · top 10 wallets hold 38%/);
  assert.equal(g.fate, "dry-run");
  const t3 = await runTick({ ...w(true), state: t2.state, now: NOW + 1800e3, dryRun: true });
  assert.ok(!t3.out.events.some((e) => e.kind === "graduated"));
});

test("digest: once per UTC day after 17:00, counts from the agent's own record, lint-clean", async () => {
  const { digestDue, digestStats, formatDigest, remember } = await import("../agent/digest.mjs");
  const at = Date.UTC(2026, 9, 3, 18);
  assert.equal(digestDue(null, Date.UTC(2026, 9, 3, 16)), false);
  assert.equal(digestDue(null, at), true);
  assert.equal(digestDue("2026-10-03", at), false);
  const recent = remember([{ at: at - 2 * 86400e3, kind: "graduated", address: "old" }], [
    { at, kind: "insider-dump", address: "a" }, { at, kind: "insider-dump", address: "a" }, { at, kind: "graduated", address: "b" }, { at, kind: "serial-owner", address: "c" }], at);
  assert.equal(recent.length, 4);                                                    // the 2-day-old one is dropped
  const s = digestStats({ recent, now: at, launches: [{ ageH: 2, orbio: true }, { ageH: 5 }, { ageH: 30 }],
    reads: [{ sym: "AA", address: "0x" + "1".repeat(40), ageH: 3, flags: { holders: 900 } }, { sym: "BB", ageH: 40, flags: { holders: 5000 } }] });
  assert.deepEqual([s.launches, s.orbio, s.graduated, s.sells, s.sellTokens, s.serial, s.top.sym], [2, 1, 1, 2, 1, 1, "AA"]);
  const text = formatDigest(s);
  assert.match(text, /2 new launches \(1 Orbio agent\) · 1 graduated/);
  assert.match(text, /2 early-wallet sell-offs on 1 launch · 1 launch by repeat owners, none graduated/);
  assert.match(text, /Most holders: \$AA \(900\)\n0x1{40}/);
  assert.match(formatDigest({ ...s, launches: 999, orbio: 999, sells: 9999, sellTokens: 999, serial: 999, top: { ...s.top, sym: "X".repeat(40), holders: 1e6 } }), /Facts, not advice\.$/);
  // a launch with no holders is never "most holders"; no symbol never reads "$?"
  assert.equal(digestStats({ recent, now: at, launches: [], reads: [{ sym: "ORA", ageH: 2, flags: { holders: 0 } }] }).top, null);
  assert.match(formatPost({ kind: "serial-owner", sym: "?", headline: "h", address: "0x1" }), /^▲ an unnamed launch — repeat owner/);
  assert.deepEqual(lint(text), []);
});

test("graduation: a launch not re-read this cycle takes its facts from the agent's last read", async () => {
  const w = (graduated) => { const x = world(); const fa = x.pons.fetchActive;
    x.pons.fetchActive = async (...a) => { const r = await fa(...a); return { ...r, items: r.items.map((t) => ({ ...t, graduated: t.address === A(1) ? graduated : false })) }; };
    return x; };
  const t1 = await runTick({ ...w(false), now: NOW, dryRun: true });
  const x = w(true); x.readToken = async () => { throw new Error("not read this cycle"); };
  const t2 = await runTick({ ...x, state: t1.state, now: NOW + 900e3, dryRun: true, lastRead: (a) => (a === A(1) ? { flags: { holders: 412, top10Pct: 31, sniperHeldPct: 8 } } : null) });
  assert.match(t2.out.events.find((e) => e.kind === "graduated").headline, /412 holders · top 10 wallets hold 31% · early wallets hold 8%/);
  const t3 = await runTick({ ...x, state: t1.state, now: NOW + 900e3, dryRun: true, lastRead: (a) => (a === A(1) ? { flags: { holders: 9, top10Pct: 31, sniperHeldPct: 0.4 } } : null) });
  assert.match(t3.out.events.find((e) => e.kind === "graduated").headline, /early wallets hold under 1%$/);
});

test("candidates: plain Pons launches are read even when Orbio agents alone exceed the cap", async () => {
  const launchedAt = Math.floor((NOW - 5 * 3600e3) / 1000);
  const agents = Array.from({ length: 200 }, (_, i) => ({ ...raw(i + 10), token: "0x" + String(i + 10).padStart(40, "a"), launchedAt: String(launchedAt) }));
  const x = world();
  x.orbio.allAgents = async () => ({ agents, orbioUsd: 0.1 });
  const pons = { address: "0x" + "f".repeat(40), sym: "PONS", mcapUsd: 60000, launchedAt: new Date(NOW - 5 * 3600e3).toISOString() };
  x.pons.fetchActive = async () => ({ items: [pons] });
  const read = [];
  x.readToken = async (t) => { read.push(t.address); return { sym: t.sym, risk: 10, flags: { holders: 50 } }; };
  // a cap below the number of Orbio agents, as in production (575 eligible agents vs the old cap of 150)
  const t1 = await runTick({ ...x, now: NOW, dryRun: true, opts: { maxProfiles: 120 } });
  const t2 = await runTick({ ...x, state: t1.state, now: NOW + 900e3, dryRun: true, opts: { maxProfiles: 120 } });
  assert.ok(read.includes(pons.address), "the Pons launch was never read");
  assert.ok(t2.out.tokens.length <= 120);
});

test("pons deployers: Pons's own record names the deployer's history, and a repeat deployer's fresh launch fires once", async () => {
  const dep = "0x" + "d".repeat(40), x = world();
  const fresh = { address: "0x" + "e".repeat(40), sym: "NEW", mcapUsd: 30000, deployer: dep, launchedAt: new Date(NOW - 20 * 60e3).toISOString() };
  x.pons.fetchActive = async () => ({ items: [fresh] });
  const asked = [];
  x.pons.fetchDeployers = async (list) => { asked.push(...list); return { [dep]: { launches: 9, graduated: 0, firstSeenAt: NOW - 86400e3, lastLaunchAt: NOW } }; };
  const t1 = await runTick({ ...x, now: NOW, dryRun: true });
  const ev = t1.out.events.find((e) => e.kind === "serial-owner" && e.address === fresh.address);
  assert.ok(ev, "no repeat-deployer event");
  assert.match(ev.headline, /deployer launched 8 tokens before this one · 0 graduated/);
  assert.equal(ev.fate, "dry-run");                                                    // ≥5 earlier: material
  assert.equal(t1.out.tokens.find((t) => t.address === fresh.address).deployer.scope, "every Pons launch (Pons's own count)");
  const t2 = await runTick({ ...x, state: t1.state, now: NOW + 900e3, dryRun: true });
  assert.ok(!t2.out.events.some((e) => e.kind === "serial-owner" && e.address === fresh.address));   // once per launch
  assert.equal(asked.length, 1);                                                      // the record is kept 6 h, not re-fetched
});

test("candidates: the dust floor follows the curve's starting value (Orbio agents at ~$3.4k on 2026-10-08)", async () => {
  const x = world(), launchedAt = Math.floor((NOW - 5 * 3600e3) / 1000);
  // 9 untraded agents at the curve start ($3.4k) and one that traded up to $4.6k
  const agents = Array.from({ length: 10 }, (_, i) => ({ ...raw(i + 30), token: A(i + 30), launchedAt: String(launchedAt), price: { marketCapMicroUsd: String((i === 9 ? 4600 : 3400) * 1e6) } }));
  x.orbio.allAgents = async () => ({ agents, orbioUsd: 0.1 });
  x.pons.fetchActive = async () => ({ items: [] });
  const read = [];
  x.readToken = async (t) => { read.push(t.address); return { sym: t.sym, risk: 10, flags: { holders: 50 } }; };
  const r = await runTick({ ...x, now: NOW, dryRun: true });
  assert.equal(r.out.floorUsd, Math.round(3400 * 1.3));
  assert.deepEqual(read, [A(39)]);                                                    // traded above the start: read; untraded: not
});

test("tick: older launches come in a rotating Pons slice, are remembered above the floor, and drop out of the window", async () => {
  const calls = [], old = (h) => new Date(NOW - h * 3600e3).toISOString();
  const x = world();
  x.pons.fetchSlice = async ({ fromSec, toSec }) => { calls.push([fromSec, toSec]);
    return calls.length === 1 ? [{ address: A(7), sym: "MID", mcapUsd: 30000, launchedAt: old(10) }, { address: A(8), sym: "DUST", mcapUsd: 1200, launchedAt: old(11) }] : []; };
  const t1 = await runTick({ ...x, now: NOW, dryRun: true });
  assert.equal(calls[0][1], NOW / 1000 - 8 * 3600);                                   // first slice: 8–16 h old
  assert.ok(t1.state.ponsKnown[A(7)] && !t1.state.ponsKnown[A(8)]);                    // dust is not remembered
  assert.ok(t1.state.profiledAt[A(7)]);                                                 // and the remembered launch is read
  const t2 = await runTick({ ...x, state: t1.state, now: NOW + 900e3, dryRun: true });
  assert.equal(calls[1][1], (NOW + 900e3) / 1000 - 16 * 3600);                         // next cycle, the next slice
  assert.ok(t2.state.ponsKnown[A(7)]);                                                  // kept until its slice comes round again
  const t3 = await runTick({ ...x, state: t2.state, now: NOW + 63 * 3600e3, dryRun: true });
  assert.equal(t3.state.ponsKnown[A(7)], undefined);                                    // past 72 h: gone
});
