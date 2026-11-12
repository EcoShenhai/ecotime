// Recurrence (T3): the intent is an RFC 5545 rule over local wall time ("every Monday at 09:00") in an IANA zone.
// Occurrences are generated as floating wall times, then each is resolved to UTC through the zone's rules and the
// schedule's DST policy. The UTC instant is derived, never the source of truth.
import rrulePkg from 'rrule';
import { resolveLocal, applyPolicy } from '../timezones/index.js';
import { invalidRecurrence } from '../../utils/errors.js';

const { RRule } = rrulePkg;
const ALLOWED = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYYEARDAY', 'BYWEEKNO', 'WKST']);
const FREQS = new Set(['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const pad = (n) => String(n).padStart(2, '0');
const floatingToLocal = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

export function parseRule(rule, { startDate, localTime, minIntervalMin = 5, horizonDays = 3650, now = Date.now() }) {
  if (typeof rule !== 'string' || rule.length > 500 || !/^[A-Z0-9=;,+\-]+$/.test(rule.replace(/^RRULE:/, ''))) throw invalidRecurrence('Use an RRULE such as FREQ=WEEKLY;BYDAY=MO');
  const body = rule.replace(/^RRULE:/, '');
  const parts = Object.fromEntries(body.split(';').filter(Boolean).map((p) => p.split('=')));
  for (const k of Object.keys(parts)) if (!ALLOWED.has(k)) throw invalidRecurrence(`${k} is not supported; the time of day comes from localTime and the zone from timeZone`);
  if (!FREQS.has(parts.FREQ)) throw invalidRecurrence('FREQ must be MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY');
  let opts;
  try { opts = RRule.parseString(body); } catch { throw invalidRecurrence('The rule could not be read'); }
  const [y, m, d] = startDate.split('-').map(Number); const [h, mi] = localTime.split(':').map(Number);
  const dtstart = new Date(Date.UTC(y, m - 1, d, h, mi));
  if (opts.until && opts.until.getTime() > now + horizonDays * 86400000) throw invalidRecurrence(`UNTIL may be at most ${horizonDays} days ahead`);
  if (dtstart.getTime() > now + horizonDays * 86400000) throw invalidRecurrence(`The start may be at most ${horizonDays} days ahead`);
  const r = new RRule({ ...opts, dtstart });
  // minimum interval: check the first occurrences after the start
  const first = r.all((_, i) => i < 30);
  if (!first.length) throw invalidRecurrence('The rule produces no occurrences');
  for (let i = 1; i < first.length; i++) if (first[i] - first[i - 1] < minIntervalMin * 60000) throw invalidRecurrence(`Occurrences must be at least ${minIntervalMin} minutes apart`);
  return r;
}

// First occurrence strictly after afterMs (UTC), resolved through the zone and policy; null when the rule has ended.
export function nextOccurrence(job, afterMs, opts = {}) {
  if (job.scheduleType === 'once') {
    const inst = applyPolicy(resolveLocal(`${job.startDateLocal}T${job.localTime}`, job.timeZone), { gap: job.dstGapPolicy, overlap: job.dstOverlapPolicy });
    return inst[0] !== undefined && inst[0] > afterMs ? inst[0] : null;
  }
  const r = parseRule(job.recurrenceRule, { startDate: job.startDateLocal, localTime: job.localTime, ...opts, horizonDays: 100000 });
  // start the floating search two days early: a zone's offset is at most ±14 h
  let cursor = new Date(afterMs - 2 * 86400000);
  for (let i = 0; i < 2000; i++) {
    const occ = r.after(cursor, false);
    if (!occ) return null;
    cursor = occ;
    const res = resolveLocal(floatingToLocal(occ), job.timeZone);
    for (const inst of applyPolicy(res, { gap: job.dstGapPolicy, overlap: job.dstOverlapPolicy })) if (inst > afterMs) return inst;
  }
  return null;
}

// Preview the next n occurrences with how each was resolved (§7.1 schedules/preview)
export function preview(job, n, fromMs = Date.now()) {
  const out = []; let after = fromMs - 1;
  if (job.scheduleType === 'once') {
    const res = resolveLocal(`${job.startDateLocal}T${job.localTime}`, job.timeZone);
    const inst = applyPolicy(res, { gap: job.dstGapPolicy, overlap: job.dstOverlapPolicy });
    return inst.length ? [{ instant: new Date(inst[0]).toISOString(), local: `${job.startDateLocal}T${job.localTime}`, resolution: res.resolution, past: inst[0] <= fromMs }] : [{ local: `${job.startDateLocal}T${job.localTime}`, resolution: res.resolution, skipped: true }];
  }
  const r = parseRule(job.recurrenceRule, { startDate: job.startDateLocal, localTime: job.localTime, horizonDays: 100000 });
  let cursor = new Date(after - 2 * 86400000);
  for (let i = 0; i < 4000 && out.length < n; i++) {
    const occ = r.after(cursor, false); if (!occ) break; cursor = occ;
    const local = floatingToLocal(occ);
    const res = resolveLocal(local, job.timeZone);
    const inst = applyPolicy(res, { gap: job.dstGapPolicy, overlap: job.dstOverlapPolicy });
    if (!inst.length) { if (occ.getTime() > fromMs - 86400000) out.push({ local, resolution: res.resolution, skipped: true }); continue; }
    if (inst[0] <= after) continue;
    out.push({ instant: new Date(inst[0]).toISOString(), local, resolution: res.resolution });
  }
  return out;
}
