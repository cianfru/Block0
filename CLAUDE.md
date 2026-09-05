# Block0 — project notes

Block0 is a transparent, real-time "should I ape?" launch scanner for the **Robinhood Chain** (Uniswap-v4 based).
It verdicts every launch (Pons launchpad + direct DEX listings) on-chain — snipers, bundles, concentration, live
dumping — places it against a study of past winners, and shows the wallet intelligence behind it. Deploys on
**Railway** (auto-deploy from `main` of `github.com/cianfru/Block0`). Node, dependency-light (`node server.mjs`).

## ⭐⭐ NORTH STAR — MINIMUM COST. This is an EXPERIMENT, keep it as cheap as it can possibly be (owner, 2026-09-03)
- **The whole project must run at the lowest cost we can manage.** We're launching a token and *hoping* for traction
  — it might get none and just die. So every recurring cost has to be justified against "what if this never takes
  off." Default to the cheapest path that still works. When in doubt, cheaper.
- **⭐ ALCHEMY IS THE METERED RESOURCE — BE BUDGET-CONSCIOUS ON EVERY PULL.** We moved to Alchemy pay-as-you-go, but
  PAYG is not permission to spend. Yes, data has to go through Alchemy; yes, everything must work — but we do NOT
  overrun Alchemy just because the plan allows it. Rules, always:
  - **Prefer the native RH RPC (`https://rpc.mainnet.chain.robinhood.com`) — it's FREE.** It serves 10k-block
    `eth_getLogs` ranges (Alchemy free tier capped these at 10 blocks, which is why Alchemy exists here at all). Use
    the native node for wide log scans (DEX discovery, transfer history) and reserve Alchemy for what genuinely needs
    it (the enhanced `getAssetTransfers` — paged, hash-carrying, cross-wallet history).
  - **Cache anything immutable FOREVER.** A wallet's first funder, a token's deploy block, historical transfers —
    these never change. Pull once, cache in KV, never re-pull. (Funder cache = `funder:{addr}`, permanent.)
  - **Incremental, never full-pull on a schedule.** The transfer store pulls only new blocks since last seen. The
    backtest reuses the store's cached transfers instead of re-pulling. Any daily/periodic job pulls deltas only.
  - **Bound every fan-out.** Per-wallet lookups (funders, wallet intel) are capped to the top N (e.g. FUNDER_CAP=40),
    never "every holder." Heavy features are **opt-in** (a query flag), not on by default / not on every refresh.
  - **Debounce + cache results.** Backtests cache 30 min (KV `bt:*`); the leaderboard runs every 30 min reusing
    cached backtests; the graph reads the store. Don't recompute what a cache already holds.
  - **The lesson from the sister project (SPX/Dune): measure BOTH execution AND the result-read/egress cost.** A
    cheap call whose RESULT is large, pulled on a schedule, is not cheap. Go incremental.
- **Paying more for Alchemy is not the fix.** If something is too expensive, make it cheaper (native RPC, cache,
  bound, opt-in, incremental) — don't raise the ceiling to spend through.

## Architecture (the cheap-by-design data flow)
- **Discovery:** Pons API (launchpad, source of truth for mcap/logo/graduation) + native-RPC topic-filtered
  `eth_getLogs` for Uniswap-v4 `Initialize` events (direct DEX listings). Tokenized stocks + infra/wrapper tokens
  are excluded (`isTokenizedStock`, `INFRA` set in dex.mjs).
- **Forensic verdict (`intel.mjs` `computeIntel`):** one transfer-replay pass → snipers / bundles / concentration /
  live dumping / risk / momentum. Same `computeRisk` the board and the historical backtest share.
- **Incremental transfer store (`store.mjs`):** per-token cached transfers, pulls only new blocks. The backtest and
  graph reuse it instead of re-pulling.
- **Board (`board.mjs`):** Pons cooking + graduated verdicts on one interval; **DEX discovery on its own interval**
  (decoupled so slow Alchemy verdicts never stall the core board). Publishes incrementally per verdict. Tags each
  token with explicit `section` (cooking|graduated|dex) + `venue` (pons|uniswap-v4).
- **Backtest (`backtest.mjs`):** replays a token's history → forensic score trajectory + swap-implied price (one
  representative swap per bucket, ~45 receipt calls, cached). Also per-wallet **PnL** (see below).
- **Winner model (`model.json` + `study/*.json`):** built offline by `tools/build-cohort.mjs` → corridor →
  projection → gen-model → validate. RPC-heavy, so it runs in the **`rebuild-model.yml` GitHub Action** (needs the
  `ALCHEMY_RPC_URL` **repo secret** — separate from Railway env), NOT in the app. Includes direct DEX listings via `--dex`.
  - **⭐ OUTCOME-LABELLED COHORT (owner call 2026-09-05: "graduation shouldn't be the only condition but a sustainable path
    to multi-million valuations").** `outcome.mjs` `classifyOutcome(series, {now, t0, curMcap, curHolders})` labels EVERY
    token (Pons or DEX) under ONE rule — graduation is NOT a criterion: **major** (held-peak ≥$5M, ≥$1M for 14d) · **runner**
    (held-peak ≥$1M, ≥$1M for 7 consecutive days) — both need holders ≥70% of peak and still ≥25% of the held-peak (a week-long
    pump that then went to zero is `faded`, flagged `wasRunner`) · **pending** (too young to have held/failed — right-censored,
    excluded) · **mid** (reached $300k, alive, undecided — excluded) · **faded** (reached $300k, now <25% of held-peak — the
    PRIMARY control) · **stalled** / **dead**. "Held-peak" = highest cap held a full day (reconstructed caps wick on single
    swaps; `heldPeakH`). Knobs = `RULES`; `definitions()` publishes the text so page + code can't drift. PONS/USDC/USDG
    excluded (`EXCLUDE_TOKENS`). Unit-tested (`test/outcome.test.mjs`).
  - **⭐ INCREMENTAL + BUDGETED cohort (`tools/build-cohort.mjs` + `tools/cohort-lib.mjs`).** Every backtest is cached as a
    SLIM profile at `study/profiles/<addr>.json` (COMMITTED); `study/cohort.json` = the index (every profiled token + label
    + per-tier counts + rules). A cached token is re-labelled with the launchpad's LIVE mcap for $0; re-backtested only when
    pending/mid (12h), printing new highs, or a young winner whose corridor path is still growing (<30d old, 48h). Queue is
    highest-value first (live ≥$300k → graduated ≥$50k → open labels → controls ≤300 → DEX), `--budgetMin` (default 120)
    stops cleanly and the NEXT run continues — so the first full build converges over a few runs, then a run is minutes.
    Stops on 8 consecutive failures (RPC down); `study/skips.json` remembers failures for 7d. `--dry` prints the queue.
    Downstream (`corridor`/`projection`/`extract_blueprint`/`validate`) read ONLY `loadCohort()` — winners = runner+major,
    controls = faded/stalled/dead. **`gen-model.mjs` refuses to overwrite `model.json` below 10 winners** (`--force`), so a
    thin early cohort can't degrade the live model; `model.json.cohort` states the basis (counts/rules/definitions/winners).
  - **Validation (`validate.mjs` → `study/validation.json`):** per-bin AUC vs ALL controls AND vs FADED only (the hard test),
    leave-one-out winner catch, `falsePosFaded`, plus a **TIME SPLIT** (band fitted on winners launched before a cutoff that
    leaves the latest 30% as test; graded on later winners + controls only; `ready:false` + reason when the slice <5).
    `cohort.winners/losers` kept for the landing + cards readers. Methodology page renders the tier table + counts + split.
  - **The sandbox CAN run backtests on the native RH node** (verified 2026-09-05: 3 young tokens in 7.5 min; heavy fresh
    tokens carry 150k–490k transfers, ~1–2.5 min each; use `LOGS_GAP_MS=300` — bursts draw 429s, now backed off in
    `rpc.mjs`/`getTransferLogs`). The scheduled build runs in the Action (Mon+Thu 06:17 UTC, or dispatch) on Alchemy.
    Pipeline is regression-tested on a SYNTHETIC cohort (`test/pipeline.test.mjs`) end-to-end; `--only=0x…` profiles
    specific tokens; `STUDY_DIR=` redirects everything (smoke into a scratch dir, never the committed study).
    The old `profiles/ winners_full/ losers/` dirs are gone.
  - **⚠⚠ BUG FOUND BY THE SMOKE (2026-09-05): the native node returns `blockTimestamp: "0x0"` on eth_getLogs.** Both log
    readers treated a truthy "0x0" as a real timestamp → ts=0 → the generic backtest dropped EVERY transfer ("too few
    timestamped transfers") and the live engine's 30-min windows were meaningless on that provider. Fixed: `backtest.mjs` +
    `engine.mjs` treat a zero timestamp as ABSENT, and `store.mjs` `fillTimestamps()` derives missing times from the
    block calibration for the live intel path. **RULE: never trust a log's blockTimestamp without `> 0`.**

## Feature engines (all pure + unit-tested; `npm test`)
- **PnL (`pnl.mjs`):** avg-cost realized (coins sold) + unrealized (coins held) per wallet, from the backtest's
  price series. Conservative — untracked-cost coins credit ZERO profit (understates, never invents). On
  `/api/backtest` as `pnl[]` + `pnlStats`. Powers "is this wallet up or down."
- **Leaderboard (`leaderboard.mjs`):** aggregates per-token PnL across graduated + DEX winners → proven positive-PnL
  wallets to follow. `/api/leaderboard`, KV-cached, refreshed every 30 min reusing cached backtests.
- **Bubble map (`graph.mjs`):** wallet-relationship graph per token from its OWN transfers (no extra RPC). Nodes
  (holders, role bundle/sniper/holder), edges (bundle = same-block first buy; transfer = token moved wallet↔wallet),
  clusters (connected components, `flag`ged when bundle-y). Per-node + per-cluster **flow** (green buy / red sell
  over ~24h) so a coordinated cohort lights up if it's distributing. `/api/graph`.
  - **Funder layer (`funders.mjs`, opt-in `?funders=1`, TOP 40 ONLY):** the deeper Bubblemaps signal — wallets
    funded from the same source. Budget-guarded: one `getAssetTransfers` per top wallet, **cached permanently**
    (funder is immutable), fan-out guard drops exchange-like common funders. Never on by default.
- **Wallet intel (`wallet.mjs`):** cross-token footprint for any wallet (held vs exited, flipper vs holder),
  `getAssetTransfers` two directions, capped, cached 15 min. `/api/wallet`.
- **Wallet PnL report (`wallet-pnl.mjs`):** one wallet's reconstructed PnL across the winner set, reusing the cached
  backtests the leaderboard warms (reconciles to the cent). `/api/wallet-pnl?a=`; per-token orbs via `/api/wallet-trades`.
  - **SPEED (3 layers, all shipped):** (1) in-process backtest memo (`_btMem` in server.mjs) so a warm report is memory
    reads, not ~100 Redis GETs; (2) `walletPnlReport` fetches per-token backtests with a bounded worker pool (parallel,
    not sequential); (3) **token PRE-FILTER** — `walletTokenSet(addr)` (wallet.mjs, one `getAssetTransfers` pair) lists
    the tokens the wallet actually touched, so the endpoint only backtests the intersection with the winner set (~a
    handful, not 100). Falls back to the full set if the lookup fails, so results never shrink; `tokensRequested` still
    reports the whole universe. This is what makes a COLD wallet report fast.
- **⭐⭐ WINNER/PnL RECONSTRUCTION — WHY IT WAS SLOW + THE CONVERGENCE FIX (measured live 2026-09-05).** Per-token
  backtest = a full `getLogs` walk of the token's history on the native RH RPC ≈ **30–60s each** (older/bigger winners
  slowest). The leaderboard warms ~15 tokens per 12-min cycle. With `BT_TTL`=45m the early results EXPIRED before
  coverage finished — a treadmill that never reached warm, so every page hit cold tokens ("cannot wait forever").
  Measured: `partial:true, tokensScanned 15/34`. **Fixes:** (1) **`BT_TTL` 45m→6h** so results ACCUMULATE across
  cycles — after ~3 cycles (~90 min from first deploy) every winner is warm and stays warm (Redis survives redeploys);
  steady state = pure cache reads, leaderboard + wallet pages instant. (2) **`winnerTokens()` snapshots the last
  COMPLETE board scan** — it was reading the board's partial mid-scan lists (31 tokens one minute, 8 the next) →
  churning cache keys + a false "traded nothing". (3) **Pre-filter gated to `PROVIDER==="alchemy"`** — the native node
  doesn't serve getAssetTransfers (junk → false negatives); an empty intersection now falls back to the full scan.
  (4) **Wallet PnL 8s deadline** (`WALLET_PNL_DEADLINE_MS`): a cold scan returns a fast PARTIAL flagged `computing`
  (page polls every 20s) instead of blocking ~48s; in-flight backtests keep running and warm the memo. (5) **Never
  cache a partial-empty report.** ⚠ The one unavoidable cost is the FIRST warm-up after a cold cache (~90 min) — during
  it pages show honest "reconstructing…" progress, not a hang. ⚠ Unrealised PnL can be up to 6h stale (pages say
  "rough"). If ever needed: persisting per-token transfer events would make even first-ever computes incremental, but
  ~2.5MB/token is too big for the free Redis tier — result-caching is the cost-correct choice.
- **Trajectory honesty — SHAPE vs ADOPTION must agree (`model.mjs corridorStatus`, fixed 2026-09).** The trajectory
  SCORE (`liveTrajectory`) saturates on any clean young launch: `inflow = holders/ageH` explodes at low ages and pins
  the arrival-rate term at its cap, so a fresh clean token scores ~84 and plots ABOVE the winner cone (57–70) even
  when its wallets/mcap are a FRACTION of the winners' gate — the "numbers don't match" bug (score said on-track while
  `path.pos` said lagging). Fix: `corridorStatus(ageH, traj, {wallets, mcap})` now also reads ADOPTION vs the bin's
  `twLo`/`tm`; a clean shape over a below-floor float (< twLo·0.5 wallets or < tm·0.25 mcap) returns `status:
  "adoption-behind"` (with `shape`+`adoption` sub-reads), not "on-track". Callers (board/dossier/alerts) pass
  wallets+mcap; the token-page corridor chart (`index.html corStatus`) has the same gate → a "lagging" (amber) line +
  "CLEAN SHAPE · ADOPTION LAGGING" verdict. The concrete numbers govern the headline. ⚠ The score axis itself is
  unchanged (would need a `tools/corridor.mjs` formula change + local model regen via `study/` — feasible, not done).
- **Contract filter (`rpc.isContract`, `eth_getCode`, cached forever, fails open):** keeps bots/routers/pools off the
  leaderboard ("follow the smart money" = humans); count reported openly on the page.
- **Post desk (`cards.mjs`):** turns live numbers into postable cards (eyebrow/hero/summary/tweet/viz), each built
  defensively (omit, never fake). `/api/cards` (CONTROL_PASSWORD-gated). Rendered client-side onto a 1080² canvas by
  `public/desk-cards.js` (shared by `/desk` + `/post`).
- **Social manager (`social.mjs`):** pure `{queue, log}` reducer (queue/move/posted/unpost/logRemove + cadence),
  persisted in KV. `/api/social` (gated). Powers `/post` — build → queue → mark posted → log. Nothing auto-posts.
- **Most promising by price bracket (`picks.mjs` + `llm.mjs`):** groups the board into market-cap BRACKETS
  (`BRACKETS`: fresh <$500k · $500k–$1M · $1M–$5M · $5M–$10M · $10M+) and surfaces the launch in each whose on-chain
  fingerprint looks most like a real one. **`picks.mjs` is pure + tested:** `promiseScore` (interpretable: blueprint
  fit + clean risk + adoption + momentum + smart-money − sniper/bundle/insider) pre-ranks candidates and IS the
  no-LLM fallback; `validatePick` hard-enforces the honesty rail — the model may only pick one of OUR candidates,
  the reason must cite a real on-chain signal, and any buy/price/moon language is rejected. **`llm.mjs`** is the one
  LLM touchpoint: OpenRouter, free-model-first (`resolveModels` discovers live `:free` models each ~10 min, seeds +
  fallback chain, pin via `OPENROUTER_MODEL`/`OPENROUTER_MODELS`), soft-fails on no-key/429/dead → deterministic
  picks. `/api/picks` (memory + KV cached, background refresh every `PICKS_REFRESH_MS`=15m, ONE call/bracket ≤5).
  Board tab **◆ Most promising**. LLM does LANGUAGE ONLY over facts we computed — never invents a token or number.
  ⚠ COST: free models only; if the free key is unset the feature still works (deterministic). Keep it 1 call/bracket.
- **⭐ PRODUCTION HARDENING + TRADER FEATURES (owner: "build both, make it ready, deviate as per your analysis" — 2026-09-05).**
  - **Abuse guards (`ratelimit.mjs`, pure+tested; wired in server before routing):** per-IP token buckets — HEAVY endpoints
    (backtest/scan/graph/wallet/wallet-pnl/wallet-trades/token, each triggers RPC work) ~20/min, LIGHT (cached reads) ~120/min
    → 429 + Retry-After; a global cap of 6 concurrent heavy handlers → fast 503 "busy" (never pile onto the free RPC);
    identical concurrent backtests + dossier builds COALESCE into one compute. Knobs: `RL_HEAVY_BURST/PER_SEC`, `RL_LIGHT_*`,
    `RL_HEAVY_CONCURRENCY`. Static files untouched. **This was the one blocker for a public link.**
  - **Alerts as THE product (`alert-events.mjs`, pure+tested):** detects TRANSITIONS over the board's own verdicts each
    cycle (zero extra RPC): insiders START selling (0→≥1) · smart money REACHES ≥2 · a fresh launch clears the clean bar.
    Per-token/per-kind 6h cooldown; cold start SEEDS full state (incl. clean) so it can never blast a backlog. State +
    feed persisted in KV; `/api/alerts/feed` public; Telegram push when the bot is set; board "⚡ Live alerts" strip polls
    it (new-count, `TELEGRAM_PUBLIC_LINK` CTA). `alerts.mjs` exports `sendTelegram`/`PUBLIC_URL`.
  - **Public forward track record (`/track-record`):** every forward call listed newest-first with outcome — misses
    flagged openly (promising→faded, avoid→won). Rates ONLY over the matured cohort (`track-record.mjs report()`
    maturity fix); early winners shown in cyan but never counted; "accruing" state until ≥MIN_SHOW matured. Endpoint
    `/api/track-record?calls=N` (`callsList/trackCalls`). Linked from landing caveat + methodology nav + footer.
  - **Serial-operator signal (`deployer.mjs`, pure+tested, shared by board card + dossier):** `deployerReputation(all,
    meta)` from the launchpad's own `deployer` field (NO RPC — note `deployerOf` in intel.mjs needs Alchemy and is
    unused here): launched / graduated / **faded** (prior launch not graduated & mcap < $5k) / reputation
    (proven|serial|repeat|first). Board attaches `r.deployerRep` (compact) from `ALL_META` (the full launchpad list
    captured each refresh); card shows a `.serialflag` — red when priors faded with none graduated, lime when a prior
    graduated. Dossier's existing `deployerCard` now reads the same function.
  - **Picks:** retries in 60s when the board is still empty at refresh (was a full 15-min wait).
  - ⚠ STILL OWNER-SIDE: `EXPLORER_URL` (click-through addresses), `RPC_WS` (true push tail), `TELEGRAM_PUBLIC_LINK`.
- **KV (`store/kv.mjs`):** 3 backends auto-selected (Upstash REST > native `redis://` TCP `store/redis-tcp.mjs` > file).
  `kvPing()` reports backend/connected honestly. Redis is live in prod.

## Front end
- **ONE repo, no parallel app** — hand-written `public/*.html` (+ shared `public/block0-cards.js` renderer + `block0.css`).
  Terminal aesthetic: near-black `#08080b`, lime `#c8ff4d` accent, cyan/magenta/coral signal colours, Instrument Serif
  display + Inter body + mono data.
- **Pages:** `/` landing · `/board` grid · `/token` dossier · `/leaderboard` proven wallets · `/wallet` per-wallet PnL ·
  `/methodology` · owner-only `/control` (forensics) · `/desk` (daily post cards) · `/post` (social manager).
- **⭐ LANDING = SHOW THE PRODUCT, not the philosophy (owner, 2026-09; big redesign).** Killed the abstract scroll-tunnel
  and the "we're honest" sermon. Hero is a LIVE verdict card (real graded token: risk dial + flags), left is one line
  ("Don't ape blind.") + a scan box that produces a **free verdict right on the landing** (fetch `/api/token`, render the
  card) with "See the full dossier →" bridging to the gated depth. Then: the **winner-corridor** lateral-profile canvas
  animation (price line threading stage gates → WINNER, losers fall out), concrete **signal tiles** (icon chips, not
  prose), a 3-number **proof band**, and a short access section. Honesty is demonstrated (real numbers, one "signal, not
  proof" line), never preached.
- **⭐ WALLETS = OUR OWN PnL PAGE, NO THIRD PARTY (Zerion KILLED 2026-09).** Zerion/DeBank don't index the Robinhood Chain
  ("unsupported address"), so every wallet everywhere (leaderboard, dossier rows, smart-money, bubble map) links to
  **`/wallet?a=<addr>`** — our reconstruction (`wallet-pnl.mjs`: per-token realized/unrealized across the winner set,
  reusing cached backtests; a lazy per-token "where it bought & sold" orbs chart via `walletTrades`). The chain block
  explorer (`EXPLORER_URL`) is the only external link, as a secondary. `r.links = {explorer}` on `/api/token`+`/api/graph`.
- **⭐ BUBBLE MAP (dossier) — 3D + drag + click-to-open-bundle (2026-09).** Nodes are shaded spheres (depth); a continuous
  self-settling force sim makes them **drag-able** (bubblemap-style); **click a bubble → focuses its bundle** (dims the
  rest, lights the cluster ring, panel lists member wallets → each links to its `/wallet` PnL). Hover tips; drag vs click
  by movement. All in `public/index.html` (canvas, no deps).
- **⭐ BUNDLES FLAGGED HARD.** Any token card (board + landing preview + hero verdict) shows a loud coral "⚠ N bundles
  detected" banner + red edge when `flags.bundles>0`.
- **Design source:** the owner may sketch in Lovable; port the good bits into `public/*.html`. Lovable binds to the live
  `/api/*` via the README data contract (CORS open).

## Conventions
- Feature engines are **pure + injectable + unit-tested** (pnl/leaderboard/graph/funders/cards/social/wallet-pnl). Endpoints
  wire them to data. Keep new engines the same way. `npm test` — 55 tests, keep it green before every push.
- Commit to `main` → Railway deploys. Use `[skip ci]`-style discipline only if a deploy-cost cap ever appears.
- `.env.example` documents every knob. New cost-affecting behaviour gets an env flag + a sensible cheap default.
- **⭐ SECURITY — escape all on-chain strings.** Token symbols/names are attacker-controlled (permissionless launchpad),
  so ANY on-chain string rendered via innerHTML MUST go through `B0.esc()` (shared in block0-cards.js). This bit us once
  (XSS via a crafted symbol on the public board) — fixed 2026-09; don't reintroduce it. Gated endpoints check
  `CONTROL_PASSWORD` and fail closed. Auth is password-in-body (not cookies) → CSRF-safe even with `CORS *`.
- **⭐ THE TOKEN GATE IS A CURTAIN, NOT A WALL (important).** `block0-gate.js` is a client-side localStorage flag + a
  read-only balance check; the `/api/*` data endpoints are PUBLIC and do not enforce it. Fine for the open/experiment
  launch (data is public chain data anyway, and the free-verdict/gated-depth split is a UX promise). If the business ever
  needs REAL gating, the deep feeds must move behind a server-side authed endpoint — that's a separate project.

## Tokenomics — token-gated access (owner decided 2026-09)
- **Access = holding a FIXED NUMBER OF TOKENS, not a dollar value.** Rationale (owner): a dollar-pegged threshold
  makes the required token count fall as price rises, so members hold excess above the bar and have a standing
  incentive to sell the surplus → sell pressure. A fixed token count means a member must hold exactly N to keep
  access — no excess to trim — and the market sets the price freely. Less sell pressure, simpler, honest.
- The gate (`/api/gate`, `block0-gate.js`) already works on a fixed token count: `GATE_THRESHOLD` = whole tokens.
- Sizing guide (for choosing N): access cost in $ = (N / supply) × mcap. So N as a % of supply fixes the $-cost at
  any given mcap. Pick N for the mcap where the TYPICAL member is expected to join, not the aspirational top.
  Example: N = 0.001% of supply → ~$100 access at $10M mcap (~$10 at $1M, ~$1,000 at $100M). Consider a cheaper
  founding-member bar for the first ~100–200 holders as an early growth lever.

## Shipped 2026-09 (this build cycle)
- **✅ Control/forensics `/control`** (audience geo, coverage, convergence, ops health) + **`/desk`** (daily post cards)
  + **`/post`** (social manager: queue/log, KV-persisted). All CONTROL_PASSWORD-gated.
- **✅ `/wallet` per-wallet PnL page** + Zerion removed everywhere (our reconstruction only).
- **✅ Landing rebuilt** (product-first hero, free-verdict scan, winner-corridor animation, signal chips, proof band).
- **✅ Bubble map** 3D + drag + click-to-open-bundle; **heavy bundle flag** on cards; **contract/bot filter** on the board.
- **✅ Redis** (native TCP) live for persistence. **✅ XSS hardening** (esc all on-chain strings).

## Roadmap / owner asks (open)
- **🔲 PRODUCTION SWITCH-ON (owner):** decide open vs token-gated launch; if gated, deploy the BLOCK0 token + set
  `GATE_TOKEN`/`GATE_THRESHOLD`/`GATE_SYMBOL`/`GATE_DECIMALS`/`GATE_BUY_URL`. Set `EXPLORER_URL`, `PUBLIC_URL` + domain,
  fill `/terms`. Confirm `CONTROL_PASSWORD` + `REDIS_URL` (both set). Optional Telegram alert vars.
- **🔲 REAL gating (only if the model needs it):** move the deep feeds behind a server-side authed endpoint (today the
  gate is a curtain — see Conventions).
- **🔲 Light per-IP rate limit** on the heavy public endpoints (`/api/token`, `/api/wallet-pnl`) before heavy promotion —
  they trigger on-chain reconstruction (cached, but a distinct-address spray costs RPC).
- **🔲 Still flagged:** mobile hamburger nav (most traffic is mobile-from-X), OG images + favicon, out-of-sample model
  tracking as the cohort grows, scroll-linked replay of the corridor animation.
