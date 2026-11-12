// Clock-quality contract (§7.2). The vocabulary is closed: synchronized, degraded, unsynchronized, stale, unknown.
// "synchronized" needs a fresh observation that says so (T5); a missing or unreadable file is unknown, an old one stale.
import fs from 'node:fs';

export const STATES = ['synchronized', 'degraded', 'unsynchronized', 'stale', 'unknown'];

export function readState(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' && typeof s.collectedAt === 'string' ? s : null; } catch { return null; }
}

export function evaluate(state, cfg, now = Date.now()) {
  if (!state) return { status: 'unknown', reason: 'no observation', offsetMs: null, lastCheckedAt: null, observationAgeSeconds: null, daemon: null };
  const at = Date.parse(state.collectedAt);
  const age = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const base = { offsetMs: state.offsetUs != null ? +(state.offsetUs / 1000).toFixed(3) : null, rootDistanceMs: state.rootDistanceUs != null ? +(state.rootDistanceUs / 1000).toFixed(3) : null,
    jitterMs: state.jitterUs != null ? +(state.jitterUs / 1000).toFixed(3) : null, stratum: state.stratum ?? null, server: state.server ?? null, sources: state.server ? 1 : 0,
    lastCheckedAt: Number.isFinite(at) ? new Date(at).toISOString() : null, observationAgeSeconds: age, daemon: state.daemon || null, host: state.host || null };
  if (age == null) return { ...base, status: 'unknown', reason: 'unreadable observation time' };
  if (age > cfg.maxAgeS) return { ...base, status: 'stale', reason: `last observation ${age}s old (limit ${cfg.maxAgeS}s)` };
  if (state.error) return { ...base, status: 'unknown', reason: `collector could not read the daemon (${String(state.error).slice(0, 60)})` };
  if (state.ntpSynchronized === false) return { ...base, status: 'unsynchronized', reason: 'the daemon reports the clock is not synchronized' };
  if (state.ntpSynchronized !== true) return { ...base, status: 'unknown', reason: 'the daemon did not report a synchronization state' };
  const reasons = [];
  if (base.offsetMs == null) reasons.push('no offset reported');
  else if (Math.abs(base.offsetMs) > cfg.offsetWarnMs) reasons.push(`offset ${base.offsetMs} ms exceeds ${cfg.offsetWarnMs} ms`);
  if (base.rootDistanceMs != null && base.rootDistanceMs > cfg.rootDistanceWarnMs) reasons.push(`root distance ${base.rootDistanceMs} ms exceeds ${cfg.rootDistanceWarnMs} ms`);
  if (cfg.requireDiversity && base.sources < 2) reasons.push('only one upstream source in use');
  if (state.stepDetectedAt && now - Date.parse(state.stepDetectedAt) < 3600000) reasons.push('the clock was stepped within the last hour');
  return { ...base, status: reasons.length ? 'degraded' : 'synchronized', reason: reasons.join('; ') || null, diversity: base.sources < 2 ? 'single_source' : 'multiple' };
}
