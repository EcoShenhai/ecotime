// Prometheus text exposition (§9.6), computed at scrape time from the live observation and the database.
const line = (name, help, type, samples) => [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples.map(([labels, v]) => `${name}${labels} ${v}`)].join('\n');
const lbl = (o) => `{${Object.entries(o).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '')}"`).join(',')}}`;
export async function metricsText(d) {
  const h = d.clock.current(); const tz = d.clock.rulesets(); const host = d.cfg.clock.hostLabel;
  const q = (sql) => d.sequelize.query(sql).then(([r]) => r[0] || {});
  const steps = await q(`SELECT count(*)::int AS n FROM clock_health_events WHERE kind = 'clock_step'`);
  const sched = await q(`SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, coalesce(avg(lateness_ms) FILTER (WHERE started_at > now() - interval '1 hour'), 0) AS late,
                                (SELECT count(*)::int FROM (SELECT job_id, scheduled_for FROM schedule_executions GROUP BY 1, 2 HAVING count(*) > 1) x) AS dup FROM schedule_executions`);
  const out = [
    line('clock_synchronized', "Daemon's own view, from a fresh observation", 'gauge', [[lbl({ host }), h.status === 'synchronized' || h.status === 'degraded' ? 1 : 0]]),
    line('clock_state', 'Declared clock state (1 for the current state)', 'gauge', ['synchronized', 'degraded', 'unsynchronized', 'stale', 'unknown'].map((s) => [lbl({ host, state: s }), h.status === s ? 1 : 0])),
    line('clock_observation_age_seconds', 'Age of the last observation', 'gauge', [[lbl({ host }), h.observationAgeSeconds ?? -1]]),
    line('clock_step_total', 'Clock steps detected by the collector', 'counter', [[lbl({ host }), steps.n || 0]]),
    line('tz_ruleset_info', 'Deployed tz rules', 'gauge', [[lbl({ os: tz.os || 'unknown', runtime: tz.runtime, agree: String(tz.agree) }), 1]]),
    line('schedule_failures_total', 'Occurrences that failed after all retries', 'counter', [['', sched.failed || 0]]),
    line('schedule_lateness_seconds', 'Average lateness over the last hour', 'gauge', [['', (Number(sched.late) / 1000).toFixed(3)]]),
    line('schedule_duplicate_executions_total', 'Occurrences executed more than once (must stay 0)', 'counter', [['', sched.dup || 0]]),
  ];
  if (h.offsetMs != null) out.push(line('clock_offset_seconds', 'Estimated offset from the selected reference', 'gauge', [[lbl({ host }), (h.offsetMs / 1000).toFixed(6)]]));
  if (h.rootDistanceMs != null) out.push(line('clock_root_distance_seconds', 'Quality of the estimate', 'gauge', [[lbl({ host }), (h.rootDistanceMs / 1000).toFixed(6)]]));
  return out.join('\n') + '\n';
}
