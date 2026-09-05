import { test } from "node:test";
import assert from "node:assert/strict";

// Every server-side module must import cleanly (top-level evaluation). Catches broken import graphs/cycles.
const MODULES = ["../alert-events.mjs","../alerts.mjs","../backtest.mjs","../board.mjs","../cards.mjs","../deployer.mjs","../dossier.mjs",
  "../graph.mjs","../intel.mjs","../leaderboard.mjs","../llm.mjs","../model.mjs","../picks.mjs","../pnl.mjs","../ratelimit.mjs",
  "../smart-money.mjs","../social.mjs","../track-record.mjs","../wallet.mjs","../wallet-pnl.mjs","../outcome.mjs","../tools/cohort-lib.mjs"];
for (const m of MODULES) test("module imports: " + m.replace("../", ""), async () => { const mod = await import(m); assert.ok(mod); });

// Static guard for the exact bug that emptied the board: an identifier used in a module must be imported or declared
// there. Cheap check over the identifiers we share across modules.
import { readFileSync } from "node:fs";
const SHARED = { "deployerReputation": "deployer.mjs", "compactRep": "deployer.mjs", "corridorStatus": "model.mjs", "liveTrajectory": "model.mjs",
  "blueprintMatch": "intel.mjs", "detectEvents": "alert-events.mjs", "formatEvent": "alert-events.mjs", "walletTokenSet": "wallet.mjs" };
for (const file of ["board.mjs","dossier.mjs","alerts.mjs","server.mjs"]) test("no unimported shared identifiers in " + file, () => {
  const src = readFileSync(new URL("../" + file, import.meta.url), "utf8");
  for (const [id, from] of Object.entries(SHARED)) {
    const used = new RegExp("\\b" + id + "\\s*\\(").test(src);
    const declared = new RegExp("(import[^;]*\\b" + id + "\\b[^;]*from|function\\s+" + id + "\\b|const\\s+" + id + "\\b|let\\s+" + id + "\\b)").test(src);
    if (used && !declared) assert.fail(file + " uses " + id + "() without importing it from " + from);
  }
});
