// npm run migrate [-- --dry-run]: applies pending dated .sql files as ecotime_user (never an admin role).
import { loadConfig } from '../src/config/env.js';
import { createSequelize } from '../src/db/index.js';
import { migrate, pendingMigrations } from '../src/db/migrate.js';
const cfg = loadConfig(); const sequelize = createSequelize(cfg);
try {
  const before = await pendingMigrations(sequelize);
  console.log(`pending: ${before.length ? before.join(', ') : 'none'}`);
  if (!process.argv.includes('--dry-run')) {
    const applied = await migrate(sequelize, (m) => console.log(m));
    const [t] = await sequelize.query(`SELECT string_agg(tablename, ',' ORDER BY tablename) AS t FROM pg_tables WHERE schemaname = 'public'`);
    console.log(`applied: ${applied.length ? applied.join(', ') : 'none'}; tables: ${t[0].t}`);
  }
} finally { await sequelize.close(); }
