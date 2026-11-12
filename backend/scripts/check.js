// Pre-start gate (§14): settings, database and role, migrations, reference data, administrator, clock observation,
// tz rules (runtime versus OS), app and route tree load. Prints PASS/WARN/FAIL lines, never values.
import { loadConfig } from '../src/config/env.js';
import { createSequelize } from '../src/db/index.js';
import { pendingMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { readState, evaluate } from '../src/services/clock-health/evaluate.js';
import { osTzVersion, runtimeTzVersion } from '../src/services/timezones/index.js';
let ok = true; const say = (good, m, warnOnly) => { console.log(`${good ? 'PASS' : warnOnly ? 'WARN' : 'FAIL'} ${m}`); if (!good && !warnOnly) ok = false; };
let cfg; try { cfg = loadConfig(); say(true, 'settings present and valid (backend/.env)'); } catch (e) { say(false, e.message); process.exit(1); }
say(!cfg.foreignDatabaseUrl, `DATABASE_URL: ${cfg.foreignDatabaseUrl ? 'present in this environment and ignored; EcoTime uses only its own settings' : 'not set'}`, true);
const sequelize = createSequelize(cfg);
try {
  await sequelize.authenticate();
  const [[r]] = await sequelize.query(`SELECT current_user AS u, current_database() AS d, split_part(version(), ' ', 2) AS v, current_setting('TimeZone') AS tz`);
  say(r.u === cfg.db.user && r.d === cfg.db.name, `database: connected as ${r.u} to ${r.d} (PostgreSQL ${r.v}, session time zone ${r.tz})`);
  const p = await pendingMigrations(sequelize); say(p.length === 0, `migrations: ${p.length ? 'pending ' + p.join(',') : 'up to date'}`);
  if (!p.length) {
    const [[c]] = await sequelize.query(`SELECT (SELECT count(*) FROM languages)::int AS l, (SELECT count(*) FROM territories)::int AS t, (SELECT count(*) FROM admins WHERE disabled_at IS NULL)::int AS a`);
    say(c.l === 72 && c.t === 205, `reference data: ${c.l} languages, ${c.t} territories`, true);
    say(c.a > 0, `administrator: ${c.a ? c.a + ' enrolled' : 'none yet (run scripts/admin.js create <email>)'}`, true);
  }
  const h = evaluate(readState(cfg.clock.stateFile), cfg.clock);
  say(h.status === 'synchronized', `clock: ${h.status}${h.reason ? ` (${h.reason})` : ''}${h.offsetMs != null ? `, offset ${h.offsetMs} ms` : ''}`, true);
  const os = osTzVersion(cfg.clock.tzdataFile); const rt = runtimeTzVersion();
  say(os === rt, `tz rules: Node runtime ${rt}, OS tzdata ${os || 'unknown'}${os && os !== rt ? ' (they differ; EcoTime reports this, finding F4)' : ''}`, true);
  const app = createApp({ cfg, sequelize });
  const routes = app._router.stack.find((l) => l.name === 'router')?.handle.stack.length || 0;
  say(routes > 30, `app and full route tree load (${routes} route entries)`);
} catch (e) { say(false, `database: ${e.original?.code || e.message}`); } finally { await sequelize.close(); }
process.exit(ok ? 0 : 1);
