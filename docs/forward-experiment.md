# Forward experiment v1

This is the first implementation of the measurement and setup proposal. It starts collecting after deployment, independently of the board ranking. It does not establish a trading edge or integrate Reflex.

## Running and inspecting

Run the existing `node server.mjs` process. The collector starts automatically unless `EXPERIMENT_ON=0`. Use one collector replica. Redis is recommended; the default file backend requires a persistent `DATA_DIR` volume. Experiment values live in separate files under `DATA_DIR/experiment`, each replaced with an atomic rename. This protects individual values from partial writes; it is not a multi-key transaction, an fsync durability guarantee, or a multi-process lock. The legacy debounced KV document is separate. Do not run concurrent writers against the same file or experiment namespace.

- `/setups`: experimental lifecycle, reasons, data quality and transition history.
- `/api/setups?state=building&n=100`: cached discovery/observation summary; optional exact `address` filter. Responses are limited to 200 rows and report matching total.
- `/track-record` and `/api/track-record?calls=200`: new forward decisions and indicative fixed-horizon outcomes.
- `/api/track-record/legacy`: preserved old KV record with an explicit legacy warning. It is no longer fed new board calls and is never combined with v2.

The experiment is open, read-only and separate from the existing token overlay. No orders or outbound messages are sent. Existing legacy alerts are unchanged; new setup transitions appear in the setup timeline rather than being pushed to Telegram as alpha claims.

## Scope and limits

Discovery polls Pons active page 1 sorted newest, rotates one older active page, and reads the graduation catalog. It registers zero-price and ungraduated tokens as well as successes. Registry membership is not conditioned on the board's market-cap ranking. It is **not an on-chain factory-event index**: upstream filtering, rapid offset-page churn and missing/delisted launches can leave gaps. `coverage.complete` is always false for this source. Source errors, registry-cap omissions and queued observation work are reported explicitly.

At most 5,000 addresses are retained by default, with no silent eviction. Raise the cap only after reviewing costs and coverage. Young tokens and pending decision outcomes get sampling priority, then least-recently-sampled tokens. Default budget: 80 observations per cycle, one-minute cadence for tokens younger than 24h or pending outcomes, 15-minute cadence for others. The delay between cycles begins after completion; network time adds to it. Immutable observation values are retained in a rolling 2,048-row window per token; dropped rows are counted. Export before that window is exhausted if longer replay history is needed. Decisions remain in the token record.

Forensics reuse original timestamped board reads, with a ten-minute maximum age. This is still a selected enrichment subset: registry breadth does not imply full forensic coverage. No new Alchemy reconstruction is introduced. Up to four keyless DexScreener pair requests per cycle provide liquidity for tokens with current forensic reads. Missing enrichment cannot trigger a setup. Budget starvation and stale reads can reduce the assessed universe; inspect these before interpreting experiment results. The eligible universe is budget-determined, not a representative sample of the registry. `coverage.eligibleTokens` counts distinct tokens ever observed with `features.ready`, persists across deterioration/restarts, and accompanies each strategy summary and the UI's registered-token denominator. This is cumulative evidence eligibility, not a count of currently actionable tokens. Migrated older indices expose `eligibilityLowerBound: true`, because historical readiness was not tracked.

All times are Unix milliseconds. `observedAt` is acquisition time; `catalogReceivedAt` is the catalog response time. `eventAt` is the last-buy time supplied by Pons, if available, **not** the quote timestamp. Source price-as-of time is unknown. Catalog prices are indicative, never certified executable. The forward pipeline has no import from the historical backtest or study artifacts.

## Frozen hypothesis

`forward-features-v1` computes only from observations available by the decision time. It requires six or more priced observations spanning 30 minutes, sufficiently recent comparable forensic samples, known liquidity and no gaps over 15 minutes in the retained 24h feature window. Repeating a cached forensic read cannot invent holder growth. Thresholds are fixed in `setups.mjs`, not fitted to historical winners:

- Risk no higher than 45; observed liquidity at least $10,000; no currently flagged early-wallet sellers.
- Holder growth at least 2% against the prior sample near 15 minutes earlier. Wallet independence is unverified.
- Price rise at least 3% against that time reference, a 10–50% observed pullback from the prior peak, and at least 3% recovery from the recent trough.

States: observing, building, triggered, deteriorating, invalidated, expired. A triggered episode expires after six hours. Invalidation/expiry is terminal for that token and strategy version. Unknown/stale evidence cannot produce a fresh trigger; stale rows display unavailable even if the last recorded state was triggered. There is one frozen decision per token/version. To evaluate a changed rule, bump the version and use a new experiment namespace rather than reinterpret old observations or mix definitions.

This is a simple participation-and-pullback hypothesis, not an independent-wallet or Reflex regime model. The existing winner corridor remains descriptive historical context. Production structural picks now ignore LLM selection/explanations and render deterministic facts.

## Outcomes

Policy `indicative-6h-v1`:

1. Entry: first positive observed price from one minute after the decision, no later than ten minutes after that target.
2. Exit: first positive observed price six hours after the actual entry observation, within ten minutes.
3. Missing entry/exit: unknown once its tolerance ends, never a confirmed loss or historical-peak fallback.
4. Cost scenario: exit price times 0.99, divided by entry price times 1.01, minus one.

Graduation and a $1M valuation are not success criteria. A post-decision decline remains negative even if the token was already graduated. Sampling gaps suppress the adverse-move and opportunity-peak fields; even complete sampled paths cannot reveal every intraperiod move. The cost scenario excludes gas, slippage, price impact, sellability and actual fills; it is not realized PnL. `ready:false` prevents legacy marketing widgets from treating these descriptive returns as a demonstrated win rate.

## Export and comparison

Run on the collector host with the same Redis/DATA_DIR configuration:

```sh
node tools/export-forward.mjs > forward-export.json
node tools/replay-forward.mjs forward-export.json > forward-comparison.json
```

The comparison uses only these saved observations. It advances the same feature/state functions through real observation times, then samples common six-hour checkpoints with at least three eligible tokens. Each strategy may select one token: momentum, structure plus momentum, the setup state, and twenty reproducible random seeds. Abstentions and the candidate addresses at each checkpoint are saved. Selection follows a shared eligibility filter, including forensic/liquidity coverage; this is not a baseline for the entire launch population.

This checkpoint portfolio experiment is distinct from the live transition-alert record. It can repeat a token at later checkpoints. Output explicitly avoids significance claims: overlapping market exposure and repeated tokens are dependent. It does not implement a train/test optimizer, confidence intervals, causal execution simulator, wallet-independent flow model or Reflex adapter. Those require further work and adequate data.

## Verification and rollout

`npm test` includes causality, frozen decisions, stale/missing data, fixed-horizon outcomes, persistence failure, restart, discovery bounds, deterministic selection and HTTP route tests. HTTP tests use an isolated temporary store with `BACKGROUND_ON=0`, preventing live provider calls. Browser checks cover empty and synthetic populated states, filtering, literal hostile token text, timeline expansion and mobile width.

After deploying, check `/api/setups`: `enabled`, `updated`, `error`, source failures, queued work, observed rows and known forensic/liquidity coverage. The record should start empty and accrue only actual triggers. A successful deployment is not proof that the upstream catalog schema or coverage remains suitable; schema failures are reported, not interpreted as empty discovery.

Rollback: set `EXPERIMENT_ON=0` to pause the collector and preserve its KV namespace. Never feed v2 observations into the old archive. Avoid rolling back the entire app to a build that resumes legacy tracking unless that behavior is explicitly intended.

Next engineering decisions: verify upstream discovery coverage against factory events; improve fair forensic sampling within the existing RPC budget; retain an append-only export beyond the rolling window; add transaction/quote-based execution checks; inspect Reflex and compare its timing independently. Customer recruitment and forward statistical validation occur after this deployment and cannot be completed by a code change.

## Storage and response bounds

The registry stores only identity, scheduling cursors, state/timestamp pointers and cumulative eligibility flags. Observations, features, decisions and transition histories remain in per-token records. Small per-token call values serve the track record without loading observation histories. Setup requests filter/sort the compact registry before reading at most 200 records; track-record summaries read call values only and their cost grows with the number of tokens with decisions.

The collector still persists its compact index twice per cycle. On the file backend, each token write serializes only that token value, rather than the combined database; legacy soft flushes cannot overwrite the new experiment files. Retaining 2,048 observations for 5,000 tokens can still require several gigabytes of disk/Redis capacity. These changes bound write amplification, not total retained storage. Budget for capacity and monitor errors; collection failure is exposed through the API/UI.

Original monolithic experiment values have a read-only fallback. New writes use separate files. The old monolithic file is not automatically deleted or compacted; deployments that already accumulated large histories should archive it and migrate retained values before relying on the file backend. Mirrored index call payloads are migrated into call values before being removed from the in-memory index, and the next successful cycle persists the compact index.

## Collector v2: stable follow-up (September 8)

The production stall occurred because absent registry members exhausted the sampling budget while discovery pages moved on. `tracked-cohort-v2` filters available work before applying the observation budget; missing pending decisions are maintained separately so they still become unknown on deadline.

The runtime reserves eight cohort slots by default (`EXPERIMENT_COHORT_SIZE`, capped by the observation budget). Admission waits for fresh board forensics, prioritizes pre-graduation tokens, and uses address order for ties. The cohort is held for six hours, survives restarts and discovery-page changes, and keeps pending decisions until evaluation finishes. A token cannot be re-admitted within 24 hours. This is explicitly a selected, budget-conditioned cohort, not a random sample or a token quality ranking.

Pons' own `/api/pons-launches/live-markets` endpoint refreshes cohort prices using token/pool identity, in batches of at most 20. Cached board metadata is used only for admission identity; it is never republished as a fresh price. Failed/missing tracked quotes do not fall back to old catalog prices. Prices remain indicative and their underlying quote timestamps are unverified.

Liquidity calls prioritize the cohort and rotate by last attempt. Previously fetched liquidity retains its original receipt time and expires under the existing five-minute freshness rule. Eight slots permit two rounds with the default four-request budget; source delays can still reduce eligibility. No extra Alchemy reads are introduced.

When the registry is full, admission can retire absent discoveries that have no decision, no past eligibility and no active lease. Their metadata is archived in address-prefix shards before removal, and their per-token histories remain unchanged. Exports include archival addresses. Eligible tokens, decisions and active cohort members are protected. If all registry entries are protected, admission remains capped and omissions stay visible. Archived storage still needs capacity planning; it is not garbage-collected.

Coverage now includes collector version, cohort size/capacity, tracked refreshes, missing follow-ups, available tokens and retired registry entries. `dueRemaining` counts available observation work waiting for budget, not absent addresses. A zero-eligible result can still reflect missing forensics/liquidity or insufficient history; recovered collection is not proof of alpha.

## Evidence pilot v3 (September 9)

The default cohort is four tokens, with two slots per launch stage. Existing leases and pending evaluations are honored during rollout, so the count can temporarily exceed four. Admission still requires a recent forensic read. The board reserves slots for the entire tracked cohort before selecting discovery rows; total scans remain capped at BOARD_ACTIVE + BOARD_GRAD. A discovery endpoint failure can reuse cached identities to select scans, but only a successful new verdict advances its forensic timestamp.

Observations/features are versioned v2; new decisions use `pullback-participation-postgrad-v2`. Historical decisions remain unchanged and retain their original strategy identifiers. Pre-graduation tokens are research-only, even if DexScreener reports a pool for the address. Pons live-market fields `pairedPrincipalEth` and `graduationThresholdEth` are recorded as reported, with no USD conversion or inference of executable liquidity. In the September 9 sample, these fields were null for all four queried pre-graduation tokens. No verified sell-size quote was available in that response. Curve principal is neither DEX liquidity nor proof that a sale can execute. The existing $10,000 threshold applies only to post-graduation DEX assessment; it has not been lowered.

Coverage reports fresh prices, fresh forensic evidence, usable post-graduation liquidity, sufficient price history, assessment readiness, and matching setup conditions, plus per-token missing reasons. Pre/post-graduation counts prevent reading unavailable curve evidence as a failed DEX measurement.

A persisted 24-hour `validation` window begins on the first completed v3 cycle. Expected token slots accrue in wall-clock time while their tracking lease is active; missing cycles and restarts do not disappear from the denominator. At most one observation counts per slot, with no backfilling. The report freezes after 24 hours. `observationRate` has a 95% target; `forensicFreshnessRate` reports the share of recorded observations within the ten-minute forensic limit. Liquidity coverage is reported separately by launch stage. Completion is not a pass verdict: both rates and stage coverage must be reviewed. The timer subtracts cycle duration from the configured interval rather than adding a full interval after every cycle. Failed persistence is still surfaced as an error.

This validates collection, not alpha. Predictive baselines and rule tuning remain deferred until evidence coverage is sufficient. Do not interpret elapsed validation time as proof of uninterrupted storage health; errors and source failures remain relevant.
