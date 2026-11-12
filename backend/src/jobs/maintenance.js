// Time-zone ruleset governance (§8.5) and retention (§6.4). Run by the scheduler process at start and daily.
import { nextOccurrence } from '../services/scheduling/recurrence.js';
import { osTzVersion, runtimeTzVersion } from '../services/timezones/index.js';

export async function checkRuleset(sequelize, cfg, log = () => {}) {
  const q = (sql, r = {}) => sequelize.query(sql, { replacements: r }).then(([rows]) => rows);
  const runtime = runtimeTzVersion(); const os = osTzVersion(cfg.clock.tzdataFile);
  const [prev] = await q(`SELECT runtime_version AS v FROM time_zone_rulesets ORDER BY deployed_at DESC LIMIT 1`);
  const inserted = await q(`INSERT INTO time_zone_rulesets (runtime_version, os_version) VALUES (:r, :o) ON CONFLICT (runtime_version, os_version) DO NOTHING RETURNING id`, { r: runtime, o: os });
  let recomputed = 0;
  if (inserted.length && prev && prev.v !== runtime) {
    // the zone rules changed: recompute every future instant from the stored intent (T3, §8.3)
    const jobs = await q(`SELECT id, schedule_type AS "scheduleType", time_zone AS "timeZone", to_char(start_date_local, 'YYYY-MM-DD') AS "startDateLocal", local_time AS "localTime",
                                 recurrence_rule AS "recurrenceRule", dst_gap_policy AS "dstGapPolicy", dst_overlap_policy AS "dstOverlapPolicy", next_run_at AS "nextRunAt"
                            FROM scheduled_jobs WHERE status = 'active' AND schedule_type = 'recurring'`);
    for (const j of jobs) {
      const next = nextOccurrence(j, Date.now());
      if (next && new Date(j.nextRunAt).getTime() !== next) { await q(`UPDATE scheduled_jobs SET next_run_at = :n, ruleset_version = :r, version = version + 1 WHERE id = :id`, { n: new Date(next), r: runtime, id: j.id }); recomputed++; }
    }
    await q(`UPDATE time_zone_rulesets SET recomputed_schedules = :n WHERE id = :id`, { n: recomputed, id: inserted[0].id });
  }
  if (inserted.length && os && os !== runtime) {
    await q(`INSERT INTO clock_health_events (host_label, kind, detail) VALUES (:h, 'ruleset_mismatch', :d)`, { h: cfg.clock.hostLabel, d: JSON.stringify({ runtime, os }) });
  }
  log(`tz rules: runtime ${runtime}, os ${os || 'unknown'}${os && os !== runtime ? ' (MISMATCH recorded)' : ''}${recomputed ? `, ${recomputed} schedules recomputed` : ''}`);
  return { runtime, os, recomputed, newRuleset: inserted.length > 0 };
}

export async function purge(sequelize) {
  const [policies] = await sequelize.query(`SELECT table_name AS t, keep_days AS d FROM retention_policies WHERE action = 'delete' AND keep_days IS NOT NULL`);
  const col = { clock_observations: 'observed_at', clock_health_events: 'occurred_at', schedule_executions: 'started_at', idempotency_keys: 'first_seen_at', auth_sessions: 'COALESCE(revoked_at, expires_at)' };
  const out = {};
  for (const p of policies) {
    if (!col[p.t]) continue;
    const [, meta] = await sequelize.query(`DELETE FROM ${p.t} WHERE ${col[p.t]} < now() - make_interval(days => :d)`, { replacements: { d: p.d } });
    out[p.t] = meta?.rowCount ?? 0;
  }
  return out;
}
