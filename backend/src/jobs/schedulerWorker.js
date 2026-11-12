// ecotime-scheduler (§8.4, §3.2): the second PM2 process. Polls for due schedules, ingests the clock observation,
// checks the tz ruleset at start and daily, and purges by retention policy. Several workers may run side by side.
// The poll loop is only a trigger; the schedules themselves live in PostgreSQL (T7).
import { loadConfig } from '../config/env.js';
import { createSequelize } from '../db/index.js';
import { pendingMigrations } from '../db/migrate.js';
import { createWorker } from '../services/scheduling/worker.js';
import { createClockHealth } from '../services/clock-health/index.js';
import { createMailer } from '../support/mailer.js';
import { checkRuleset, purge } from './maintenance.js';
import { logger } from '../utils/logger.js';

const cfg = loadConfig();
const sequelize = createSequelize(cfg);
await sequelize.authenticate();
if ((await pendingMigrations(sequelize)).length) { logger.error('pending migrations; run npm run migrate first'); process.exit(1); }
const worker = createWorker({ sequelize, cfg, mailer: createMailer(cfg) });
const clock = createClockHealth({ sequelize, cfg });
await checkRuleset(sequelize, cfg, (m) => logger.info(m));
logger.info('ecotime-scheduler started', { worker: worker.id, pollMs: cfg.scheduler.pollMs, leaseMs: cfg.scheduler.leaseMs });

let stopping = false; let busy = false; let lastIngest = 0; let lastDaily = Date.now();
async function loop() {
  if (stopping || busy) return; busy = true;
  try {
    const r = await worker.tick();
    if (r.length) logger.info('schedules run', { results: r });
    if (Date.now() - lastIngest >= 30000) { lastIngest = Date.now(); const c = await clock.ingest(); if (c.events.length) logger.info('clock health', c); }
    if (Date.now() - lastDaily >= 24 * 3600 * 1000) { lastDaily = Date.now(); await checkRuleset(sequelize, cfg, (m) => logger.info(m)); logger.info('retention purge', await purge(sequelize)); }
  } catch (err) { logger.error('scheduler loop', { err }); } finally { busy = false; }
}
const timer = setInterval(loop, cfg.scheduler.pollMs); void loop();
setTimeout(() => purge(sequelize).then((n) => logger.info('retention purge', n)).catch(() => {}), 60000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  // stop claiming; any lease held runs out on its own and the work is picked up again (Appendix D)
  stopping = true; clearInterval(timer);
  const wait = setInterval(() => { if (!busy) { clearInterval(wait); sequelize.close().finally(() => process.exit(0)); } }, 100);
  setTimeout(() => process.exit(1), 15000).unref();
});
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { err }));
