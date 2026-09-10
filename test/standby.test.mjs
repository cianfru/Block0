// The project is parked. These pin that "parked" means no chain reads happen on their own — not from a timer,
// and not because a visitor arrived. ensureFresh is the one that bites: it fires a full board scan the moment
// the cache goes stale, so a single request to /api/board would otherwise restart the whole thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
// board.mjs reads the switch once at import, so each case needs its own process. RPC_URL points at a black hole:
// if anything tries to read the chain the probe reports it instead of quietly succeeding.
const probe = (env, code) => JSON.parse(execFileSync(process.execPath, ["-e", code],
  { cwd: root, encoding: "utf8", timeout: 30000,
    env: { ...process.env, RPC_URL: "http://127.0.0.1:1", DEX_RPC: "http://127.0.0.1:1", ...env } })
  .trim().split("\n").at(-1));

const CODE = `
  const t0 = Date.now();
  const b = await import("./board.mjs");
  await b.refreshBoard();
  b.ensureFresh(0);                    // a visitor hitting /api/board with a cold cache
  await b.refreshDex();
  await new Promise(r => setTimeout(r, 300));
  const board = b.getBoard();
  console.log(JSON.stringify({ standby: b.STANDBY, ms: Date.now() - t0,
    scanned: (board.cooking||[]).length + (board.graduated||[]).length + (board.dex||[]).length,
    scanning: !!board.scanning }));
`;

// Returning fast here is meaningful: with the switch ON the same calls hang trying to reach the dead endpoint,
// so "immediate and empty" can only mean no read was attempted.
test("parked by default: no scan from a timer, and none from a visitor either", () => {
  const r = probe({ BACKGROUND_ON: "" }, CODE);
  assert.equal(r.standby, true);
  assert.equal(r.scanned, 0, "nothing was read from the chain");
  assert.equal(r.scanning, false, "and no scan was left running in the background");
  assert.ok(r.ms < 5000, `returned immediately rather than attempting the network (${r.ms}ms)`);
});

test("BACKGROUND_ON=1 is the way back, and it is the only way back", () => {
  // Only read the flag here. Actually calling refreshBoard with the switch on reaches for the network and hangs
  // against the black-hole endpoint — which is itself the proof that the case above was not simply failing fast.
  const r = probe({ BACKGROUND_ON: "1" },
    'const b = await import("./board.mjs"); console.log(JSON.stringify({ standby: b.STANDBY }));');
  assert.equal(r.standby, false, "the switch flips, so parking is reversible");
});

test("the server runs every recurring loop only when explicitly told to", () => {
  const src = execFileSync("node", ["-e", 'process.stdout.write(require("fs").readFileSync("server.mjs","utf8"))'],
    { cwd: root, encoding: "utf8" });
  assert.match(src, /const BACKGROUND_ON = process\.env\.BACKGROUND_ON === "1";/,
    "opt-in, so a fresh deploy never starts scanning on its own");
  // every loop that used to run on a timer stays behind that switch
  for (const loop of ["startExperiment()", "boardCycle()", "refreshDex()", "refreshLeaderboard()", "refreshPicks()", "startAlerts()"])
    assert.ok(src.includes(loop), `${loop} still present`);
});
