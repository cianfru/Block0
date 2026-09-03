# Block0 — the launch scanner for the Robinhood Chain

**Should I ape?** Paste — or don't even paste — and in seconds see whether a fresh token launch is *clean* and
whether it's on the *pace of past winners*. Block0 watches every launch on the Robinhood Chain, reconstructs the
truth from public on-chain data, and grades it — snipers, bundles, concentration, live insider-dumping — so a
trader knows what's safe to touch at a glance.

> **Signal, not proof — never a buy recommendation.** Every number is reconstructed from public chain data and is
> reproducible. Block0 tells you what already happened on-chain and how it compares to winners; it never predicts.

This README is the **product + design brief**. It describes what Block0 is, the screens it needs, the visual
language, and — most importantly — the **live JSON APIs** every screen is backed by, so a design can be built
against real data and wired straight onto the running backend.

---

## The idea (and the moat)

Most launch tools are black boxes that tell you to buy. Block0's edge is the opposite: **radical transparency**.
Every score is a published formula over public data; the methodology and even the model's *measured accuracy* are
open. That honesty is the product — a memecoin trader can't trust a black box, but they can trust a number they can
check. So the whole surface defaults to: show the real number, state the method, label the caveat.

**What we uniquely do:** we don't just flag risk — we place a live token against the **fingerprint of past
winners** (a "winner corridor" with concrete wallet + market-cap targets per stage), and we follow **wallets across
every token** (who's a proven trader, who's dumping, what a deployer launched before). That's the depth no
influencer or generic scanner offers.

## Who it's for / the voice

Robinhood-Chain memecoin traders, mostly arriving from X on a **phone**. The voice is sharp, honest, a little
insider — never hype, never "financial advice." Confident about the data, humble about the future.

---

## The two launch venues (surface this clearly)

Tokens reach the chain two ways, and a visitor should know instantly which they're looking at:

1. **Launchpad (Pons)** — tokens on a bonding curve that "graduate" into the AMM once they fill. The launchpad is a
   small quality filter. Board sections: **cooking** (pre-graduation, ranked by curve progress) and **graduated**.
2. **Uniswap (direct)** — tokens listed straight onto the Uniswap-v4 AMM, no launchpad. Far more numerous, far more
   spam, live from block one. Board section: **dex**, venue-labeled `uniswap-v4`.

Design should let the user filter/segment by venue (a tab or a toggle), because "is this a launchpad token or a raw
DEX listing" changes how to read it.

---

## The screens

### 1. The board (home)
The landing. A live, self-updating grid of launches, each a **card** with its verdict at a glance. Tabs/filters:
**About to graduate · Blueprint fit · Graduated · DEX listings · Heating · Safest · Avoid**, plus **search** by
name/symbol or a pasted contract. A live pulse header (total launches, active, graduated).

Each **card** shows: token identity (logo/monogram, symbol, market cap), a big **risk score 0–100** + label
(*Looks cleaner / Mixed / Caution / High risk*), the five sub-score meters, blueprint-fit + corridor chips (for
launchpad tokens), a "N wallets → precedent mcap" line, and any live alert ("▼ 2 insiders selling now" /
"✓ no snipers · no bundles"). New launches animate in.

### 2. The token dossier (`/token?address=`)
The deep dive. Sections:
- **Identity + verdict** — logo, symbol, mcap, holders, unique buyers, age, momentum, bonding progress; the big
  risk score + the dominant risk driver in plain words.
- **What's under the hood** — the five sub-scores as meters: **Snipers · Bundles · Concentration · Dumping now ·
  Deployer**, each with a plain detail line.
- **Deployer track record** — *proven builder / serial launcher / first launch*, with clickable chips to the
  deployer's **other tokens** (graduated marked).
- **Where it stands vs the winners** — Blueprint fit, Launch corridor, and a **valuation ladder** (this token's
  wallet count → the market cap winners carried at that count).
- **The winner corridor chart** — the study's healthy zone drawn as **stage boxes** (each labeled with the concrete
  wallet + mcap target winners hit by that age), with **this token's live path drawn through it**, colored
  on-track / drifting / failing. A plain verdict pill.
- **History chart** — score + valuation over time, with a metric toggle (market cap / price / unique wallets /
  volume) and the risk score overlaid.
- **Who's in it** — three live lists: **Adding now · Shedding now · Biggest bags**, each a wallet with its net
  flow / balance and a sniper flag. *These wallets are the entry point to the wallet views below.*

### 3. Wallet view (to design — data is ready)
Click any wallet (especially a seller) → a **cross-token profile**: every token this wallet has traded, what it
still **holds vs exited**, its flipper-vs-holder style. This is the "**follow the smart money**" surface — a proven
trader's whole footprint. (PnL in $ — bought-low/sold-high — is a planned second layer; leave a slot for it.)

### 4. Methodology (`/methodology`) & Terms (`/terms`)
The credibility pages. Methodology publishes every formula **and the measured signal accuracy** (an AUC-by-age
table — how well the corridor separates winners from losers, honestly including that the first ~30 min is a
coin-flip). Terms is a plain not-financial-advice / privacy page.

### 5. Access gate (to design)
Block0 is **token-gated, read-only**. Flow: **Connect an EVM wallet → read the Block0-token balance → if ≥ the
threshold, you're in; else you're not.** No signing, no transactions, no custody — a pure balance check. The
"Connect" button in the header is this. (Token contract + threshold are config; the tokenomics are TBD, so design
the connect → check → granted/denied states; the gate stays open until the token is set.)

---

## Design language

Robinhood-neon on near-black. Confident, dense where it counts, never half-baked. **Mobile-first** — most traffic
is a phone from X; every screen must be responsive, tap-target-friendly, no horizontal scroll, and it must hold up
for a few hundred concurrent users digging into results.

- **Ground:** `#08080b` (near-black), soft neon radial glows.
- **Accents:** lime `#c8ff4d` (primary / good), cyan `#35e6e0` (data / market cap), magenta `#ff5cf0` (wallets /
  DEX), amber `#ffd23d` (caution), coral `#ff3b5c` (danger / selling).
- **Risk color scale:** lime (<25 clean) → cyan (25–44 mixed) → amber (45–65 caution) → coral (66+ high risk). Use
  it consistently on scores, stripes, meters.
- **Type:** display / headlines in **Instrument Serif** (italic accents); body + data in **Inter**; monospace for
  addresses and figures. Tabular numerals for anything that lines up.
- **Feel:** live and reactive (pulses, new-card animation), but calm — the data is the drama. Semantic color only;
  never color-as-decoration. Encode state in *form* (a chip, a stripe, a meter) as well as number.

---

## The data contract (design against these)

All read-only JSON, no auth, same-origin. Base = the deployed site.

| Endpoint | Returns |
|---|---|
| `GET /api/board` | `{ cooking[], graduated[], dex[], stats }`. Each token: `sym, name, logo, address, mcapUsd, risk, label, parts{snipers,bundles,concentration,dumping,deployer}, flags{holders, wallets, top10Pct, snipers, bundles, insiderSellersNow, …}, blueprint, blueprintLabel, corridor{traj,status}, path{precedent,ratio,pos}, progress (launchpad), venue (dex), momentum` |
| `GET /api/token?address=` | Full dossier: the above **plus** `buyers[] / sellers[] / topHolders[]` (each `{a, bal, bought, sold, net, sniper}`), `deployer{reputation, launched, graduated, others[]}`, `precedent`, `ageH`, `explorer` |
| `GET /api/backtest?token=` | History: `series[]` (`{t, ageH, risk, label, top10, holders, wallets, mcap, price, volUsd, traj, blueprint}`) + `corridor[]` (stage boxes: `{lo,hi,q1,med,q3,tw,tm}` = age band, healthy trajectory zone, target wallets `tw` + target mcap `tm`) + `priceRough` flag |
| `GET /api/wallet?address=` | Cross-token profile: `{ address, tokensTraded, held, exited, style, tokens[] }` where each token is `{token, sym, bought, sold, net, nBuys, nSells, held, exited, first, last }` |
| `GET /api/validation` | Signal accuracy: `{ cohort, perBin[] (age → AUC, winner/loser medians, on-band rates), lateLife }` |
| `GET /api/status` | Health: board freshness, counts, store, rpc, alerts, storage |

Notes for the designer:
- **Risk / labels** are already computed — render `risk` (0–100) and `label` directly; color by the scale above.
- **Venue:** launchpad tokens live in `cooking`/`graduated`; DEX tokens in `dex` and carry `venue`. Blueprint +
  corridor + bonding progress apply to launchpad tokens; DEX tokens are "live from block one."
- **Wallet lists** already carry the wallet address + whether it's a sniper — make them clickable into the wallet
  view (`/api/wallet`).
- **Numbers are estimates where noted** — reconstructed prices are swap-implied; the API flags `priceRough` when a
  reconstruction is uncertain. Surface that honestly (a subtle "estimate" affordance), never as a hard quote.

---

## Honesty rails (bake into the copy)

- "Signal, not proof — never a buy recommendation." Present on the board + every dossier + the footer.
- A fresh launch's first ~30 minutes is a measured coin-flip — the UI says **too early to call**, it doesn't fake a
  verdict.
- Show the method and the caveat next to the number. When in doubt, more transparent.

---

## Under the hood (for integration, not design)

Dependency-light Node (`node server.mjs`, deploys to Railway). The forensic engine is EVM-generic and
launchpad-agnostic — it verdicts any token from its transfer history. Pons API = launchpad discovery; on-chain
Uniswap-v4 `Initialize` events = DEX discovery; Alchemy for heavy transfer pulls, the native RH RPC for wide log
scans. The winner model (`model.json`) is rebuilt from a study of past winners incl. DEX winners; its accuracy is
re-measured each rebuild and published on the methodology page. See `.env.example` for configuration.

Not financial advice. You are responsible for your own decisions.
