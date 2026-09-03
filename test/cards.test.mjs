import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCards, _internals } from "../cards.mjs";

const board = {
  stats: { launchTotal: 4200000, graduatedTotal: 510 },
  cooking: [{ sym: "AAA", risk: 20, blueprint: 80, blueprintLabel: "STRONG FIT", mcapUsd: 300000, ageH: 5, flags: { holders: 120, bundles: 0, top10Pct: 22, insiderSellersNow: 0 } }],
  dex: [{ sym: "BBB", risk: 70, mcapUsd: 900000, flags: { holders: 60, insiderSellersNow: 2 } }],
  graduated: [{ sym: "CCC", risk: 50, mcapUsd: 3000000, flags: { holders: 400, insiderSellersNow: 0 } }],
};
const validation = { cohort: { winners: 26, losers: 207 } };
const trackReady = { predicted: 40, pending: 10, resolved: 30, winners: 12, ready: true, minShow: 10, baseRate: 0.15, promising: { n: 14, winners: 8, winRate: 0.57 }, lift: 3.8, horizonH: 72 };
const smartMoney = { tokens: [{ sym: "AAA", count: 4, mcapUsd: 300000, risk: 20 }] };
const leaderboard = { rows: [{ a: "0xabc", realized: 39000, pnl: 41000, roi: 11, tokensWon: 3, winRate: 80 }] };

test("fade card: honest % faded from the cohort", () => {
  const c = _internals.fadeCard(validation);
  assert.equal(c.hero, "89%");                 // 207/233
  assert.match(c.tweet, /233/);
  assert.match(c.tweet, /Signal, not proof/);
  assert.equal(c.viz.type, "ring");
});

test("pulse card: verdict spread + no fake data", () => {
  const c = _internals.pulseCard(board);
  assert.equal(c.hero, "1");                    // one token risk<35 (AAA)
  assert.equal(c.viz.type, "bars");
  const clean = c.viz.segs.find((s) => s.label === "clean");
  assert.equal(clean.v, 1);
  assert.match(c.tweet, /insiders? selling|flashing/);
});

test("track card: ready shows out-of-sample rate + lift", () => {
  const c = _internals.trackCard(trackReady);
  assert.equal(c.hero, "57%");
  assert.match(c.tweet, /base rate/);
  assert.equal(c.viz.type, "gauge");
});

test("track card: not-ready falls back to the honest accruing state", () => {
  const c = _internals.trackCard({ predicted: 5, pending: 5, resolved: 0, minShow: 10, ready: false });
  assert.equal(c.hero, "0/10");
  assert.match(c.tweet, /public/i);
});

test("smart card needs real convergence (>=2)", () => {
  assert.ok(_internals.smartCard(smartMoney));
  assert.equal(_internals.smartCard({ tokens: [{ sym: "X", count: 1 }] }), null);
});

test("spotlight only fires on a clean-reading token, framed as a read not a call", () => {
  const c = _internals.spotlightCard(board);
  assert.equal(c.hero, "AAA");
  assert.match(c.eyebrow, /READ, NOT A CALL/);
  assert.match(c.tweet, /not a call/i);
  // a board with only risky tokens → no spotlight
  assert.equal(_internals.spotlightCard({ dex: [{ sym: "Z", risk: 80, blueprint: 10, mcapUsd: 1 }] }), null);
});

test("buildCards assembles only the cards that can be built honestly", () => {
  const out = buildCards({ board, validation, track: trackReady, smartMoney, leaderboard });
  const ids = out.cards.map((c) => c.id);
  assert.deepEqual(new Set(ids), new Set(["pulse", "spotlight", "smart", "fade", "track", "leader"]));
  assert.equal(out.count, 6);
  // empty context → no cards, no throw
  assert.equal(buildCards({}).count, 0);
});
