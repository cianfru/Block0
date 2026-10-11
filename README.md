# Block0 agent data

Written by `tools/agent-tick.mjs` every 15 min. `dry-run.jsonl` = posts the agent would have made; `posted.jsonl` = what it actually posted; `events.jsonl` = every detected event and what the agent did with it; `board.json`, `tokens/` and `timelines/` = what block0.app shows; `history/` = one row per launch per hour (see agent/history.mjs). The branch is kept as a single commit (no history); the ledgers are append-only.
