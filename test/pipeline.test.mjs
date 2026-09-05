// End-to-end test of the model pipeline on a SYNTHETIC cohort (no RPC): fake slim profiles → cohort index →
// corridor → projection → gen-model → validate, in a scratch STUDY_DIR. Pins that the builders read the outcome
// index (not the old dirs), that model.json carries the cohort basis, and that validation reports the tiers,
// the faded-only control and the time split without fabricating anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const H = 3600;
// a synthetic backtest series: `shape` = winner (clean, adopting) or fade (bundled, concentrated, dying)
function series(t0, hours, shape, seed) {
  const pts = [], n = 60; let holders = 20 + seed, wallets = 25 + seed;
  for (let i = 1; i <= n; i++) {
    const a = (hours * i) / n, t = t0 + a * H;
    if (shape === "winner") { holders += Math.round(200 / (1 + a / 60) + seed % 3); wallets += Math.round(250 / (1 + a / 60)); }
    else { holders += i < 6 ? 30 : i < 20 ? 2 : 0; wallets += i < 6 ? 35 : 1; if (i > 30) holders = Math.max(30, holders - 3); }
    const top10 = shape === "winner" ? Math.max(28, 70 - a * 2) : Math.min(95, 55 + a * 1.5);
    const risk = shape === "winner" ? Math.max(12, 40 - a) : Math.min(90, 45 + a * 1.2);
    const mcap = shape === "winner" ? Math.min(3e6 + seed * 1e5, 2e4 * Math.pow(1 + a, 1.6)) : (a < 40 ? 4e5 * Math.min(1, a / 8) : 4e5 / (1 + (a - 40) / 4));
    pts.push({ t: Math.round(t), risk: Math.round(risk), top10: +top10.toFixed(1), sniperHeld: 2, holders, wallets, bundles: shape === "winner" ? 0 : 2, mcap: Math.round(mcap), price: mcap / 1e9, volUsd: 1000, ageH: +a.toFixed(2), blueprint: shape === "winner" ? 70 : 20, traj: shape === "winner" ? 75 : 30 });
  }
  return pts;
}

test("pipeline: synthetic cohort → corridor → projection → model → validation", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "b0-study-"));
  process.env.STUDY_DIR = dir;
  const lib = await import("../tools/cohort-lib.mjs?" + Date.now());
  const now = Date.now() / 1000, entries = [];
  const mk = (i, shape, hoursAgo, hours) => {
    const t0 = now - hoursAgo * H, s = series(t0, hours, shape, i);
    const p = { addr: "0x" + String(i).padStart(40, "0"), sym: shape.toUpperCase() + i, name: null, source: i % 5 === 0 ? "dex" : "pons", graduated: shape === "winner", launchedAt: new Date(t0 * 1000).toISOString(),
      t0: Math.round(t0), t1: Math.round(t0 + hours * H), supply: 1e9, transfers: 5000, capped: false, bundles: shape === "winner" ? 0 : 2, snipers: 3, cachedAt: new Date().toISOString(), cacheMcap: null, series: s };
    lib.writeProfile(p);
    const live = { mcapUsd: shape === "winner" ? s[s.length - 1].mcap : 3e4 };
    entries.push(lib.indexEntry(p, lib.classifyProfile(p, live, now)));
  };
  // 14 winners launched across ~50 days (so the time split has a later slice), 16 faded, 6 stalled
  for (let i = 1; i <= 14; i++) mk(i, "winner", 50 * 24 - i * 3 * 24, 30 * 24);
  for (let i = 20; i < 36; i++) mk(i, "fade", 40 * 24 - (i - 20) * 2 * 24, 5 * 24);
  for (let i = 40; i < 46; i++) { const t0 = now - 10 * 24 * H; const p = { addr: "0x" + String(i).padStart(40, "0"), sym: "SMALL" + i, source: "pons", graduated: false, launchedAt: new Date(t0 * 1000).toISOString(), t0: Math.round(t0), t1: Math.round(t0 + 48 * H), supply: 1e9, transfers: 40, bundles: 0, snipers: 1, cachedAt: new Date().toISOString(), series: series(t0, 48, "fade", i).map((q) => ({ ...q, mcap: 2e4 })) }; lib.writeProfile(p); entries.push(lib.indexEntry(p, lib.classifyProfile(p, { mcapUsd: 2e4 }, now))); }
  const idx = lib.writeIndex(entries);
  assert.equal(idx.counts.runner + idx.counts.major, 14, "all synthetic winners labelled winner: " + JSON.stringify(idx.counts));
  assert.equal(idx.counts.faded, 16); assert.equal(idx.counts.stalled, 6);

  const run = (script, args = []) => { const r = spawnSync(process.execPath, [join(ROOT, "tools", script), ...args], { cwd: ROOT, env: { ...process.env, STUDY_DIR: dir }, encoding: "utf8" }); assert.equal(r.status, 0, script + " failed:\n" + r.stdout + r.stderr); return r.stdout; };
  run("corridor.mjs"); run("projection.mjs"); run("extract_blueprint.mjs");
  const modelPath = join(dir, "model.json");
  run("gen-model.mjs", ["--out=" + modelPath]);
  const model = JSON.parse(readFileSync(modelPath, "utf8"));
  assert.ok(model.ladder.length >= 3 && model.corridor.length >= 3, `ladder ${model.ladder.length} corridor ${model.corridor.length} ${JSON.stringify(model.ladder)}`);
  assert.equal(model.cohort.winners, 14); assert.equal(model.cohort.definitions.length, 7);
  assert.ok(model.corridor.some((b) => b.tw != null && b.tm != null), "stage targets attached");
  run("validate.mjs");
  const v = JSON.parse(readFileSync(join(dir, "validation.json"), "utf8"));
  assert.equal(v.cohort.winners, 14); assert.equal(v.cohort.losers, 22); assert.equal(v.cohort.faded, 16);
  assert.ok(v.perBin.length >= 3 && v.perBin.every((r) => "aucFaded" in r));
  assert.ok(v.headline.falsePosFaded != null);
  assert.equal(v.timeSplit.ready, true, JSON.stringify(v.timeSplit));
  assert.ok(v.timeSplit.testWinners >= 4 && v.timeSplit.catch != null);
  // synthetic winners are cleanly separable — the pipeline must see that (sanity, not a claim about real data)
  assert.ok(v.lateLife.aucWinnerVsFaded > 0.9, "late-life AUC vs faded " + v.lateLife.aucWinnerVsFaded);

  // guard: below the minimum winner count gen-model refuses to overwrite an existing model
  const few = entries.filter((e) => e.label !== "runner" && e.label !== "major").concat(entries.filter((e) => e.label === "runner" || e.label === "major").slice(0, 3));
  lib.writeIndex(few); run("corridor.mjs"); run("projection.mjs");
  const before = readFileSync(modelPath, "utf8");
  run("gen-model.mjs", ["--out=" + modelPath]);
  assert.equal(readFileSync(modelPath, "utf8"), before, "model kept when the cohort is too small");
  rmSync(dir, { recursive: true, force: true }); delete process.env.STUDY_DIR;
  assert.ok(!existsSync(dir));
});
