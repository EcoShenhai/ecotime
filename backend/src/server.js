// ecotime-backend: the API process. Schedules are executed by the separate ecotime-scheduler process (§3.2).
import { loadConfig } from './config/env.js';
import { createSequelize } from './db/index.js';
import { pendingMigrations } from './db/migrate.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { osTzVersion, runtimeTzVersion } from './services/timezones/index.js';

const cfg = loadConfig();
const sequelize = createSequelize(cfg);
await sequelize.authenticate();
const pending = await pendingMigrations(sequelize);
if (pending.length) { logger.error('pending migrations; run npm run migrate first', { pending }); process.exit(1); }
const app = createApp({ cfg, sequelize });
const os = osTzVersion(cfg.clock.tzdataFile);
const server = app.listen(cfg.port, cfg.bindHost, () => logger.info('ecotime-backend listening', { host: cfg.bindHost, port: cfg.port, tzRuntime: runtimeTzVersion(), tzOs: os, tzAgree: os === runtimeTzVersion() }));
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (closing) return; closing = true;
  server.close(() => sequelize.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
});
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { err }));
