// Ledger-based migration runner (§5.6): dated .sql files in scripts/migrations, applied in order, each in its own
// transaction, recorded in schema_migrations. A failure rolls back that file and stops. Never sync({ alter }).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/migrations');
const files = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{8}_[a-z0-9_]+\.sql$/.test(f) && !f.endsWith('.down.sql')).sort();

async function ensureLedger(sequelize) {
  await sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}
export async function pendingMigrations(sequelize) {
  const [t] = await sequelize.query(`SELECT to_regclass('public.schema_migrations') AS t`);
  if (!t[0].t) return files();
  const [rows] = await sequelize.query('SELECT filename FROM schema_migrations');
  const done = new Set(rows.map((r) => r.filename));
  return files().filter((f) => !done.has(f));
}
export async function migrate(sequelize, log = () => {}) {
  await ensureLedger(sequelize);
  const applied = [];
  for (const f of await pendingMigrations(sequelize)) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await sequelize.transaction(async (t) => {
      await sequelize.query(`SELECT pg_advisory_xact_lock(hashtext('ecotime_migrations'))`, { transaction: t });
      const [[seen]] = await sequelize.query('SELECT count(*)::int AS n FROM schema_migrations WHERE filename = :f', { replacements: { f }, transaction: t });
      if (seen.n) return;
      await sequelize.query(sql, { transaction: t });
      await sequelize.query('INSERT INTO schema_migrations (filename) VALUES (:f)', { replacements: { f }, transaction: t });
      applied.push(f); log(`applied ${f}`);
    });
  }
  return applied;
}
