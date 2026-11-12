// Source registry (§9.4): which upstream NTP sources are configured, who operates them, whether they are authenticated.
import { notFound } from '../../utils/errors.js';
export function createSources({ sequelize }) {
  const q = (sql, replacements = {}) => sequelize.query(sql, { replacements }).then(([rows]) => rows);
  const list = () => q(`SELECT id, host_label AS "hostLabel", operator, authenticated, tier, active, notes, updated_at AS "updatedAt" FROM time_sources ORDER BY active DESC, tier, host_label`);
  async function upsert(actor, b, audit, req) {
    const [r] = await q(`INSERT INTO time_sources (host_label, operator, authenticated, tier, active, notes) VALUES (:h, :o, :a, :t, :ac, :n)
                         ON CONFLICT (host_label) DO UPDATE SET operator = EXCLUDED.operator, authenticated = EXCLUDED.authenticated, tier = EXCLUDED.tier, active = EXCLUDED.active, notes = EXCLUDED.notes, updated_at = now() RETURNING id`,
    { h: b.hostLabel, o: b.operator, a: Boolean(b.authenticated), t: b.tier || 2, ac: b.active !== false, n: b.notes || null });
    await audit.log(actor, 'time_source.saved', { subjectKind: 'time_source', subjectId: r.id, detail: { hostLabel: b.hostLabel, active: b.active !== false }, req });
    return r;
  }
  async function remove(actor, id, audit, req) {
    const rows = await q(`UPDATE time_sources SET active = false, updated_at = now() WHERE id = :id RETURNING id`, { id });
    if (!rows.length) throw notFound('NOT_FOUND', 'Unknown source');
    await audit.log(actor, 'time_source.deactivated', { subjectKind: 'time_source', subjectId: id, req });
    return { id, active: false };
  }
  return { list, upsert, remove };
}
