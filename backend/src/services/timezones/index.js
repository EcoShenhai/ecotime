// Time-zone service (§7.3, §8.3, §8.5). IANA identifiers only (T2); offsets are always calculated from maintained
// rules, never hard-coded. Every answer names the ruleset version used. All conversion in EcoTime goes through here.
import fs from 'node:fs';
import { DateTime, IANAZone } from 'luxon';
import { invalidTimeZone, badRequest } from '../../utils/errors.js';

const ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC']);
export const runtimeTzVersion = () => process.versions.tz || 'unknown';
export function osTzVersion(file = '/usr/share/zoneinfo/tzdata.zi') {
  try { const head = fs.readFileSync(file, 'utf8').slice(0, 200); return /#\s*version\s+(\S+)/.exec(head)?.[1] || null; } catch { return null; }
}
// IANA names only: "Area/Location" (aliases such as Asia/Kolkata included) or UTC. Fixed offsets like "+03:00", which the
// runtime would otherwise accept, are refused (T2).
const IANA_SHAPE = /^(UTC|[A-Z][A-Za-z_\-]+(\/[A-Za-z0-9_+\-]+){1,2})$/;
export function assertZone(zone) {
  if (typeof zone !== 'string' || zone.length > 80 || !IANA_SHAPE.test(zone) || !IANAZone.isValidZone(zone)) throw invalidTimeZone(zone);
  return zone;
}
const offsetMin = (zone, ms) => IANAZone.create(zone).offset(ms);
export const fmtOffset = (m) => `${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;

// Wall time in a zone → the instants it names: one (unique), none (nonexistent, spring forward) or two (ambiguous, fall back).
export function resolveLocal(local, zone) {
  assertZone(zone);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local || '');
  if (!m) throw badRequest('INVALID_INPUT', 'localDateTime must look like 2027-03-14T02:30 or 2027-03-14T02:30:00');
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  const back = new Date(naive);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) throw badRequest('INVALID_INPUT', 'That date does not exist');
  const offsets = [...new Set([offsetMin(zone, naive - 86400000), offsetMin(zone, naive), offsetMin(zone, naive + 86400000)])];
  const valid = offsets.map((o) => naive - o * 60000).filter((inst) => naive - offsetMin(zone, inst) * 60000 === inst).sort((a, b) => a - b);
  const uniq = [...new Set(valid)];
  if (uniq.length === 1) return { resolution: 'unique', instants: uniq };
  if (uniq.length >= 2) return { resolution: 'ambiguous', instants: uniq.slice(0, 2) };
  // nonexistent: the clock jumped over this wall time. shift_forward uses the offset in force before the gap,
  // which lands the same distance past the gap as the wall time was into it.
  const before = offsetMin(zone, naive - 86400000);
  return { resolution: 'nonexistent', instants: [], shiftForward: naive - before * 60000 };
}

// Apply a schedule's DST policy (§8.3) to a resolution; [] means "do not run this occurrence".
export function applyPolicy(r, { gap = 'shift_forward', overlap = 'first' } = {}) {
  if (r.resolution === 'unique') return r.instants;
  if (r.resolution === 'ambiguous') return [overlap === 'second' ? r.instants[1] : r.instants[0]];
  return gap === 'skip' ? [] : [r.shiftForward];
}

export function instantInZone(instantMs, zone) {
  assertZone(zone);
  const dt = DateTime.fromMillis(instantMs, { zone });
  const off = offsetMin(zone, instantMs);
  return { instant: new Date(instantMs).toISOString(), timeZone: zone, localDateTime: dt.toFormat("yyyy-MM-dd'T'HH:mm:ss"), utcOffset: fmtOffset(off),
    abbreviation: dt.offsetNameShort, isDst: dt.isInDST };
}

// The next transitions of a zone within a year (where its offset changes)
export function transitions(zone, fromMs = Date.now(), days = 400) {
  assertZone(zone);
  const out = []; let prev = offsetMin(zone, fromMs);
  for (let t = fromMs + 3600000; t < fromMs + days * 86400000; t += 3600000) {
    const o = offsetMin(zone, t);
    if (o !== prev) { // narrow to the minute
      let lo = t - 3600000, hi = t;
      while (hi - lo > 60000) { const mid = lo + Math.floor((hi - lo) / 120000) * 60000; if (offsetMin(zone, mid) === prev) lo = mid; else hi = mid; }
      out.push({ at: new Date(hi).toISOString(), fromOffset: fmtOffset(prev), toOffset: fmtOffset(o) }); prev = o;
      if (out.length >= 4) break;
    }
  }
  return out;
}

export function zoneInfo(zone, now = Date.now()) {
  assertZone(zone);
  const o = offsetMin(zone, now);
  return { id: zone, currentOffset: fmtOffset(o), abbreviation: DateTime.fromMillis(now, { zone }).offsetNameShort, observesDst: transitions(zone, now, 370).length > 0,
    nextTransitions: transitions(zone, now, 400), rulesetVersion: runtimeTzVersion() };
}
export const zoneList = () => [...ZONES].filter((z) => z !== 'Etc/UTC').sort();
