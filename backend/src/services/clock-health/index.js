// Clock health service (§9): live status from the collector's state file, plus downsampled observations and
// state-change events in PostgreSQL (written by the scheduler process, one writer).
import { readState, evaluate } from './evaluate.js';
import { osTzVersion, runtimeTzVersion } from '../timezones/index.js';

export function createClockHealth({ sequelize, cfg }) {
  const q = (sql, replacements = {}) => sequelize.query(sql, { replacements }).then(([rows]) => rows);
  let cache = { at: 0, value: null };
  function current(now = Date.now()) {
    if (now - cache.at > 2000) cache = { at: now, value: { state: readState(cfg.clock.stateFile) } };
    return evaluate(cache.value.state, cfg.clock, now);
  }
  function rulesets() {
    const runtime = runtimeTzVersion(); const os = osTzVersion(cfg.clock.tzdataFile);
    return { runtime, os, agree: os ? runtime === os : null };
  }
  async function ingest(now = Date.now()) {
    const state = readState(cfg.clock.stateFile); const h = evaluate(state, cfg.clock, now); const host = cfg.clock.hostLabel;
    const [last] = await q(`SELECT state, observed_at AS at, server_label AS server FROM clock_observations WHERE host_label = :h ORDER BY observed_at DESC LIMIT 1`, { h: host });
    const [lastEvent] = await q(`SELECT to_state AS state FROM clock_health_events WHERE host_label = :h AND kind = 'state_change' ORDER BY occurred_at DESC LIMIT 1`, { h: host });
    const prevState = lastEvent?.state || last?.state || null;
    const observedAt = state?.collectedAt && h.status !== 'stale' ? state.collectedAt : new Date(now).toISOString();
    const due = !last || last.state !== h.status || now - new Date(last.at).getTime() >= 5 * 60000;
    if (due) await q(`INSERT INTO clock_observations (host_label, observed_at, daemon, synchronized, state, offset_us, root_distance_us, jitter_us, stratum, server_label)
                      VALUES (:h, :at, :d, :sy, :st, :o, :rd, :j, :s, :srv) ON CONFLICT (host_label, observed_at) DO NOTHING`,
    { h: host, at: observedAt, d: state?.daemon || 'unknown', sy: state?.ntpSynchronized ?? null, st: h.status, o: state?.offsetUs ?? null, rd: state?.rootDistanceUs ?? null, j: state?.jitterUs ?? null, s: state?.stratum ?? null, srv: state?.server ?? null });
    const events = [];
    if (prevState !== h.status) events.push({ kind: 'state_change', from: prevState, to: h.status, detail: { reason: h.reason, offsetMs: h.offsetMs } });
    if (state?.stepDetectedAt) {
      const [seen] = await q(`SELECT 1 AS x FROM clock_health_events WHERE host_label = :h AND kind = 'clock_step' AND detail->>'stepDetectedAt' = :s`, { h: host, s: state.stepDetectedAt });
      if (!seen) events.push({ kind: 'clock_step', detail: { stepDetectedAt: state.stepDetectedAt, stepSizeS: state.stepSizeS ?? null } });
    }
    if (last?.server && state?.server && last.server !== state.server) events.push({ kind: 'source_change', detail: { from: last.server, to: state.server } });
    for (const e of events) await q(`INSERT INTO clock_health_events (host_label, kind, from_state, to_state, detail) VALUES (:h, :k, :f, :t, :d)`, { h: host, k: e.kind, f: e.from || null, t: e.to || null, d: JSON.stringify(e.detail || {}) });
    return { status: h.status, events: events.map((e) => e.kind) };
  }
  const events = (limit = 50) => q(`SELECT id, host_label AS host, kind, from_state AS "fromState", to_state AS "toState", occurred_at AS "occurredAt", detail FROM clock_health_events ORDER BY occurred_at DESC LIMIT :l`, { l: limit });
  const observations = (hours = 24) => q(`SELECT observed_at AS "observedAt", state, offset_us AS "offsetUs", root_distance_us AS "rootDistanceUs", stratum, server_label AS server FROM clock_observations
                                           WHERE host_label = :h AND observed_at > now() - make_interval(hours => :hr) ORDER BY observed_at`, { h: cfg.clock.hostLabel, hr: hours });
  return { current, rulesets, ingest, events, observations };
}
