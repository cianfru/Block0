import { evidenceAt, accountValidation, validationReport } from "./cohort-evidence.mjs";
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
export const archiveKey = address => `experiment:v1:archive:${address.slice(2,4)}`;
const INDEX_FIELDS = ["pool", "trackedAt", "trackUntil", "marketCheckedAt", "address", "sym", "firstSeenAt", "sampledAt", "status", "pending", "lastSeenAt", "launchedAt", "graduated", "setupState", "observationAt", "decisionAt", "everEligible"];
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
  const setup = nextSetup(r.setup?.version && r.setup.version !== SETUP_VERSION ? null : r.setup, features);
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
  board = () => [], market = async () => null, live = null, admissionCandidates = () => [], admissionRequiresForensics = false, balancedStages = false, clock = Date.now, enabled = true,
  maxTokens = 5000, sampleBudget = 80, marketBudget = 4, cohortSize = Math.min(12, sampleBudget), trackingMs = 6 * 60 * MIN, intervalMs = MIN } = {}) {
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
      const priorTracked = Object.values(next.registry).filter(r => r.pending || r.trackUntil > (next.updated || start));
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
      const boardRows = board();
      const forensic = new Map((Array.isArray(boardRows) ? boardRows : []).map(t => [addressOf(t.address), t]));
      const freshForensic = address => { const t = forensic.get(address)?.observedAt; return t && t <= now && now - t <= 10 * MIN; };
      let omitted = 0;
      for (const [a, m] of metas) {
        const address = addressOf(a); if (!address) continue;
        if (!next.registry[address] && Object.keys(next.registry).length >= maxTokens) { omitted++; continue; }
        const item = next.registry[address] ||= { address, firstSeenAt: now, sampledAt: 0, status: "discovered" };
        item.lastSeenAt = now; item.sym = String(m.sym || "?").slice(0, 80); item.graduated = !!m.graduated;
        item.launchedAt = m.launchedAt || null; item.pool = m.pool || item.pool;
      }
      // Reserve a stable cohort; page membership is discovery, not follow-up. Pending decisions
      // retain their slots through evaluation even if the six-hour admission lease expires.
      const inCohort = r => r.pending || r.trackUntil > now;
      const capacity = Math.min(cohortSize, sampleBudget);
      let slots = Math.max(0, capacity - Object.values(next.registry).filter(inCohort).length);
      // Cached board catalog metadata is usable for identity/admission only. Prices for these
      // candidates still require the explicit live refresh below.
      const admissions = new Map([...admissionCandidates(), ...metas.values()].map(m => [m.address, m]));
      const candidates = [...admissions.values()].filter(m => addressOf(m.address) &&
        (!admissionRequiresForensics || freshForensic(m.address)) &&
        !inCohort(next.registry[m.address] || {}) &&
        !(next.registry[m.address]?.trackedAt > now - 24 * 60 * MIN))
        .sort((a,b) => Number(!!freshForensic(b.address)) - Number(!!freshForensic(a.address)) ||
          Number(!!a.graduated) - Number(!!b.graduated) || a.address.localeCompare(b.address));
      for (const m of candidates) {
        if (!slots) break;
        if (balancedStages) {
          const stageCount = Object.values(next.registry).filter(r => inCohort(r) && !!r.graduated === !!m.graduated).length;
          const stageCapacity = m.graduated ? Math.floor(capacity / 2) : Math.ceil(capacity / 2);
          if (stageCount >= stageCapacity) continue;
        }
        if (!next.registry[m.address] && Object.keys(next.registry).length >= maxTokens) {
          // Retire only unprotected, absent discoveries. Keep record contents and an archival
          // address manifest, so making room never erases observations or hides a decision.
          const victim = Object.values(next.registry).filter(r => !inCohort(r) && !r.decisionAt && !r.everEligible && !metas.has(r.address))
            .sort((a,b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0) || a.address.localeCompare(b.address))[0];
          if (!victim) continue;
          const key = archiveKey(victim.address), archive = await read(key) || {};
          archive[victim.address] = { ...victim, retiredAt: now };
          await write(key, archive); // archive first; retries may leave a duplicate, never a lost address
          delete next.registry[victim.address]; next.retiredEntries = (next.retiredEntries || 0) + 1;
        }
        const item = next.registry[m.address] ||= { address: m.address, sym: String(m.sym || "?").slice(0,80),
          firstSeenAt: now, sampledAt: 0, status: "discovered", launchedAt: m.launchedAt, graduated: !!m.graduated, lastSeenAt: now };
        item.pool = m.pool || item.pool; item.trackedAt = now; item.trackUntil = now + trackingMs; slots--;
      }
      const tracked = Object.values(next.registry).filter(inCohort);
      let followupMissing = 0;
      if (live && tracked.length) {
        // Bounded batches keep URLs and request duration small. No stale catalog fallback for
        // a tracked token when its explicit refresh fails or omits it.
        for (let i = 0; i < tracked.length; i += 20) {
          const batch = tracked.slice(i, i + 20);
          const requested = batch.map(r => ({ ...r, ...(metas.get(r.address) || {}) }));
          for (const r of batch) metas.delete(r.address);
          try {
            const result = await live(requested);
            for (const m of result.items) if (batch.some(r => r.address === m.address)) metas.set(m.address, { ...m, availableAt: clock() });
          } catch (e) { failures.push("tracked markets: " + e.message); }
          followupMissing += batch.filter(r => !metas.has(r.address)).length;
        }
      }
      next.coverage = { complete: false, scope: emptyIndex().coverage.scope, collectorVersion: "cohort-evidence-v3",
        activeTotal: latest?.total ?? null, graduatedTotal: catalog?.total ?? null,
        activePagesThisCycle: latest ? [1, ...(latest.total > 100 ? [page] : [])] : [],
        registrySize: Object.keys(next.registry).length, registryCap: maxTokens, omittedThisCycle: omitted,
        retiredEntries: next.retiredEntries || 0, cohortSize: tracked.length, cohortCapacity: capacity,
        followupMissing, sourceFailures: failures,
        admissionPolicy: "Six-hour cohort, runtime requires fresh board forensics, runtime reserves half the slots per launch stage, address tie-break; no re-admission within 24 hours. Pending decisions retain slots.",
        note: "Discovery is partial. Retired unprotected registry entries remain archived. Missing quotes are never inferred dead." };
      await write(EXPERIMENT_KEY, next);
      index = structuredClone(next);
      const due = Object.values(next.registry).filter(r =>
        (metas.has(r.address) || r.pending) && (inCohort(r) ? now > r.sampledAt : now - r.sampledAt >= 15 * MIN))
        .sort((a,b) => Number(!!b.pending) - Number(!!a.pending) || Number(inCohort(b)) - Number(inCohort(a)) ||
          a.sampledAt - b.sampledAt || a.address.localeCompare(b.address));
      // A failed tracked quote is reported, but does not consume observation budget. Pending
      // outcomes still age through their deadlines independently of source availability.
      for (const r of tracked) if (!metas.has(r.address)) r.status = "unavailable";
      const observationWork = due.filter(r => metas.has(r.address)).slice(0, sampleBudget);
      const maintenance = due.filter(r => !metas.has(r.address) && r.pending);
      const marketOrder = observationWork.filter(r => metas.has(r.address) && freshForensic(r.address))
        .sort((a,b) => Number(inCohort(b)) - Number(inCohort(a)) || (a.marketCheckedAt || 0) - (b.marketCheckedAt || 0) || a.address.localeCompare(b.address))
        .slice(0, marketBudget);
      const marketTargets = new Set(marketOrder.map(r => r.address));
      let markets = 0, sampled = 0;
      const evidenceSamples = new Map();
      for (const item of [...maintenance, ...observationWork]) {
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
        let quote = record?.latestMarket || null;
        const f = forensic.get(item.address);
        if (marketTargets.has(item.address)) {
          markets++; item.marketCheckedAt = clock();
          try { quote = await market(item.address); if (quote) quote = { ...quote, observedAt: clock() }; }
          catch { /* The original quote timestamp is retained; observation() rejects stale values. */ }
        }
        const o = observation(meta, { now: clock(), forensic: f, market: quote });
        const advanced = advanceRecord(record, o, meta.sym);
        advanced.latestMarket = quote;
        item.graduated = o.graduated;
        await write(recordKey(item.address), advanced); // persist before exposing any new decision
        evidenceSamples.set(item.address, { observedAt: o.observedAt, evidence: evidenceAt(o, advanced.features, o.observedAt), reasons: advanced.features.reasons, state: advanced.setup.state });
        if (advanced.decisions.length) await write(callKey(item.address), advanced.decisions);
        item.sampledAt = o.observedAt; item.observationAt = o.observedAt; item.status = "observed";
        item.setupState = advanced.setup.state; item.decisionAt = advanced.decisions.at(-1)?.at;
        item.everEligible = !!(item.everEligible || advanced.everEligible);
        item.pending = advanced.decisions.some((d) => d.outcome?.status === "pending"); sampled++;
      }
      const cohortSamples = tracked.map(r => evidenceSamples.get(r.address));
      next.coverage.evidence = { tracked: tracked.length, freshPrices: cohortSamples.filter(s => s?.evidence.price).length,
        freshForensics: cohortSamples.filter(s => s?.evidence.forensics).length,
        usableLiquidity: cohortSamples.filter(s => s?.evidence.liquidity).length,
        sufficientHistory: cohortSamples.filter(s => s?.evidence.history).length,
        assessmentReady: cohortSamples.filter(s => s?.evidence.ready).length,
        conditionsMet: cohortSamples.filter(s => s?.state === "triggered").length,
        preGraduation: tracked.filter(r => !r.graduated).length, postGraduation: tracked.filter(r => r.graduated).length,
        missing: tracked.map(r => ({ address: r.address, reasons: evidenceSamples.get(r.address)?.reasons || ["no fresh observation recorded this cycle"] })) };
      const validationMembers = [...new Map([...priorTracked, ...tracked].map(r => [r.address, r])).values()];
      next.validation = accountValidation(next.validation, validationMembers, evidenceSamples, clock(), intervalMs);
      next.coverage.trackedObservedThisCycle = tracked.filter(r => r.observationAt >= start).length;
      next.coverage.availableThisCycle = Object.values(next.registry).filter(r => metas.has(r.address)).length;
      next.coverage.sampledThisCycle = sampled; next.coverage.dueRemaining = Math.max(0, due.filter(r => metas.has(r.address)).length - observationWork.length);
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
      coverage, validation: validationReport(index?.validation, now), total: matching.length, rows, calls,
      strategies: summarize(calls).map(s => ({ ...s, eligibleTokens })),
      note: "Forward experiment. Budget-conditioned eligible universe. Indicative prices, not verified fills. Reflex is not connected." };
  }
  const trackedMetadata = () => Object.values(index?.registry || {}).filter(r => r.pending || r.trackUntil > clock()).map(r => ({ ...r }));
  return { cycle, snapshot, trackedMetadata };
}
