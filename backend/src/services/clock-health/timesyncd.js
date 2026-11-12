// Provider adapter for systemd-timesyncd (§9.5). Pure parsing of what `timedatectl` prints; no dependencies, so the
// unprivileged collector can use it without node_modules. Units are normalised to microseconds and seconds.
const UNIT = { ns: 0.001, us: 1, 'µs': 1, ms: 1000, s: 1e6, min: 60e6, h: 3600e6 };

// "-1.589ms" → -1589 ; "23.338ms" → 23338 ; "1us" → 1
export function durationUs(text) {
  const m = /^([+-]?\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|min|h)$/.exec(String(text || '').trim());
  return m ? Math.round(Number(m[1]) * UNIT[m[2]]) : null;
}
// "34min 8s (min: 32s; max 34min 8s)" → 2048
export function pollSeconds(text) {
  const main = String(text || '').split('(')[0].trim(); let total = 0; let any = false;
  for (const m of main.matchAll(/(\d+(?:\.\d+)?)\s*(h|min|s|ms)\b/g)) { any = true; total += Number(m[1]) * { h: 3600, min: 60, s: 1, ms: 0.001 }[m[2]]; }
  return any ? Math.round(total) : null;
}

export function parseTimesyncStatus(text) {
  const kv = {};
  for (const line of String(text || '').split('\n')) { const i = line.indexOf(':'); if (i > 0) kv[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  const server = kv.server || null; const name = server && /\(([^)]+)\)/.exec(server)?.[1];
  return {
    server: server ? (name || server.split(' ')[0]) : null,
    serverAddressKnown: Boolean(server),
    stratum: kv.stratum ? Number(kv.stratum) : null,
    offsetUs: durationUs(kv.offset), rootDistanceUs: durationUs((kv['root distance'] || '').split('(')[0]),
    delayUs: durationUs(kv.delay), jitterUs: durationUs(kv.jitter), pollIntervalS: pollSeconds(kv['poll interval']),
    leap: kv.leap || null, packetCount: kv['packet count'] ? Number(kv['packet count']) : null,
    frequencyPpm: kv.frequency ? Number(String(kv.frequency).replace(/ppm$/, '')) : null,
  };
}
export function parseShow(text) {
  const kv = Object.fromEntries(String(text || '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { ntpSynchronized: kv.NTPSynchronized === 'yes' ? true : kv.NTPSynchronized === 'no' ? false : null, ntpEnabled: kv.NTP === 'yes', timezone: kv.Timezone || null };
}
