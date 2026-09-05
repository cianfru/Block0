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

## Design system

A **dark, neon-on-near-black terminal** — a trading tool, not a marketing site. Committed dark theme (no light
mode). Confident and dense where it counts, calm everywhere else: **the data is the drama**, so the chrome stays
quiet and lets the numbers and colors carry the signal.

### Principles

1. **Honest by default.** Every number shows its method and caveat nearby. Estimates look like estimates. Never a
   buy-CTA; the loudest thing on a card is the *risk score*, not a "BUY" button.
2. **Semantic color only.** Color = meaning (good / caution / danger / data / wallet), never decoration. If a color
   isn't saying something, it's the wrong color.
3. **Encode state in form, not just number.** A risk isn't only a digit — it's a colored stripe, a filled meter, a
   pill. A glance should read the verdict before the eyes parse the figure.
4. **Live but not busy.** Subtle pulses and a shake-in on new launches signal "this is live." No gratuitous motion;
   respect `prefers-reduced-motion`.
5. **Mobile-first, for real.** Most traffic is a phone from X. Every screen: responsive, no horizontal scroll,
   tap targets ≥ 40px, no hover-only affordances, opaque overlays. Must stay smooth for a few hundred concurrent users.
6. **Never half-baked.** Consistent spacing, aligned baselines, tabular numerals, no orphaned states — a loading or
   empty state is designed, not blank.

### Color palette

Ground and neutrals (cool, slightly blue-black):

| Token | Hex / value | Use |
|---|---|---|
| `--bg` | `#08080b` | Page ground (near-black). Soft neon radial glows layered on top. |
| `--glass` | `rgba(255,255,255,.035)` | Card / surface fill (with a subtle top-down gradient to `rgba(255,255,255,.01)`). |
| `--line` | `rgba(255,255,255,.09)` | Default borders / dividers. |
| `--line-2` | `rgba(255,255,255,.16)` | Hover / emphasized borders. |
| `--tx` | `#ffffff` | Primary text. |
| `--dim` | `#b6b6bd` | Secondary text. |
| `--mute` | `#7f7f88` | Tertiary / captions / axis labels. |

Neon accents — each has a fixed meaning:

| Token | Hex | Meaning |
|---|---|---|
| `--lime` | `#c8ff4d` | **Primary / good.** Brand, "looks clean", buying/accumulating, the Connect button, on-track. |
| `--cyan` | `#35e6e0` | **Data.** Market cap, prices, neutral-positive metrics, "graduated". |
| `--magenta` | `#ff5cf0` | **Wallets & DEX.** Unique-wallet series, the DEX/Uniswap venue, wallet views. |
| `--amber` | `#ffd23d` | **Caution.** Mid risk, "behind pace", warnings, rough-estimate flags. |
| `--coral` | `#ff3b5c` | **Danger.** High risk, selling/dumping, failing, losses. |

**Risk color scale** (apply everywhere a 0–100 risk appears — the score number, the card top-stripe, meters):
`< 25` lime (Looks cleaner) → `25–44` cyan (Mixed) → `45–65` amber (Caution) → `66+` coral (High risk).

Glows: accents get a soft `box-shadow` bloom (e.g. `0 0 8px` of the accent) on live dots and key marks — sparingly,
as emphasis, not on everything.

### Typography

| Role | Family | Notes |
|---|---|---|
| Display / headlines | **Instrument Serif** (Google Fonts) | Large numerals, hero lines, section titles. Its *italic* is the signature accent — use for the "0" in block0, emphasis words, section eyebrows. |
| Body / UI / data | **Inter** (Google Fonts) | Everything functional: labels, copy, table cells, buttons. |
| Addresses / mono figures | system monospace (`ui-monospace`) | Wallet addresses, hashes, aligned numeric columns. |

- **Tabular numerals** (`font-variant-numeric: tabular-nums`) on anything that lines up in a column or updates live.
- Uppercase micro-labels (holders, market cap, age…) at small size with letter-spacing — the "terminal" texture.
- Base body ~15px; risk scores and hero figures large in the serif (2–3.6rem). Keep a real type scale, don't freehand sizes.

### Surfaces, radius & elevation

- **Cards / panels:** 1px `--line` border, `--glass` fill with a subtle vertical gradient, `backdrop-filter: blur(12px)`,
  **radius 14–16px**. Hover: lift `translateY(-3px)` + border → `--line-2`.
- **Buttons / inputs / search:** radius **12px**. Primary button = solid `--lime` on `#08080b` text, weight 700.
- **Chips / pills / meters-detail:** radius **9–11px**, faint fill (`rgba(255,255,255,.03)`) + `--line` border.
- **Meters (sub-scores):** a 4–5px rounded track (`rgba(255,255,255,.09)`) with a fill colored by severity.
- **Live dot:** 7–8px circle, `--lime`, pulsing ring (`box-shadow` keyframe).
- Depth comes from **border + subtle fill + blur**, not heavy drop-shadows. One quiet system, not a shadow on every box.

### Components (patterns to reuse)

- **Verdict card** — top color-stripe (risk scale) · identity row (monogram/logo + symbol + mcap) · big risk score
  + label · sub-score meters · venue/blueprint/corridor chips · an alert line when relevant.
- **Sub-score meter** — label + value + colored bar + one plain detail line ("2 wallets · hold 6%").
- **Chip / pill** — small labeled status (blueprint fit, corridor pace, venue). Icon optional and minimal — no
  generic emoji soup.
- **Data table** — mono, tabular-nums, thin row dividers, right-aligned figures, green/red for +/− flow.
- **Charts** — dark ground, faint gridlines, one accent per series (mcap = cyan, wallets = magenta, risk = the
  risk-scale color, corridor zone = translucent lime boxes). Labels in `--mute`. Endpoint/"now" marker emphasized.

### Motion

New launch: a brief shake-in + a lingering lime glow, then still. Live dots pulse. Card hover lifts 3px. Typewriter
reveal on nav labels is on-brand (used on the current landing). Everything gated by `prefers-reduced-motion`.

### Do / Don't

- **Do** keep the risk score the loudest element on a card; **don't** add a buy button.
- **Do** use the fixed color meanings; **don't** recolor "selling" green or "good" red.
- **Do** label estimates; **don't** present a reconstructed price as a hard quote.
- **Do** design the empty/loading/"too early to call" states; **don't** ship a blank box.
- **Do** treat mobile as the primary layout; **don't** design desktop-first and shrink.

---

## The data contract (design against these)

All read-only JSON, no auth. **CORS is open (`access-control-allow-origin: *`)**, so the front end can call the
API cross-origin from its own domain — point it at the backend origin (e.g. `https://<app>.up.railway.app`) via a
build-time base, or reverse-proxy `/api/*` onto the backend and call same-origin. A ready-to-adapt mapping
reference (fetchers + the field mapping below, as TanStack Query hooks) lives in `docs/api-adapter.ts`.

| Endpoint | Returns |
|---|---|
| `GET /api/board` | `{ updated, scanning, cooking[], graduated[], dex[], stats }`. Each token: `sym, name, logo, address, mcapUsd, risk, label, section, venue, parts{snipers,bundles,concentration,dumping,deployer}, flags{holders, wallets, top10Pct, snipers, bundles, insiderSellersNow, …}, blueprint, blueprintLabel, corridor{traj,status}, path{precedent,ratio,pos}, progress (launchpad only), momentum` |
| `GET /api/token?address=` | Full dossier: the above **plus** `buyers[] / sellers[] / topHolders[]` (each `{a, bal, bought, sold, net, sniper, first}`), `deployer{address, reputation, launched, graduated, others[]{sym,address,mcapUsd,graduated}}`, `precedent`, `ageH`, `explorer` |
| `GET /api/backtest?token=` | History: `series[]` (`{t, ageH, risk, label, top10, holders, wallets, mcap, price, volUsd, traj, blueprint}`) + `corridor[]` (stage boxes: `{lo,hi,q1,med,q3,tw,tm}` = age band, healthy trajectory zone, target wallets `tw` + target mcap `tm`) + `priceRough` flag. **Also `curPrice`, `pnl[]` and `pnlStats`** — per-wallet realized/unrealized profit ON THIS TOKEN: each `pnl` row is `{a, realized, unrealized, pnl, pnlPct, roi, invested, qty, avgCost, up, holding}` (rank by `|pnl|`), `pnlStats = {traders, winners, winnerPct}`. Join `pnl` to the dossier's `buyers/sellers/topHolders` by address to show each wallet up or down. |
| `GET /api/graph?address=&n=` | **Bubble map** — the token's wallet-relationship graph for spotting bundles: `{ links, nodes[], edges[], clusters[], stats }`. `nodes` = `{a, bal, pct, bought, sold, role ("bundle"\|"sniper"\|"holder"), net, flow ("buy"\|"sell"\|"flat"), cluster}`; `edges` = `{a, b, kind ("bundle"\|"transfer"), amt?, n?}` (bundle = bought in the same block; transfer = moved the token wallet-to-wallet); `clusters` = connected groups `{id, size, wallets[], bal, pct, net, flow, hasBundle, flag}` — **`flow` is the whole cohort's green/red verdict** (net token flow over ~24h: `sell`=the insiders are distributing this token now, `buy`=accumulating), `flag`=bundle to be aware of. Render force-directed, size by `pct`, **colour each cluster by its `flow` (green buy / red sell)**, ring flagged clusters. **Opt-in `&funders=1`** adds common-funder links (`edges` `kind:"funder"`, `via`) — wallets funded from the same source, the deeper "same operator" signal that intra-token links can't see; clusters gain `hasFunder`, and a `funders` meta reports the pass. This is the *only* Alchemy cost on the map (top 40 wallets, one lookup each, cached forever), so it's off by default — request it when the user opens the bundle view, not on every load. |
| `GET /api/alerts/feed?n=` | **Live alerts** — recent event alerts detected over the board's own verdicts: `{ updated, push, telegram, events[] }`, each `{kind: insider-dump|smart-convergence|clean-launch, sev, at, address, sym, mcapUsd, ageH, risk, holders, headline, detail}`. Fires on TRANSITIONS only (insiders *start* selling, smart money *reaches* ≥2, a launch *clears* the clean bar), one per token per kind per 6h. Rendered as the board's "⚡ Live alerts" strip; pushed to Telegram when the bot is configured. |
| `GET /api/track-record?calls=N` | **Forward track record** — every young call we froze before the outcome existed. Rates (`baseRate`, `promising.winRate`, `lift`, `buckets[]`) are computed ONLY over the matured cohort (≥`horizonH`); `wonEarly` are winners not yet matured and never counted; `ready:false` = accruing. `calls[]` (with `?calls=N`) lists each call `{sym,address,call,at,ageAtCallH,risk,mcapAtCall,peakMult,matured,outcome}` — misses included. Page: `/track-record`. |
| `GET /api/picks` | **Most promising by market-cap bracket** — `{ llmUsed, model, brackets[] }`, each bracket `{label, pick{sym,address,why,viaLlm,…}, runnerUp, candidates[]}`. A deterministic promise score pre-ranks; with `OPENROUTER_API_KEY` a free model writes the reason (it can only pick one of our candidates; buy/price language is rejected in code). Board tab "◆ Most promising". |
| `GET /api/leaderboard?n=` | **Follow the smart money** — wallets with proven positive PnL aggregated across the graduated + DEX winners: `{ updated, tokensScanned, wallets, rough, rows[] }`, each row `{a, realized, unrealized, pnl, roi, invested, tokensWon, tokensTraded, winRate, holdingAny, tokens[]{sym,address,realized,pnl,roi,holding}}`, ranked by realized cash. Returns `{computing:true, rows:[]}` until the first build finishes. |
| `GET /api/wallet?address=` | Cross-token profile: `{ address, tokensTraded, held, exited, style, tokens[] }` where each token is `{token, sym, bought, sold, net, nBuys, nSells, held, exited, first, last }` (`first`/`last` are unix seconds; `style` ∈ `active-trader`/`holder`/`mixed`) |
| `GET /api/validation` | Signal accuracy: `{ cohort, perBin[] (age → AUC, winner/loser medians, on-band rates), lateLife }` |
| `GET /api/status` | Health: board freshness, counts, store, rpc, alerts, storage |

Notes for the designer — a few exact shapes so the binding is right first time:
- **Risk / labels** are already computed — render `risk` (0–100) and color by the scale above. Note `label` is
  **UPPERCASE** (`"LOOKS CLEANER" | "MIXED" | "CAUTION" | "HIGH RISK"`); title-case it for display, or just derive
  the wording from `risk` via the scale (either is fine — they agree).
- **Section & venue are explicit fields** on every board token: `section` ∈ `"cooking" | "graduated" | "dex"`,
  `venue` ∈ `"pons" | "uniswap-v4"`. (They also correspond to which array the token arrived in.) Split the board
  UI by these so the two venues read distinctly — Pons launchpad vs. direct Uniswap listing.
- **`corridor.status`** enum is `"on-track" | "behind" | "failing"` (map `"behind"` → amber "drifting" if you
  prefer that wording). Blueprint + corridor + `progress` apply to launchpad tokens; DEX tokens are "live from
  block one" (no bonding progress).
- **Wallet lists** already carry the wallet address + whether it's a sniper — make them clickable into the wallet
  view (`/api/wallet`). The `flags.insiderSellersNow` count is the click target for the "N insiders selling now"
  reveal (open the `sellers[]` rows).
- **Wallet = a codename + our own PnL page, never a raw hex string, never a third-party portfolio.** Zerion/DeBank do
  NOT index the Robinhood Chain (they return "unsupported address"), so wallets link to **our** reconstruction at
  `/wallet?a={address}` (per-token realized/unrealized across the winner set). Render each as a compact card from what
  we return (bag / % supply / role / this-token PnL / cluster flow) that clicks through to `/wallet?a={address}`; the
  chain block explorer (`links.explorer`, set when `EXPLORER_URL` is configured) is the only external link, as a
  secondary. Apply everywhere an address appears: bubble-map nodes, the insider-selling reveal, buyers/sellers/
  top-holders, the leaderboard, the deployer's other launches. **⚠ Escape token symbols/names (`B0.esc`) — they're
  attacker-controlled on a permissionless launchpad.**
- **Numbers are estimates where noted** — reconstructed prices are swap-implied; the API flags `priceRough` when a
  reconstruction is uncertain. Surface that honestly (a subtle "estimate" affordance), never as a hard quote.

---

## Honesty rails (bake into the copy)

- "Signal, not proof — never a buy recommendation." Present on the board + every dossier + the footer.
- A fresh launch's first ~30 minutes is a measured coin-flip — the UI says **too early to call**, it doesn't fake a
  verdict.
- Show the method and the caveat next to the number. When in doubt, more transparent.

---

## Rate limits (public API)
Heavy endpoints (`/api/backtest`, `scan`, `graph`, `wallet`, `wallet-pnl`, `wallet-trades`, `token`) trigger real RPC work and are limited to ~20 requests/min per IP with a global cap of 6 concurrent; beyond that you get `429` (with `Retry-After`) or a fast `503 busy`. Cached reads (`board`, `leaderboard`, `picks`, `alerts/feed`, …) allow ~120/min per IP. Identical concurrent requests are coalesced server-side. Poll gently; nothing here needs more than one request every few seconds.

## Under the hood (for integration, not design)

Dependency-light Node (`node server.mjs`, deploys to Railway). The forensic engine is EVM-generic and
launchpad-agnostic — it verdicts any token from its transfer history. Pons API = launchpad discovery; on-chain
Uniswap-v4 `Initialize` events = DEX discovery; Alchemy for heavy transfer pulls, the native RH RPC for wide log
scans. The winner model (`model.json`) is rebuilt from a study of past winners incl. DEX winners; its accuracy is
re-measured each rebuild and published on the methodology page. See `.env.example` for configuration.

Not financial advice. You are responsible for your own decisions.
