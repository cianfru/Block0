import { test } from "node:test";
import assert from "node:assert/strict";
import { provenLedger, provenAt } from "../smart-money.mjs";

const W = (n) => "0x" + String(n).padStart(40, "b");
const T0 = 1_800_000_000, D = 86400;
// three tokens; wallet 1 wins cleanly on A and B, wallet 2 wins only by sniping, wallet 3 wins once then holds
const profiles = [
  { addr: "tokA", traders: [
    { a: W(1), exitT: T0 + 1 * D, realized: 5000, invested: 1000, sniper: false },
    { a: W(2), exitT: T0 + 1 * D, realized: 9000, invested: 1000, sniper: true },   // sniped → never counts
    { a: W(3), exitT: T0 + 1 * D, realized: 4000, invested: 1000, sniper: false },
  ] },
  { addr: "tokB", traders: [
    { a: W(1), exitT: T0 + 3 * D, realized: 7000, invested: 1000, sniper: false },
    { a: W(2), exitT: T0 + 3 * D, realized: 8000, invested: 1000, sniper: true },
    { a: W(3), exitT: null,       realized: 0,    invested: 2000, sniper: false },  // still holding → no proof
  ] },
  { addr: "tokC", traders: [
    { a: W(1), exitT: T0 + 9 * D, realized: 1000, invested: 1000, sniper: false },
    { a: W(4), exitT: T0 + 2 * D, realized: 50,   invested: 1000, sniper: false },  // dust win → below minRealized
  ] },
];
const led = provenLedger(profiles);

test("a sniper's wins never enter the ledger — insider access is not skill", () => {
  assert.equal(led.has(W(2)), false);
});

test("dust wins and still-open positions are not proof", () => {
  assert.equal(led.has(W(4)), false, "below minRealized");
  assert.equal((led.get(W(3)) || []).length, 1, "the open position on tokB contributes nothing");
});

test("proof is POINT-IN-TIME: a wallet is not smart money before its second win closed", () => {
  const w = W(1);
  assert.equal(provenAt(led, w, T0 + 2 * D), false, "one win by day 2 → not proven");
  assert.equal(provenAt(led, w, T0 + 4 * D), true, "second win closed on day 3 → proven from day 4");
  assert.equal(provenAt(led, w, T0 + 3 * D), false, "strictly before: the win closing AT T does not count yet");
});

test("one win is never enough — the old bar (>=1) would have minted an insider", () => {
  assert.equal(provenAt(led, W(3), T0 + 100 * D), false, "one clean win, still not proven");
  assert.equal(provenAt(led, W(3), T0 + 100 * D, { minWins: 1 }), true, "…unless you use the broken bar");
});

test("a wallet is never credited as smart for the very token being judged", () => {
  const w = W(1);  // wins: tokA day1, tokB day3, tokC day9
  assert.equal(provenAt(led, w, T0 + 5 * D), true, "by day 5 it has A + B → proven");
  assert.equal(provenAt(led, w, T0 + 5 * D, { exclude: "tokB" }), false, "judging tokB itself, only A counts → not proven");
  assert.equal(provenAt(led, w, T0 + 10 * D, { exclude: "tokB" }), true, "by day 10 A + C stand on their own");
});
