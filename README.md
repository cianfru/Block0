# Block0

**From block zero.** Paste a token contract → in seconds, see **who's holding and who's dumping, live**. Built
for freshly-launched tokens, where the whole transfer history is small enough to pull and score in real time.

No database. One small Node process (a single dependency, `ws`, for the live websocket). Deploys to Railway
with `node server.mjs`.

## What it does

- **Auto-detects the pool** for any pasted token (highest-degree counterparty) — no config per token.
- **Scores the launch, live:** buy/sell pressure, holders now, top-10 concentration, **snipers** (block-0 buyers),
  same-block **bundles** (coordinated snipes), who's selling in the current window.
- **Live bubble chart:** every trade is a bubble — buys above the line (green), sells below (red), size ∝ amount,
  a **white ring** when a brand-new wallet appears. New trades slide in from the right as blocks are mined.
- **New tokens = exact.** If the token is young enough, it pulls the *entire* history (`mode: "full"`) and every
  number is exact. Older tokens fall back to a trailing window (labelled).

## Run locally

```bash
node server.mjs                 # → http://localhost:8080  (uses public drpc, no key needed)
node cli.mjs 0x<token> 18 1500  # one-shot scan in the terminal
```

## Deploy to Railway

1. Push this folder to a repo, point a Railway service at it.
2. Start command: `node server.mjs` (Railway sets `PORT`).
3. Set `RPC_URL` to your Alchemy/QuickNode HTTPS endpoint (recommended over public RPC).
4. For another chain (e.g. the Robinhood L2), just set `RPC_URL` to that chain's endpoint and `CHAIN=<name>` —
   the engine is EVM-generic.

## Architecture

```
browser ──/api/scan?address─▶ engine.scan()  ── eth_getLogs (full or window) ─▶ RPC
   │                              └─ decode → detectPool → analyze → scores + events
   └──/api/stream (SSE) ◀── poll loop ── eth_getLogs(newBlocks) ── RPC   (live tail)
```

- `rpc.mjs` — JSON-RPC client (env `RPC_URL`, else public drpc), `eth_getLogs` chunked, deploy-block finder.
- `engine.mjs` — pure scoring core: `decode`, `detectPool`, `analyze`, `scan`. No AI, deterministic.
- `server.mjs` — static host + `/api/scan` + `/api/stream` SSE tail.
- `public/` — the live bubble-chart UI.

## Live tail

When `RPC_WS` is set, the server tails via an `eth_subscribe("logs")` **websocket** — one subscription per watched
token, opened when the first viewer connects and dropped when the last leaves, auto-reconnecting on drop. Each new
transfer is pushed to the browser over SSE the instant it's mined (sub-second). With no `RPC_WS`, it falls back to
HTTP polling every `POLL_MS`. See `ws.mjs`.

## Production upgrades (noted, not yet wired)

- **Warm cache:** keep hot tokens' state in memory / a cheap KV so repeat scans are instant.
- **Access gate:** wallet-connect + `ACCESS_TOKEN` balance check before `/api/scan`.
- **Richer sniper/bundle intel:** fold in the ETH-funding graph (shared-funder clustering) from the sibling
  forensic engine for true coordinated-wallet detection.

Signal, not proof — every number is reconstructed from public chain data. Not financial advice.
