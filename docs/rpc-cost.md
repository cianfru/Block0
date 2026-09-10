# What the chain reads cost, and why they are now zero

## What happened

Alchemy billed **111,112,268 compute units for 3–10 September 2026 — $50.00**, about 15.9M CU/day, on a project
that has not yet produced a validated result. Nothing was misconfigured in the sense of a typo. The service
simply ran four RPC loops continuously plus a nightly batch job, and every one of them routed to a metered
endpoint because `RPC_URL` pointed at one.

Estimated daily split, from reading the loops:

| Source | Rate | Est. CU/day |
| --- | --- | --- |
| DEX discovery verdicts | 24 tokens × 288 refreshes | ~5.2M |
| Board verdicts | 40 tokens × 480 refreshes | ~2.9M |
| `rebuild-model` Action | daily, up to 170 min | ~2.5M |
| Leaderboard backtests | 100 tokens × 4/day, full history | ~1.2M |
| | estimate | ~11.8M vs 15.9M actual |

## The defect underneath it

`computeMcap` is the most expensive read in the system: a supply call, a recent-transfer lookup, then a receipt
per swap — up to fourteen calls. `refreshDex` built its verdict without an `mcapUsd`, so every DEX token was
re-priced from scratch every five minutes, forever. The Pons board never paid this, because Pons supplies the
market cap. That one omission is roughly a third of the bill.

It is now cached (`MCAP_TTL_MS`, default 15 minutes) and callers that already read the supply pass it in — the
DEX scan reads `totalSupply` off the free node during discovery, so paying to read it again was pure waste. A
result with zero price samples is deliberately not cached, so an unknown price is retried rather than frozen.

## Zero is now the default, not a setting

Every subsystem routes through one client, so one variable decided the whole bill. A metered endpoint is now
**opt-in**: `RPC_URL` pointing at Alchemy is ignored unless `ALLOW_BILLABLE_RPC=1` is set beside it, and the
service says so at boot and in `RPC_STATUS`. Spending money should not be what happens by default.

The nightly `rebuild-model` schedule is disabled. It ran up to 170 minutes a night against the metered endpoint
to maintain a model whose hypotheses did not survive validation. Dispatch it by hand when a rebuild is wanted;
it uses the free node unless the run is explicitly dispatched with `billable=true`, which also has to satisfy
the client-side guard.

## What running free actually requires

The free native node is **head-only — it keeps no archive state**. `eth_getCode` at any historical block returns
`metadata is not found`, so the binary search in `findDeployBlock` cannot work there at all. This is the real
reason the generic path was never a drop-in: without a launch timestamp it threw, which would have taken down
every DEX verdict.

Three changes make it sound:

- `findDeployBlock` detects a head-only node, returns null instead of throwing, and records the fact so it
  probes once rather than twenty-odd times per token.
- Callers supply an anchor they already hold. DEX discovery knows each token's pool-creation block; Pons knows
  the launch time. With an anchor, no search is needed and nothing is guessed.
- `deployerOf` works without an Alchemy-only method: the mint is the token's first Transfer out of the zero
  address, read forward from the anchor. With no anchor and no archive it returns null and is not cached — a
  missing anchor is not evidence about the deployer.

Verified against the live chain with no key: a DEX token's deployer resolved correctly, `computeIntel` returned
a full verdict in ~1s, and `computeMcap` priced BUN at $49.5M against Pons's own $43.9M.

## Restoring paid access

Set `ALLOW_BILLABLE_RPC=1` with `RPC_URL`, and dispatch the Action with `billable=true`. Both sides have to
agree before a run can spend anything. Before doing either, read the table above and decide which loop is worth
what it costs — the answer is per-loop, not all-or-nothing.
