> **Build status (2026-10-01): v1 built, DRY RUN.** `agent/` + `tools/agent-tick.mjs` + `.github/workflows/agent.yml`.
> Deviations from this brief, on purpose: (1) `smart-convergence` / `clean-launch` are **logged, never posted** until the
> radar forward test says PASS; (2) there is **no metered `chain.read` fallback** at all — token reads stay on the free node;
> (3) `serial-owner` uses Orbio's own agent list (owner → prior agents, graduated) instead of the Pons deployer list;
> (4) `first-harvest` fires when converted fees cross **$100**, not on the first 5-min harvest (that fires for every agent);
> (5) the runner is one **6-hour watch job looping every 15 min** (cold reads cost ~20 s/token on the free node; the loop
> keeps the transfer store warm), not a fresh 15-min cron. Reflex (low-timeframe trend reads) = **phase 2**, on standby.

# Block0 Agent on Orbio — design + build brief

Status: **proposal, not built.** Written 2026-10-01 from a review of the Orbio launchpad (orbio.so/launchpad), its
public API/docs (`/launchpad/docs.md`, `/api/v1/tools`, `/api/v1/models`) and this repo. Hand this file to Claude Code
as the spec. Everything Orbio-side quoted below was read live on 2026-10-01 — re-check prices/caps before shipping.

> House rules still apply (see CLAUDE.md): the project is PARKED — this agent must not flip `BACKGROUND_ON` or call
> `refreshBoard`/`ensureFresh`. It is a separate, opt-in loop. Zero metered RPC by default. Radar/convergence is
> **not validated** until `REPORT.txt` says PASS — say so on every post that uses it.

---

## 1. Why Orbio fits Block0

- **Orbio is an agent launchpad on Robinhood Chain (chain 4663) built on Pons** — the same launch venue Block0 already
  indexes and grades. Every Orbio agent token is a Pons launch paired with **$ORBIO**
  (`0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3` — already in `public/smart-wallets.json` `quotes`, so sells into
  ORBIO pools are not misread as buys).
- **Economics** (launch terms, `GET /api/protocol/agents/terms`): creator fees are harvested every 5 min and split
  **50% staked** in $ORBIO (earns $CREDIT hourly), **45% sold for USDG → spendable gateway balance**, **5% treasury**.
  Launch fee 0.0005 ETH + gas. Principal locked 10 days (`cliffSeconds: 864000`). 1 $CREDIT = $1 of balance.
- **The gateway balance pays exactly the costs Block0 lacks a budget for**: posting to X, X reads, Alchemy chain
  reads, LLM inference. It does **not** host a runtime (Railway/Actions stay ours).
- **Scale reality** (analytics, 2026-10-01): 345 agents, $6.52M combined mcap, ~$173k creator fees harvested
  all-time → average agent ≈ $500. Top: errand ~$1.08M, TANK ~$674k. Precedent: "Orbio Research Desk" ($ORDESK,
  ~$51k). Treat fees as covering marginal running cost, not as income.
- **Audience match**: Orbio/Pons traders arrive from X on a phone asking "should I ape?" — Block0's stated user.

## 2. What the agent is

An X account (+ the existing Block0 web/Telegram) that posts **reproducible on-chain facts** about Pons/Orbio launches
and answers `@mentions` with a token read. Never a buy/sell call. Its edge is radical transparency, including
publishing its own token's dossier and its own forward-test scorecard (misses included).

## 3. Orbio surface we use

All public reads need no key. Metered tools: `POST https://api.orbio.so/api/v1/tools/{name}`,
`Authorization: Bearer $ORBIO_API_KEY`, JSON body + `max_cost` (string, $CREDIT). Settles at provider cost + 10%.
401 = bad key, 402 = insufficient balance. SDK alternative: `@orbiodotso/sdk` (`createOrbio({ apiKey })`).

| Use | Endpoint / tool | Price (2026-10-01) |
|---|---|---|
| New agents + economics | `GET /api/protocol/agents?sort=newest&limit=200` (and `/{id}`) | free |
| Launch terms | `GET /api/protocol/agents/terms` | free |
| Agent price history | `GET /api/protocol/agents/{id}/chart?range=1h\|4h\|1d` | free |
| Posting allowance | `social.accounts` | free |
| Publish | `social.post` `{ platforms:["x"], text, media?, reply_to?, quote? }` | 0.0187 / X post |
| Confirm | `social.post.status` | free |
| Take down | `social.post.delete` | 0.0055 |
| Read mentions | `social.x.posts` `{ handle, mentions_of… }` (≈20 posts/page) | 0.00022 / post |
| Measure own posts | `social.x.lookup` | 0.00022 / post |
| Chain fallback | `chain.read` `{ method, params, network:"robinhood" }` — `eth_getLogs`, `eth_call`, `eth_getCode`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `alchemy_getAssetTransfers`, `alchemy_getTokenBalances`, … | 0.000002 / CU (getLogs ≈ 75 CU ≈ $0.00015) |
| LLM (optional) | OpenAI-compatible `https://api.orbio.so/api/v1/chat/completions`, model id from `/api/v1/models` (e.g. `deepseek/deepseek-v4.1-flash`) | ~$0.03/M in, $0.6/M out |

Publisher caps per UTC day: **X 50 original posts, 100 replies.** X accepts a reply only to our own posts or posts
that mention us; a quote only of those or of a conversation we're in. The owner must connect the X account in the
Orbio dashboard (Tools & connections) — the agent cannot.

Agent record fields we rely on (`/api/protocol/agents` → `data[]`): `agentId, token, name, symbol, owner,
agentWallet, receiver, feeBps, launchedAt (unix s), launchTx, price{graduated, priceMicroUsd, marketCapMicroUsd},
curve, stake{orbioWei, claimedFeesWei, protocolFeeWei, stakedWei, withdrawnWei}, credit{owedAtoms, claimedAtoms,
activatedAtoms}, converted{orbioWei, usdgAtoms, pendingOrbioWei}, cliff{unlocksAt, locked}, socials, description`.
`null` means unavailable, never zero. Market data API has **no trades/volume/holders** — that's Block0's job.

## 4. Architecture

```
tools/agent-tick.mjs        one cycle, then exit (Actions) — or loop with --watch (Railway worker)
agent/orbio.mjs             thin client: publicGet(path), tool(name, args, maxCost), chat(messages)
agent/agent-events.mjs      PURE: Orbio-economics transitions (prev, agents) -> { events, next }
agent/format.mjs            PURE: event -> X text (<=280), mention reply text, footer rules, forbidden-word check
agent/budget.mjs            PURE: caps, cooldowns, dedupe, daily spend ledger
agent/mentions.mjs          PURE parse: post text -> { address | symbol } ; resolver uses Pons + Orbio lists
test/agent-*.test.mjs       node --test, fetch injected, no network
.github/workflows/agent.yml cron every 15 min, state on branch `agent-data` (never main → no Railway deploy)
```

Reuse, unchanged: `pons.mjs` (`fetchActive`, `fetchGraduated`), `intel.mjs` (`computeIntel`), `dossier.mjs`
(`tokenDossier`), `deployer.mjs` (`deployerReputation`, `compactRep`), `alert-events.mjs` (`detectEvents`, `KINDS`),
`public/radar-core.js` (`verdict`, `walletKind`), `tools/radar-log.mjs` (`--outcomes`, `--report`).

**Runner choice:** start on GitHub Actions (free while repo is public; same pattern as `radar-log.yml`: checkout,
orphan data branch, commit state). If cron delay makes posts too stale, move the same `agent-tick.mjs --watch` to a
Railway worker. Secrets: `ORBIO_API_KEY`, optional `ORBIO_MODEL`, `AGENT_X_HANDLE`, `AGENT_DRY_RUN` (default `1`),
`PUBLIC_URL` (Block0 site for links).

**RPC:** native node only (`rpc.mjs` with no `RPC_URL`/Alchemy env). On repeated 429/timeouts, fall back per call to
`chain.read` with `max_cost` set; log every metered call into the spend ledger. Never enable Alchemy env in the agent.

## 5. The tick (one cycle)

1. **Load state** from `agent-data/state.json`: `prevBoard` (detectEvents snapshot), `prevAgents` (economics
   snapshot), `lastFired`, `posted[]`, `mentionCursor`, `spend{ day, credit }`, `seen` (token → first seen).
2. **Discover** (free): Orbio `agents?sort=newest&limit=200` + Pons `fetchActive({ pageSize: 200, age })` +
   `fetchGraduated()`. Tag `venue`: `orbio-agent` (in both), `pons`, (DEX listings out of scope v1).
3. **Select candidates**: launched ≤72h, mcap ≥ $5k, plus any token with a live Orbio-economics change. Hard cap
   ~25 profiles per tick (cost/time bound). First sight = seed only (no backlog blast — same rule as `detectEvents`).
4. **Profile**: `tokenDossier(address)` (or `computeIntel` with `whales:false` when only flags are needed). Attach
   `deployerReputation` for `owner`. Attach the Orbio record for agents.
5. **Detect**:
   - `detectEvents(prevBoard, tokens, { lastFired })` → `insider-dump`, `smart-convergence`, `clean-launch`.
   - `agentEvents(prevAgents, agents)` (new, pure):

     | kind | fires when | severity |
     |---|---|---|
     | `principal-withdrawn` | `stake.withdrawnWei` 0 → >0 (or grows ≥10%) | bad |
     | `cliff-24h` | `cliff.locked && unlocksAt - now ≤ 24h`, once | info |
     | `credit-idle` | agent ≥7d old, `converted.usdgAtoms` ≥ $500, `credit.activatedAtoms` = 0 — once per 7d | info |
     | `serial-owner` | new agent whose `owner` has ≥3 prior launches and 0 graduated (`deployerReputation`) | bad |
     | `first-harvest` | `stake.claimedFeesWei` 0 → >0 | info |

     Caveat to encode in copy: gateway *spending* is not public; `credit-idle` only reads $CREDIT claimed/activated.
6. **Gate** (`budget.mjs`): `social.accounts` (free) for remaining allowance; our caps: ≤15 originals/day, ≤3/hour,
   ≤40 replies/day, ≤1 post per token per 6h, daily spend ceiling `AGENT_MAX_CREDIT_PER_DAY` (default 1.50).
   Priority when over cap: `insider-dump` > `principal-withdrawn` > `serial-owner` > `smart-convergence` >
   `clean-launch` > info kinds.
7. **Format** (`format.mjs`, deterministic — no LLM writes numbers):
   ```
   ▼ $SYM — insiders selling
   3 early wallets started selling · 4.1% of supply moving · top10 38%
   $212k mcap · 5h old · Orbio agent
   block0.xyz/token?address=0x…
   On-chain facts, not advice.
   ```
   Unvalidated kinds (`smart-convergence`, `clean-launch`) replace the footer with
   `Not validated (forward test n=NN). Facts, not advice.` with NN read from the latest `REPORT.txt`.
   Lint every string before posting: reject if it contains any of
   `will|expect|likely|predict|target|probability|odds|buy|sell now|moon|gem|rug|scam|guaranteed` (word-boundary,
   case-insensitive). Numbers only about other people's projects — "6 prior launches, 0 graduated", never labels.
8. **Publish**: if `AGENT_DRY_RUN=1` append to `dry-run.jsonl` only. Else `social.post` with
   `{ platforms:["x"], text, max_cost:"0.02" }` → `social.post.status` → append `{ id, kind, address, text, url,
   at, credit }` to `posted.jsonl` (the public track record).
9. **Mentions**: `social.x.posts` mentions of `AGENT_X_HANDLE` since `mentionCursor` (limit 20, `max_cost` 0.005).
   Parse a `0x…40` address, else `$SYMBOL` resolved against Pons+Orbio lists (ambiguous → reply asking for the
   address). Build dossier → 2–3 line reply + link. Use the LLM **only** as a fallback parser for messy mentions
   (`max_tokens` 50, cheap model). Skip: our own posts, already-answered ids, accounts replying >3×/hour.
10. **Persist** state + ledgers, commit to `agent-data`.

**Weekly (Sunday) thread**: last 7 days of posts with 7-day outcomes (reuse `radar-log --outcomes` candle logic):
peak/close vs entry for every flagged token, misses shown, plus the current forward-test status line.
**Daily (optional) digest**: launches today, % passing clean bar, agents with cliff unlocking next 24h.

## 6. Cost model (per day, at 2026-10-01 prices)

| Item | Volume | Cost |
|---|---|---|
| X originals | ~15 × 0.0187 | ~$0.28 |
| Mention replies | ~20 × 0.0187 | ~$0.37 |
| Mention reads | ~100 pages-worth posts | ~$0.05 |
| `chain.read` fallback | rare | < $0.10 |
| LLM mention parsing | ~20 calls | ~$0.01 |
| **Total** | | **~$0.80/day ≈ $25/month** |

Break-even ≈ $55–60/month creator fees at the 45% conversion share (top-up from dashboard otherwise). Runtime:
Actions free (public repo) / Railway worker a few $/month.

## 7. Token + gating

Launch the agent's own token through the Orbio vault (see §9). Existing `/api/gate` (env `GATE_TOKEN`,
`GATE_THRESHOLD`, `GATE_SYMBOL`, `GATE_CHAIN_RPC`) already does a read-only `balanceOf` check — point `GATE_TOKEN` at
the new token. Utility = **timeliness, not returns**: holders get events in real time (web + Telegram), public X posts
go out with a delay (e.g. 15 min; see Reflex `backend/radar_delay.py` for the pattern). The agent posts its own
token's dossier under the same rules as everyone else's.

## 8. Tests (node --test, no network)

- `agentEvents`: seed-on-first-sight; each kind fires once on the transition and respects cooldown; `null` fields
  never fire.
- `format`: ≤280 chars; footer present; unvalidated kinds carry the "Not validated (n=…)" line; forbidden-word lint
  rejects; address links well-formed.
- `budget`: caps per hour/day, priority ordering when over cap, spend ceiling stops posting, UTC-day rollover.
- `mentions`: address extraction, `$SYM` resolution incl. ambiguity, self/duplicate skip.
- `orbio.mjs`: 401/402 handling (402 → stop posting for the day, log), `max_cost` always sent.
- Standby guard: running `agent-tick.mjs` does not flip `STANDBY` or call `refreshBoard`/`ensureFresh`
  (assert via injected stubs, same style as `test/standby.test.mjs`).

## 9. Rollout

1. Build with `AGENT_DRY_RUN=1`; run on Actions ≥3 days; review `dry-run.jsonl` (volume, wording, false events).
2. Create the X handle; owner connects it in Orbio dashboard → Tools & connections.
3. Launch via vault on chain 4663: pin `expectedEconomics` from `/terms`, set agent wallet in
   `launch(TokenParams, address)`, read the new ID from the `AgentLaunched` event (never `nextAgentId`).
   Principal locked 10 days. Get `ORBIO_API_KEY` from the dashboard → repo secret.
4. Flip `AGENT_DRY_RUN=0` with low caps (5 originals/day), raise after a week.
5. Publish the agent's own token dossier + the forward-test status on day one.

## 10. Open questions

- Handle/name (Block0 vs Lantern Labs umbrella).
- Actions cron lag acceptable? (events median ~3h old at detection anyway; insider-dump is the time-sensitive one.)
- `computeIntel` cost on the free node for ~25 tokens/tick within an Actions job timeout — measure in dry run; reduce
  candidate cap or use `whales:false` if slow.
- Whether Orbio lists third-party tools in its catalogue (would let other agents pay to call a Block0 dossier);
  otherwise expose `/api/token` behind x402 later.
- Does Orbio count our posts toward any platform-wide limits beyond the per-account caps? Check `social.accounts`.
