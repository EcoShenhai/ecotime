// Middleware: trust proxy (one hop), helmet, CORS allow-list, request id, the EcoTime time headers (§7.4), rate limit,
// routes. /metrics is answered only on the loopback interface and never proxied by nginx (§13.2).
import express from 'express';
import helmet from 'helmet';
import { requestId } from './middleware/requestId.js';
import { limiter } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { v1Router } from './routes/v1/index.js';
import { createEcoId } from './auth/ecoid.js';
import { createSessions } from './auth/sessions.js';
import { createApiCredentials } from './auth/apiCredentials.js';
import { createAudit } from './services/audit/index.js';
import { createAuthService } from './services/auth.js';
import { createScheduling } from './services/scheduling/index.js';
import { createWebhooks } from './services/scheduling/webhooks.js';
import { createClockHealth } from './services/clock-health/index.js';
import { createOrgs } from './services/orgs/index.js';
import { createSources } from './services/sources/index.js';
import { createSupport } from './support/supportService.js';
import { createMailer } from './support/mailer.js';
import { metricsText } from './jobs/metrics.js';

function cors(allowed) {
  const set = new Set(allowed);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && set.has(origin)) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id, Idempotency-Key',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'X-Request-Id, X-EcoTime-Server-Time, X-EcoTime-Clock-Status', 'Access-Control-Max-Age': '600' });
    if (req.method === 'OPTIONS') return res.status(origin && set.has(origin) ? 204 : 403).end();
    next();
  };
}

// container (§4.2): the only place that wires services to the database and clients
export function createServices({ cfg, sequelize, ecoid, mailer, auditSalt }) {
  const d = { cfg, sequelize };
  d.ecoid = ecoid || createEcoId(cfg.ecoid);
  d.audit = createAudit({ sequelize, salt: auditSalt || cfg.refreshPepper });
  d.sessions = createSessions({ sequelize, cfg });
  d.apiCredentials = createApiCredentials({ sequelize, cfg });
  d.mailer = mailer || createMailer(cfg);
  d.authService = createAuthService(d);
  d.scheduling = createScheduling(d);
  d.webhooks = createWebhooks(d);
  d.clock = createClockHealth(d);
  d.orgs = createOrgs(d);
  d.sources = createSources(d);
  d.support = createSupport(d);
  return d;
}

export function createApp(opts) {
  const d = createServices(opts);
  const { cfg, sequelize } = d;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-origin' }, referrerPolicy: { policy: 'no-referrer' } }));
  app.use(cors(cfg.corsOrigins), requestId);
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-EcoTime-Server-Time': new Date().toISOString(), 'X-EcoTime-Clock-Status': d.clock.current().status });
    next();
  });
  app.get('/metrics', async (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.get('x-forwarded-for');
    if (!local) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: req.id } });
    res.type('text/plain; version=0.0.4').send(await metricsText(d));
  });
  app.use(limiter(cfg.rateLimit.windowMs, cfg.rateLimit.max));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
  // readiness covers the database and the clock observation, reported separately (§9.1: a healthy API can sit on a wrong clock)
  app.get('/health/ready', async (req, res) => {
    let database = 'ok';
    try { await sequelize.query('SELECT 1'); } catch { database = 'down'; }
    const [hb] = database === 'ok' ? (await sequelize.query(`SELECT max(observed_at) AS at FROM clock_observations`))[0] : [{}];
    const clock = d.clock.current();
    res.status(database === 'ok' ? 200 : 503).json({ status: database === 'ok' ? 'ready' : 'unavailable', checks: { database, clock: clock.status, lastIngest: hb?.at || null, rulesets: d.clock.rulesets() } });
  });
  app.use('/api/v1', v1Router(d));
  app.use(notFoundHandler);
  app.use(errorHandler);
  app.locals.services = d;
  return app;
}
