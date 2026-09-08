import { getJSONStrict, setJSONStrict } from "./store/kv.mjs";
import { fetchActive, fetchGraduated } from "./pons.mjs";
import { addressOf, observation, appendObservation } from "./observations.mjs";
import { featuresAt } from "./features.mjs";
import { nextSetup, SETUP_VERSION } from "./setups.mjs";
import { freezeDecision } from "./decisions.mjs";
import { evaluateDecision, summarize } from "./evaluation.mjs";

export const EXPERIMENT_KEY = "experiment:v1:index";
export const recordKey = (address) => `experiment:v1:token:${address}`;
export const callKey = (address) => `experiment:v1:calls:${address}`;
const INDEX_FIELDS = ["address", "sym", "firstSeenAt", "sampledAt", "status", "pending", "lastSeenAt", "launchedAt", "graduated", "setupState", "observationAt", "decisionAt", "everEligible"];
const compact = (r) => Object.fromEntries(INDEX_FIELDS.filter(k => r[k] !== undefined).map(k => [k, r[k]]));
const MIN = 60000;
const emptyIndex = () => ({ schema: 1, startedAt: null, updated: 0, registry: {}, nextPage: 2,
  coverage: { complete: false, scope: "Pons API-visible active and graduated catalogs; not all on-chain deployments" } });

// Pure advancement: old observations and decision payloads are never rewritten. Outcomes live alongside decisions.
export function advanceRecord(record, next, sym) {
  const r = structuredClone(record || { address: next.address, firstSeenAt: next.observedAt, observations: [], decisions: [], transitions: [], droppedObservations: 0 });
  if (r.observations.at(-1)?.observedAt >= next.observedAt) return r;
  r.sym = String(sym || r.sym || "?").slice(0, 80);
  if (r.observations.length >= 2048) r.droppedObservations++;
  r.observations = appendObservation(r.observations, next);
  const features = featuresAt(r.observations, next.observedAt);
  const setup = nextSetup(r.setup, features);
  if (setup.state !== r.setup?.state) r.transitions = [...r.transitions, { at: next.observedAt, from: r.setup?.state || null, to: setup.state, reasons: setup.reasons }].slice(-100);
  if (setup.state === "triggered" && !r.decisions.some((d) => d.strategy === SETUP_VERSION)) {
    r.decisions.push(freezeDecision(next.address, features, SETUP_VERSION, { sym: r.sym, venue: next.venue }));
  }
  r.setup = setup; r.features = features; r.everEligible = !!(r.everEligible || features.ready);
  r.decisions = r.decisions.map((d) => d.outcome && d.outcome.status !== "pending" ? d : { ...d, outcome: evaluateDecision(d, r.observations, next.observedAt) });
  return r;
}

// Serial collector for one service replica. Strict persistence errors stop publishing new decisions.
// No chain reconstruction here. Forensics reuse timestamped board reads; unknown coverage stays unknown.
export function createExperiment({ read = getJSONStrict, write = setJSONStrict, active = fetchActive, graduated = fetchGraduated,
  board = () => [], market = async () => null, clock = Date.now, enabled = true,
  maxTokens = 5000, sampleBudget = 80, marketBudget = 4 } = {}) {
  let index = null, running = false, error = null, initializing = null;
  const initialize = async () => {
    if (index) return;
    if (!initializing) initializing = (async () => {
      const loaded = await read(EXPERIMENT_KEY) || emptyIndex();
      if (loaded.schema !== 1) throw new Error("unsupported experiment schema");
      // Migrate mirrored v1 payloads without losing published calls. Eligibility from older
      // observations was not tracked: the migrated count is explicitly a lower bound.
      for (const [address, item] of Object.entries(loaded.registry)) {
        if (item.decisions?.length) await write(callKey(address), item.decisions);
        if (item.features) loaded.eligibilityLowerBound = true;
        loaded.registry[address] = compact({ ...item,
          setupState: item.setupState ?? item.setup?.state,
          observationAt: item.observationAt ?? item.latest?.observedAt,
          decisionAt: item.decisionAt ?? item.decisions?.at(-1)?.at,
          everEligible: !!(item.everEligible || item.features?.ready || item.decisions?.length) });
      }
      index = loaded;
    })().finally(() => { initializing = null; });
    await initializing;
  };
  async function cycle() {
    if (!enabled || running) return;
    running = true;
    try {
      await initialize();
      const next = structuredClone(index), start = clock();
      next.startedAt ??= start;
      const metas = new Map(), failures = [];
      let latest = null, catalog = null, page = next.nextPage;
      // Always poll newest first; rotate one older page. A changing feed is not a complete archival registry.
      try { latest = await active({ sort: "newest", page: 1, pageSize: 100 }); } catch (e) { failures.push("active: " + e.message); }
      if (latest) {
        for (const m of latest.items) metas.set(m.address, { ...m, availableAt: clock() });
        const pages = Math.max(1, Math.ceil(latest.total / 100));
        page = Math.max(2, Math.min(page, pages));
        if (pages > 1) {
          try { const older = await active({ sort: "newest", page, pageSize: 100 }); for (const m of older.items) if (!metas.has(m.address)) metas.set(m.address, { ...m, availableAt: clock() });
            next.nextPage = page >= pages ? 2 : page + 1;
          } catch (e) { failures.push("older active page: " + e.message); }
        }
      }
      try { catalog = await graduated(); for (const m of catalog.items) metas.set(m.address, { ...m, availableAt: clock() }); }
      catch (e) { failures.push("graduated: " + e.message); }
      const now = clock();
      let omitted = 0;
      for (const [a, m] of metas) {
        const address = addressOf(a); if (!address) continue;
        if (!next.registry[address] && Object.keys(next.registry).length >= maxTokens) { omitted++; continue; }
        const item = next.registry[address] ||= { address, firstSeenAt: now, sampledAt: 0, status: "discovered" };
        item.lastSeenAt = now; item.sym = String(m.sym || "?").slice(0, 80); item.graduated = !!m.graduated;
        item.launchedAt = m.launchedAt || null;
      }
      next.coverage = { complete: false, scope: emptyIndex().coverage.scope, activeTotal: latest?.total ?? null,
        graduatedTotal: catalog?.total ?? null, activePagesThisCycle: latest ? [1, ...(latest.total > 100 ? [page] : [])] : [],
        registrySize: Object.keys(next.registry).length, registryCap: maxTokens, omittedThisCycle: omitted,
        sourceFailures: failures, note: "Missing/delisted launches are retained as unavailable, never inferred dead. Offset pagination can miss rapidly changing launches." };
      // Persist addresses before their records, so a mid-cycle crash cannot orphan a newly discovered token.
      await write(EXPERIMENT_KEY, next);
      index = structuredClone(next);
      const boardRows = board();
      const rows = Array.isArray(boardRows) ? boardRows : [];
      const forensic = new Map(rows.map((t) => [addressOf(t.address), t]));
      const young = (r) => r.launchedAt && now - Date.parse(r.launchedAt) < 24 * 60 * MIN;
      const due = Object.values(next.registry).filter((r) => {
        const age = r.launchedAt ? (now - Date.parse(r.launchedAt)) : Infinity;
        const interval = r.pending ? MIN : age < 24 * 60 * MIN ? MIN : 15 * MIN;
        return now - r.sampledAt >= interval;
      }).sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || Number(!!young(b)) - Number(!!young(a)) || a.sampledAt - b.sampledAt || a.address.localeCompare(b.address));
      let markets = 0, sampled = 0;
      for (const item of due.slice(0, sampleBudget)) {
        const record = await read(recordKey(item.address));
        const meta = metas.get(item.address);
        if (!meta) {
          item.status = "unavailable";
          // Resolve elapsed missing windows as unknown, even when the token leaves the upstream catalog.
          if (record?.decisions?.length) {
            record.decisions = record.decisions.map((d) => d.outcome && d.outcome.status !== "pending" ? d : { ...d, outcome: evaluateDecision(d, record.observations, now) });
            record.setup = nextSetup(record.setup, { at: now, ready: false, reasons: ["token absent from the polled source pages"] });
            await write(recordKey(item.address), record);
            await write(callKey(item.address), record.decisions);
            item.decisionAt = record.decisions.at(-1)?.at; item.setupState = record.setup.state; item.pending = record.decisions.some((d) => d.outcome?.status === "pending");
          }
          item.sampledAt = now;
          continue;
        }
        let quote = null;
        const f = forensic.get(item.address);
        if (f?.observedAt && now - f.observedAt <= 10 * MIN && markets < marketBudget) {
          markets++;
          try { quote = await market(item.address); if (quote) quote = { ...quote, observedAt: clock() }; }
          catch { /* liquidity remains explicitly unavailable */ }
        }
        const o = observation(meta, { now: clock(), forensic: f, market: quote });
        const advanced = advanceRecord(record, o, meta.sym);
        await write(recordKey(item.address), advanced); // persist before exposing any new decision
        if (advanced.decisions.length) await write(callKey(item.address), advanced.decisions);
        item.sampledAt = o.observedAt; item.observationAt = o.observedAt; item.status = "observed";
        item.setupState = advanced.setup.state; item.decisionAt = advanced.decisions.at(-1)?.at;
        item.everEligible = !!(item.everEligible || advanced.everEligible);
        item.pending = advanced.decisions.some((d) => d.outcome?.status === "pending"); sampled++;
      }
      next.coverage.sampledThisCycle = sampled; next.coverage.dueRemaining = Math.max(0, due.length - sampleBudget);
      next.updated = clock();
      await write(EXPERIMENT_KEY, next);
      index = next; error = failures.length ? failures.join("; ") : null;
    } catch (e) { error = String(e.message || e).slice(0, 240); }
    finally { running = false; }
  }
  async function snapshot({ limit = 200, state = "", address = "", includeCalls = true } = {}) {
    try { await initialize(); } catch (e) { error = e.message; }
    const now = clock(), registry = Object.values(index?.registry || {});
    const display = r => r.status === "unavailable" || now - (r.observationAt || 0) > 5 * MIN ? "unavailable" : r.setupState || "observing";
    const order = { triggered: 0, building: 1, deteriorating: 2, invalidated: 3, expired: 4, observing: 5, unavailable: 6 };
    const matching = registry.filter(r => (!state || display(r) === state) && (!address || r.address === address))
      .sort((a,b) => (order[display(a)] ?? 9) - (order[display(b)] ?? 9) || b.sampledAt - a.sampledAt || a.address.localeCompare(b.address));
    const rows = [], calls = [];
    let snapshotError = error;
    try {
      // Filter and cap BEFORE reading records. Never load the entire observation history into a response.
      for (const item of matching.slice(0, Math.min(200, Math.max(0, limit)))) {
        const r = await read(recordKey(item.address));
        rows.push({ ...item, setup: r?.setup, features: r?.features, latest: r?.observations?.at(-1),
          transitions: r?.transitions, decisions: r?.decisions,
          stale: now - (item.observationAt || 0) > 5 * MIN, displayState: display(item) });
      }
      if (includeCalls) {
        // Separate small call values avoid rereading megabytes of observations per decision.
        for (const item of registry.filter(r => r.decisionAt != null)) {
          const ds = await read(callKey(item.address));
          if (!ds) throw new Error("published decision record unavailable");
          calls.push(...ds.map(d => ({ ...d, sym: item.sym })));
        }
      }
    } catch (e) { snapshotError = e.message; calls.length = 0; }
    calls.sort((a,b) => b.at - a.at);
    const eligibleTokens = registry.filter(r => r.everEligible).length;
    const coverage = { ...(index?.coverage || emptyIndex().coverage), eligibleTokens,
      eligibilityLowerBound: !!index?.eligibilityLowerBound,
      eligibilityDefinition: "Distinct tokens ever observed with features.ready; eligibility depends on sampling and forensic budgets." };
    return { schema: 1, enabled, running, error: snapshotError, startedAt: index?.startedAt ?? null, updated: index?.updated || 0,
      coverage, total: matching.length, rows, calls,
      strategies: summarize(calls).map(s => ({ ...s, eligibleTokens })),
      note: "Forward experiment. Budget-conditioned eligible universe. Indicative prices, not verified fills. Reflex is not connected." };
  }
  return { cycle, snapshot };
}
