# Local research with no paid-service dependencies

This is a deliberately smaller price-observation tool, not the hosted forensic platform. It uses Python 3's standard library, SQLite and manually started public Pons requests. It does not import the Node app, read environment credentials, load .env files, connect to Redis, call RPC/LLMs, or start timers outside the explicitly bounded collection session. Other cloud deployments/account subscriptions must be stopped separately to reach $0 recurring service charges.

From the repository directory:

```sh
# Opens only a localhost HTTP server; makes no outbound requests.
python3 local/research.py serve
# Visit http://127.0.0.1:8081; Ctrl+C stops the server.

# In another terminal: at most 30 minutes, 31 total requests, four tokens.
python3 local/research.py collect

# Offline HTML report; can be opened without a running server or network.
python3 local/research.py report --out local-report.html

# Import a full forward export, preserving observations and frozen decisions.
python3 local/research.py --max-mb 512 import /absolute/path/to/forward-export.json

# Verification, entirely offline.
python3 -m unittest discover -s local -p 'test_*.py'
```

No npm install is required. `npm run local` and `npm run local:collect` are convenience aliases only. Do not use the legacy `npm start` when intending to run this isolated mode.

Limits: four tokens by default (maximum 20); one-minute minimum interval; 30-minute default session (maximum 60); 31 requests by default (maximum 60, failures included); 2 MB maximum response; 15-second maximum request timeout. Both deadline and request budget terminate collection. Redirects and environment proxies are disabled. Only two exact public Pons endpoint paths on www.ponsfamily.com are allowed. Missing quotes are saved as missing, with no inferred zero price or paid fallback. Throttling/schema errors stop the session.

SQLite defaults to `data/local-research.sqlite` with a 50 MiB database cap (configurable 1–1024 MiB using --max-mb before the command). SQLite can use additional temporary rollback-journal space during a write. Full-disk/size errors stop collection; nothing is automatically deleted. Preserve this file and imported exports in your normal local backups. The dashboard shows at most 200 latest token rows; all stored observations and original imported records remain in SQLite. This initial report does not calculate a trading strategy, reconstruct missing history, or re-evaluate imported decisions.

The service-cost target excludes your existing hardware, electricity and internet. Public endpoint access has no availability guarantee; if it stops working, collection stops. There is no always-on hosting or Alchemy-dependent forensics in this mode.

## Billing shutdown and backup handover

- The GitHub rebuild-model workflow has been disabled at the workflow level, as well as having its schedule removed on main.
- The AI validation monitor was already paused. No recurring AI research is needed.
- The saved public API snapshots in the Codex task outputs are PARTIAL, not a full database backup.
- Full Redis backup requires access to the Railway service. First run `railway login` locally. In the authenticated app-service environment, run `node tools/export-forward.mjs` and securely save stdout as the full research export. This exports current and archived experiment records, not every unrelated legacy/analytics key; preserve a full database snapshot too if those matter. Export required configuration privately, never into Git.
- Verify the export parses and contains expected records, observations and decisions; test the local import before deleting any service or volume.
- After backup, remove/stop billable Railway app and Redis resources, inspect retained volumes and subscription charges, and cancel any unwanted paid plan. No Railway resources have been deleted by this change.
- Remove/revoke unneeded Alchemy keys and verify paid-plan status/usage limits in the Alchemy account. No account-level Alchemy cancellation has been performed or verified.

Do not resume cloud deployment just to try this tool. Review/merge the local-mode PR only after confirming auto-deployment is disabled if merging main would launch a billed Railway build.
