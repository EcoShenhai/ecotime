// Time helpers for the console. The server is the reference; the device clock is measured against it, never trusted.
import { accessToken } from './session';
import { getLanguage } from '../i18n';
import { api } from './api';

export type ClockHealth = { status: 'synchronized' | 'degraded' | 'unsynchronized' | 'stale' | 'unknown'; reason?: string | null; offsetMs: number | null; rootDistanceMs?: number | null;
  jitterMs?: number | null; stratum?: number | null; server?: string | null; lastCheckedAt: string | null; observationAgeSeconds: number | null; daemon: string | null; diversity?: string; host?: string | null };
export type Skew = { skewMs: number; uncertaintyMs: number; serverStatus: string | null; health: ClockHealth; measuredAt: number };

// Device skew (§7.4): the server's time is taken at the midpoint of the round trip; the uncertainty is half the round trip.
export async function measureSkew(): Promise<Skew> {
  const tok = await accessToken();
  let best: Skew | null = null;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now(); const w0 = Date.now();
    const r = await fetch('/api/v1/time/now', { headers: tok ? { Authorization: `Bearer ${tok}` } : {}, cache: 'no-store' });
    const t1 = performance.now();
    if (!r.ok) throw new Error('time_unavailable');
    const j = await r.json(); const rtt = t1 - t0;
    const server = Date.parse(j.timestamp);
    const s: Skew = { skewMs: Math.round(server - (w0 + rtt / 2)), uncertaintyMs: Math.ceil(rtt / 2), serverStatus: r.headers.get('X-EcoTime-Clock-Status'), health: j.clockHealth, measuredAt: Date.now() };
    if (!best || s.uncertaintyMs < best.uncertaintyMs) best = s;
  }
  return best!;
}

export const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const loc = () => { try { return new Intl.Locale(getLanguage()).toString(); } catch { return 'en'; } };
export function fmtIn(ms: number | string, zone: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'long' }) {
  const d = new Date(ms); if (Number.isNaN(d.getTime())) return '—';
  try { return d.toLocaleString(loc(), { ...opts, timeZone: zone }); } catch { return d.toISOString(); }
}
export const fmtMs = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${new Intl.NumberFormat(loc(), { maximumFractionDigits: 3 }).format(n)} ms`);

// The zone list is fetched once per session.
let zones: Promise<{ id: string; currentOffset: string }[]> | null = null;
export function loadZones() {
  if (!zones) zones = api<{ zones: { id: string; currentOffset: string }[] }>('GET', '/time-zones').then((r) => r.zones).catch((e) => { zones = null; throw e; });
  return zones;
}
