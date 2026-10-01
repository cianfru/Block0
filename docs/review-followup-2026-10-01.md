# Review follow-up — 1 October 2026

Scope: five findings from the review of `71aa9804e9bf5d311ffb8ffcb3171de2770ae15c`.
This document supersedes the protocol-v2 and estimate-based budget notes in older project context.
No deployment settings, secrets, recurring jobs or posting switches are changed. Timelines, watchlists and
editorial policy remain separate roadmap work. All verification uses synthetic fixtures, not paid APIs.

## 1. Make convergence agree with its explanation

**Reason:** two wallets could each buy 100 and sell 10, yet the radar said they had not sold or moved anything.
`trimmed` wallets counted both as convergence participants and as sellers.

**Change:** only `buying` wallets (an observed buy and zero observed outflow in the window) qualify for convergence.
Any sale, transfer out or contract deposit disqualifies a wallet, even if small or followed by a rebuy. `trimmed`
remains useful descriptive activity, but no longer qualifies. Exit text no longer says nobody bought when there
were round trips. `nHolding` is retained as a compatibility field name; it is a no-outflow buyer count, NOT a balance.
The forward logger stores the same qualifying wallets. This intentionally conservative window-wide definition
also excludes an outflow before a subsequent buy; we do not claim to reconstruct an earlier position.

**Tests:** partial sales, wallet transfers and contract deposits; rebuy; unordered input; old-position sales;
the existing genuine-convergence test stays positive. See `test/radar.test.mjs`.

## 2. Separate failed, pending and published replies

**Reason:** a response with `status: failed` was appended as a reply and marked answered, preventing recovery.

**Change:** `state.replyAttempts` records attempt count, status, time, text and available post id. Only a confirmed
`published` response enters the reply ledger and `state.answered`. Confirmed failures may retry after 15 minutes,
at most three attempts per mention, while the mention is still eligible (<24h and in the fetched page).
Retries remain subject to budget, daily reply cap and platform allowance.

Pending replies with a post id are checked with the existing free `social.post.status` API on later ticks
(at most 20 rotating checks per tick; unresolved after 24h becomes `needs-review`).
HTTP 202, missing status and thrown/ambiguous requests are NOT resubmitted. If there is no usable post id, the
record stays pending for operator reconciliation: check the platform before changing its state. This chooses
avoiding duplicate public replies over guessing that a timeout meant failure. Unknown settlement costs remain
reserved. Existing `answered` entries are not automatically reopened because their publication outcome is unknown.

**Tests:** failure/backoff/three-attempt limit, pending-to-published reconciliation, unknown-id async response,
timeout, insufficient credit and exhausted platform reply allowance. See `test/review-followup.test.mjs`.

## 3. Reserve the allowed cost, not an estimate

**Reason:** planning two posts at 0.0187 each admitted both under a 0.038 ceiling, although each request could
legitimately settle at its allowed 0.02 maximum: total 0.04.

**Change:** the shared post cap is 0.02 CREDIT; the mention-read cap is 0.005. Planning uses the post cap and
execution checks the remaining budget again before spending. The request cap is recorded before I/O. A finite,
nonnegative, settled cost at or below the reservation refunds only the difference. Failed responses still count
their reported cost; thrown, pending and invalid-cost responses retain the maximum reservation. Attempts count
toward rate limits even when publication fails. A caller cannot lower `postCost` below the transmitted request cap.
No new cost-increasing option or metered chain fallback is introduced.

**Boundary:** this protects a single tick/runner using its persisted state and an API that enforces `max_cost`.
The runner still saves state at the end of each cycle; abrupt process loss before that save, lost state or
independent concurrent runners require durable pre-send checkpoints/idempotency as separate hardening. It is not
an account-wide billing control. Never run independent writers against the same daily budget.

**Tests:** original overrun fixture, exact-cap boundary, failures, unknown/invalid settlements, known refunds,
and mention-read-plus-reply costs. See `test/review-followup.test.mjs`.

## 4. Version the detector and require meaningful closing coverage

**Reason:** 30 peak outcomes and just ONE paired closing outcome could yield PASS. Dropping unavailable closes
also risks selecting only the easiest-to-measure launches. The corrected radar changes event eligibility.

**Change:** protocol **v3** begins a new prospective cohort; stored v1/v2 rows are retained and explicitly excluded
from its verdict. Do not relabel old rows or backfill them as v3. The existing peak percentile, bootstrap and
early-70%/late-30% rules remain. Additional gates:

- At least 30 event/control paired close outcomes.
- At least 80% of the peak-paired events in EACH chronological split have a usable close percentile.
- A usable close percentile requires the event's close and covered closes for at least 80% of its own logged controls.
- Below those gates, return `verdict: null` with the coverage shortfall, never PASS or FAIL.

The 30/80% thresholds are conservative design choices fixed for new observations, not optimized against real
results and not a statistical power calculation. Missingness, sample dependence and outcome quality still need
research scrutiny; passing is not a profitability claim. Reports recompute percentiles without mutating input rows,
so a prior report cannot leave a stale percentile that bypasses the new gates.

**Rollout consequence:** v3 needs a new sample and seven-day maturation. Updating code does not validate the radar
or enable convergence posts. The methodology page publishes this amendment. Historical rules remain in Git and
the v2 comment block; they are not silently rewritten as if they had always been the rules.

**Tests:** one-close false pass, insufficient matched-control coverage, missing later-split closes, legacy exclusion,
repeat-report purity, fully covered PASS and FAIL fixtures. See `test/radar-protocol.test.mjs`.

## 5. Share freshness rules between board and dossier

**Reason:** board rows blanked stale current-activity flags, but an older static dossier still labelled those
numbers “last 30 min.” A timestamp in a different section did not repair that assertion.

**Change:** `public/read-freshness.js` supplies the same pure policy to both surfaces: through 45 minutes a read
is recent; after 45 minutes current selling/movement flags become unknown and the dossier is labelled historical;
after three hours the static dossier is not rendered. Historical movement is explicitly scoped to the 30 minutes
before the read, and static balances are described as balances at read time. Missing, invalid or future read clocks
fail closed. Source snapshots remain unchanged. Open tabs refresh at freshness boundaries, so leaving a tab open
does not preserve a stale “current” statement indefinitely. No additional chain or paid API polling is introduced.

**Tests:** both boundaries including equality, agreement with board policy, immutable input, invalid/future clocks,
and dossier-render integration. See `test/review-followup.test.mjs` and `test/dossier-freshness.test.mjs`.

## Verification

Run `npm test`. The new tests run offline alongside the original suite. Deployment and live Orbio billing/publishing
must be verified separately with a reviewed dry run; this change does not perform those operations.
