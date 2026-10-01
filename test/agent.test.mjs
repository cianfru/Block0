import { test } from "node:test";
import assert from "node:assert/strict";
import { normAgent, agentEvents } from "../agent/agent-events.mjs";
import { formatPost, formatReply, lint, footer, cleanSym, MAX_LEN } from "../agent/format.mjs";
import { plan, record, canReply, freshBudget } from "../agent/budget.mjs";
import { parseMention, resolveSymbol, selectMentions } from "../agent/mentions.mjs";
import { makeOrbio, OrbioError } from "../agent/orbio.mjs";
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

test("format: ≤280 chars, link + footer always present, unvalidated kinds say so", () => {
  const ev = { kind: "insider-dump", sym: "PEPE", address: A(1), mcapUsd: 212000, ageH: 5, venue: "orbio-agent", headline: "3 insider wallets started selling · 4.1% of supply moving" };
  const t = formatPost(ev, { publicUrl: "https://block0.xyz/" });
  assert.ok(t.length <= MAX_LEN);
  assert.match(t, /^▼ \$PEPE — insiders selling\n/);
  assert.match(t, /\$212k mcap · 5h old · Orbio agent/);
  assert.match(t, new RegExp(`https://block0.xyz/token\\?address=${A(1)}`));
  assert.match(t, /On-chain facts, not advice\.$/);
  assert.equal(footer("smart-convergence", { forwardN: 12 }), "Not validated (forward test n=12). Facts, not advice.");
  const long = formatPost({ ...ev, headline: "x".repeat(400) }, { publicUrl: "https://block0.xyz" });
  assert.ok(long.length <= MAX_LEN && long.endsWith("not advice."));
});

test("format: lint rejects calls, hype and accusations; symbols are sanitised", () => {
  for (const bad of ["this will pump", "buy now", "Sell now!", "next gem", "classic rug", "looks like a scam", "100x likely", "price target"]) assert.ok(lint(bad).length, bad);
  for (const ok of ["3 early wallets started selling", "creator withdrew 400 staked ORBIO"]) assert.deepEqual(lint(ok), [], ok);
  assert.equal(cleanSym("@elon\nhttps://x.co"), "elonhttpsx.co");
  assert.ok(lint("a".repeat(281)).length);
});

test("format: mention reply carries the facts, the link and the footer", () => {
  const r = formatReply({ sym: "ABC", address: A(2), mcapUsd: 48000, ageH: 30, risk: 22, flags: { holders: 512, top10Pct: 31.4, bundles: 0, snipers: 2, insiderSellersNow: 0 },
    ownerRep: { launched: 4, graduated: 0 } }, { publicUrl: "https://block0.xyz" });
  assert.match(r, /\$ABC · \$48k mcap · 30h old\nrisk 22\/100 · 512 holders · top10 31% · no bundles · 2 snipers\nowner: 4 launches, 0 graduated/);
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

test("orbio client: max_cost always sent, 401/402 typed, no key = no metered call", async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const st = JSON.parse(init.body).text === "402" ? 402 : JSON.parse(init.body).text === "401" ? 401 : 200;
    return { ok: st === 200, status: st, json: async () => ({ id: "p1" }) }; };
  const o = makeOrbio({ apiKey: "k", fetch: f });
  await o.tool("social.post", { text: "hi" }, 0.02);
  assert.equal(JSON.parse(calls[0].init.body).max_cost, "0.02");
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
  await assert.rejects(o.tool("social.post", { text: "402" }, "0.02"), (e) => e instanceof OrbioError && e.code === "balance");
  await assert.rejects(o.tool("social.post", { text: "401" }, "0.02"), (e) => e.code === "auth");
  await assert.rejects(o.tool("social.post", { text: "x" }), (e) => e.code === "nocap");
  await assert.rejects(makeOrbio({ fetch: f }).tool("social.post", {}, "0.02"), (e) => e.code === "nokey");
});

// stubbed world for the tick
function world({ sellers = 0, withdrawn = 0n, posted = [] } = {}) {
  const launchedAt = new Date(NOW - 5 * 3600e3).toISOString();
  return {
    orbio: { allAgents: async () => ({ agents: [raw(1, { withdrawn })], orbioUsd: 0.1 }), tool: async (name, args) => { posted.push({ name, args }); return { id: "x" }; } },
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
  const t2 = await runTick({ ...world({ sellers: 2, withdrawn: 300n, posted }), state: t1.state, now: NOW + 900e3, dryRun: true, publicUrl: "https://block0.xyz" });
  assert.deepEqual(t2.out.dryRun.map((r) => r.kind).sort(), ["insider-dump"]);           // one post per token per 6h: dump outranks withdrawal
  assert.ok(t2.out.held.some((h) => h.kind === "principal-withdrawn" && h.why === "token posted within 6h"));
  assert.equal(posted.length, 0);                                                        // nothing reached Orbio
  assert.equal(t2.state.profiledAt[A(2)], undefined);                                     // 9-day-old token never read
  if (board) assert.equal(board.STANDBY, standbyBefore);
});

test("tick: live mode posts through social.post with max_cost; a 402 stops posting for the day", async () => {
  const posted = [];
  const t1 = await runTick({ ...world({ posted }), now: NOW, dryRun: false });
  const t2 = await runTick({ ...world({ sellers: 1, posted }), state: t1.state, now: NOW + 900e3, dryRun: false });
  assert.equal(posted.length, 1); assert.equal(posted[0].name, "social.post"); assert.deepEqual(posted[0].args.platforms, ["x"]);
  const w = world({ sellers: 0, withdrawn: 500n });
  w.orbio.tool = async () => { throw new OrbioError("balance", "402"); };
  const t3 = await runTick({ ...w, state: t2.state, now: NOW + 7 * 3600e3, dryRun: false });
  assert.equal(t3.state.stoppedDay, "2026-10-01");
  assert.ok(t3.out.held.some((h) => h.why === "post failed"));
});

test("board snapshot: latest read per token, slim fields, aged-out tokens dropped, /api/board shape", async () => {
  const { mergeReads, boardSnapshot } = await import("../agent/board-snapshot.mjs");
  const t = (a, o = {}) => ({ address: a, sym: "S" + a.slice(-2), mcapUsd: 1000, ageH: 2, risk: 30, label: "CLEAN", graduated: false,
    flags: { snipers: 1, bundles: 0, top10Pct: 40, holders: 300, coordPct: 9, insiderSellersNow: 0 }, whales: [1, 2], ...o });
  let r = mergeReads({}, [t(A(1)), t(A(2), { graduated: true, mcapUsd: 9000 }), t(A(3), { risk: null })], { now: NOW });
  assert.deepEqual(Object.keys(r).sort(), [A(1), A(2)]);                       // unread (risk null) skipped
  assert.equal(r[A(1)].flags.coordPct, undefined); assert.equal(r[A(1)].whales, undefined);   // slim
  r = mergeReads(r, [t(A(1), { risk: 70 })], { now: NOW + 3600e3 });
  assert.equal(r[A(1)].risk, 70);                                              // latest read wins
  const b = boardSnapshot(r, { launchTotal: 5, graduatedTotal: 2 }, { now: NOW + 3600e3 });
  assert.deepEqual([b.cooking.length, b.graduated.length, b.dex.length, b.stats.launchTotal], [1, 1, 0, 5]);
  assert.equal(b.graduated[0].section, "graduated"); assert.equal(b.cooking[0].ageH, 2); assert.equal(b.graduated[0].ageH, 3);   // age = launch age at read + time since
  assert.deepEqual(Object.keys(mergeReads(r, [], { now: NOW + 80 * 3600e3 })), []);   // past 72h → dropped
});
